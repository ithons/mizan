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
      is_hidden INTEGER NOT NULL DEFAULT 0,
      type TEXT NOT NULL DEFAULT 'checking',
      current_balance INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE net_worth_snapshots (
      is_estimated INTEGER NOT NULL DEFAULT 0,
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      breakdown TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE transactions (
      manually_categorized INTEGER NOT NULL DEFAULT 0,
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      pending INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE holdings (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      security_id TEXT NOT NULL DEFAULT 'sec'
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
  // Transactions reads `uncategorized` and `range`, never `pending`, so the old route promised a
  // filter that never applied. `range=all` is honoured and guarantees a 7-day-old row is visible.
  assert.equal(issues[0].route, '/transactions?range=all');
  assert.match(issues[0].message, /older than 7 days/);
});

test('personal finance invariants flag holdings whose account was deleted', (t) => {
  const db = setupInvariantDb();
  t.after(() => db.close());

  db.prepare("INSERT INTO accounts (id, account_name) VALUES ('acct_live', 'Brokerage')").run();
  db.prepare("INSERT INTO holdings (id, account_id) VALUES ('h_ok', 'acct_live')").run();
  db.prepare("INSERT INTO holdings (id, account_id) VALUES ('h_orphan', 'acct_gone')").run();

  const issues = getPersonalFinanceInvariantIssues(db, new Date('2026-06-30T12:00:00.000Z'));
  const orphan = issues.find((i) => i.id === 'orphan-holdings');
  assert.ok(orphan, 'expected an orphan-holdings issue');
  assert.equal(orphan?.severity, 'critical');
});

test('personal finance invariants flag a closed account with a non-zero balance', (t) => {
  const db = setupInvariantDb();
  t.after(() => db.close());

  db.prepare("INSERT INTO accounts (id, account_name, type, current_balance) VALUES ('c_ok', 'BofA Checking', 'closed', 0)").run();
  db.prepare("INSERT INTO accounts (id, account_name, type, current_balance) VALUES ('c_bad', 'Chase Savings', 'closed', 4200)").run();

  const issues = getPersonalFinanceInvariantIssues(db, new Date('2026-06-30T12:00:00.000Z'));
  const closed = issues.find((i) => i.id === 'closed-account-nonzero');
  assert.ok(closed, 'expected a closed-account-nonzero issue');
  assert.match(closed!.message, /Chase Savings/);
  assert.doesNotMatch(closed!.message, /BofA Checking/);
});
