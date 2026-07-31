import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migratedTestDb, insertAccount, insertTransaction } from './helpers/schema';
import { getPersonalFinanceInvariantIssues } from '../server/src/services/personalFinanceInvariants';

function setupInvariantDb(): Database.Database {
  const db = migratedTestDb();
  insertAccount(db, { id: 'acct_txn', account_name: 'Ledger Home' });
  db.prepare("INSERT INTO securities (id, name, type) VALUES ('sec', 'Placeholder', 'other')").run();
  return db;
}

function insertSnapshot(db: Database.Database, id: string, date: string, breakdown: string): void {
  db.prepare(`
    INSERT INTO net_worth_snapshots
      (id, date, total_assets, total_liabilities, net_worth, breakdown, created_at)
    VALUES (?, ?, 0, 0, 0, ?, ?)
  `).run(id, date, breakdown, `${date}T12:00:00.000Z`);
}

function insertHolding(db: Database.Database, id: string, accountId: string): void {
  db.prepare(`
    INSERT INTO holdings
      (id, account_id, security_id, quantity, institution_price, institution_value, updated_at)
    VALUES (?, ?, 'sec', 1, 1, 100, '2026-06-30T12:00:00.000Z')
  `).run(id, accountId);
}

test('personal finance invariants detect hidden accounts in latest net worth snapshot', (t) => {
  const db = setupInvariantDb();
  t.after(() => db.close());

  insertAccount(db, { id: 'acct_hidden', account_name: 'Old Savings', is_hidden: 1 });
  insertAccount(db, { id: 'acct_visible', account_name: 'Checking' });
  insertSnapshot(db, 'snap_1', '2026-06-30', JSON.stringify({ acct_hidden: 100, acct_visible: 500 }));

  const issues = getPersonalFinanceInvariantIssues(db, new Date('2026-06-30T12:00:00.000Z'));

  assert.equal(issues.length, 1);
  assert.equal(issues[0].id, 'hidden-account-net-worth');
  assert.equal(issues[0].severity, 'critical');
  assert.match(issues[0].message, /Old Savings/);
});

test('personal finance invariants flag old pending transactions', (t) => {
  const db = setupInvariantDb();
  t.after(() => db.close());

  insertSnapshot(db, 'snap_1', '2026-06-30', '{}');
  insertTransaction(db, { id: 'pending_old', account_id: 'acct_txn', date: '2026-06-20', pending: 1 });
  insertTransaction(db, { id: 'pending_fresh', account_id: 'acct_txn', date: '2026-06-28', pending: 1 });

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

  insertAccount(db, { id: 'acct_live', account_name: 'Brokerage', type: 'brokerage' });
  insertHolding(db, 'h_ok', 'acct_live');

  // The real schema declares holdings.account_id REFERENCES accounts(id), so an orphan cannot be
  // created through an ordinary insert. It still happens: `runMigrationsOn` turns enforcement off
  // for the duration of a migration, which is exactly the window this detector exists to cover,
  // so the orphan is made the same way production makes one.
  db.pragma('foreign_keys = OFF');
  insertHolding(db, 'h_orphan', 'acct_gone');
  db.pragma('foreign_keys = ON');

  const issues = getPersonalFinanceInvariantIssues(db, new Date('2026-06-30T12:00:00.000Z'));
  const orphan = issues.find((i) => i.id === 'orphan-holdings');
  assert.ok(orphan, 'expected an orphan-holdings issue');
  assert.equal(orphan?.severity, 'critical');
});

test('personal finance invariants flag a closed account with a non-zero balance', (t) => {
  const db = setupInvariantDb();
  t.after(() => db.close());

  insertAccount(db, { id: 'c_ok', account_name: 'BofA Checking', type: 'closed', current_balance: 0 });
  insertAccount(db, { id: 'c_bad', account_name: 'Chase Savings', type: 'closed', current_balance: 4200 });

  const issues = getPersonalFinanceInvariantIssues(db, new Date('2026-06-30T12:00:00.000Z'));
  const closed = issues.find((i) => i.id === 'closed-account-nonzero');
  assert.ok(closed, 'expected a closed-account-nonzero issue');
  assert.match(closed!.message, /Chase Savings/);
  assert.doesNotMatch(closed!.message, /BofA Checking/);
});
