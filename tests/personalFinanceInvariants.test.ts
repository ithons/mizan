import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { getPersonalFinanceInvariantIssues } from '../server/src/services/personalFinanceInvariants';

function setupInvariantDb(): Database.Database {
  const db = new Database(':memory:');

  db.exec(`
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      account_name TEXT NOT NULL,
      is_hidden INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE net_worth_snapshots (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      breakdown TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE transactions (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      pending INTEGER NOT NULL DEFAULT 0
    );
  `);

  return db;
}

test('personal finance invariants detect hidden accounts in latest net worth snapshot', (t) => {
  const db = setupInvariantDb();
  t.after(() => db.close());

  db.prepare('INSERT INTO accounts (id, account_name, is_hidden) VALUES (?, ?, ?)').run(
    'acct_hidden',
    'Old Savings',
    1
  );
  db.prepare('INSERT INTO accounts (id, account_name, is_hidden) VALUES (?, ?, ?)').run(
    'acct_visible',
    'Checking',
    0
  );
  db.prepare(`
    INSERT INTO net_worth_snapshots (id, date, breakdown, created_at)
    VALUES (?, ?, ?, ?)
  `).run(
    'snap_1',
    '2026-06-30',
    JSON.stringify({ acct_hidden: 100, acct_visible: 500 }),
    '2026-06-30T12:00:00.000Z'
  );

  const issues = getPersonalFinanceInvariantIssues(db, new Date('2026-06-30T12:00:00.000Z'));

  assert.equal(issues.length, 1);
  assert.equal(issues[0].id, 'hidden-account-net-worth');
  assert.equal(issues[0].severity, 'critical');
  assert.match(issues[0].message, /Old Savings/);
});

test('personal finance invariants flag old pending transactions', (t) => {
  const db = setupInvariantDb();
  t.after(() => db.close());

  db.prepare(`
    INSERT INTO net_worth_snapshots (id, date, breakdown, created_at)
    VALUES ('snap_1', '2026-06-30', '{}', '2026-06-30T12:00:00.000Z')
  `).run();
  db.prepare('INSERT INTO transactions (id, date, pending) VALUES (?, ?, ?)').run(
    'pending_old',
    '2026-06-20',
    1
  );
  db.prepare('INSERT INTO transactions (id, date, pending) VALUES (?, ?, ?)').run(
    'pending_fresh',
    '2026-06-28',
    1
  );

  const issues = getPersonalFinanceInvariantIssues(db, new Date('2026-06-30T12:00:00.000Z'));

  assert.equal(issues.length, 1);
  assert.equal(issues[0].id, 'stale-pending-transactions');
  assert.equal(issues[0].route, '/transactions?pending=true');
  assert.match(issues[0].message, /older than 7 days/);
});
