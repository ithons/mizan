import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { expandCategoryIds, listTransactions, type TransactionListFilters } from '../server/src/services/transactions';

// Minimal schema for the query logic extracted out of routes/transactions.ts. Amounts
// are integer cents (the DB contract); listTransactions returns cents, callers dollarize.
function setupDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE accounts (id TEXT PRIMARY KEY, account_name TEXT, institution_name TEXT);
    CREATE TABLE categories (id TEXT PRIMARY KEY, name TEXT, color TEXT, icon TEXT, parent_id TEXT);
    CREATE TABLE transactions (
      manually_categorized INTEGER NOT NULL DEFAULT 0,
      id TEXT PRIMARY KEY, account_id TEXT, date TEXT, amount INTEGER,
      merchant_name TEXT, original_name TEXT, category_id TEXT, notes TEXT,
      pending INTEGER DEFAULT 0, recurring_id TEXT, review_status TEXT DEFAULT 'open',
      created_at TEXT, updated_at TEXT
    );
  `);
  db.prepare('INSERT INTO accounts VALUES (?,?,?)').run('acc_a', 'Checking', 'Bank A');
  db.prepare('INSERT INTO accounts VALUES (?,?,?)').run('acc_b', 'Savings', 'Bank B');
  db.prepare('INSERT INTO categories VALUES (?,?,?,?,?)').run('cat_food', 'Food', '#f00', '🍔', null);
  db.prepare('INSERT INTO categories VALUES (?,?,?,?,?)').run('cat_dining', 'Dining', '#f80', '🍽', 'cat_food');
  db.prepare('INSERT INTO categories VALUES (?,?,?,?,?)').run('cat_income', 'Income', '#0f0', '💰', null);

  const ins = db.prepare(`INSERT INTO transactions
    (id, account_id, date, amount, merchant_name, original_name, category_id, notes, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  // amounts in cents
  ins.run('t1', 'acc_a', '2026-07-01', -1500, 'Chipotle', 'CHIPOTLE', 'cat_dining', null, '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z');
  ins.run('t2', 'acc_a', '2026-07-02', -4200, 'Whole Foods', 'WHOLEFOODS', 'cat_food', null, '2026-07-02T00:00:00Z', '2026-07-02T00:00:00Z');
  ins.run('t3', 'acc_b', '2026-07-03', 500000, 'Employer', 'PAYROLL', 'cat_income', 'paycheck', '2026-07-03T00:00:00Z', '2026-07-03T00:00:00Z');
  ins.run('t4', 'acc_b', '2026-07-04', -999, 'Kiosk', 'KIOSK', null, null, '2026-07-04T00:00:00Z', '2026-07-04T00:00:00Z');
  return db;
}

const base: Omit<TransactionListFilters, never> = {
  page: 1, limit: 50, sortBy: 'date', sortDir: 'desc', accountIds: [], categoryIds: [],
};

test('expandCategoryIds includes a category and all its descendants', () => {
  const db = setupDb();
  assert.deepEqual(expandCategoryIds(db, ['cat_food']).sort(), ['cat_dining', 'cat_food']);
  assert.deepEqual(expandCategoryIds(db, ['cat_dining']), ['cat_dining']);
});

test('lists all transactions with a total, newest first by default', () => {
  const db = setupDb();
  const { rows, total } = listTransactions(db, { ...base });
  assert.equal(total, 4);
  assert.deepEqual(rows.map((r) => r.id), ['t4', 't3', 't2', 't1']);
  // returns cents, not dollars
  assert.equal(rows.find((r) => r.id === 't2')!.amount, -4200);
});

test('paginates with the total reflecting the full match count', () => {
  const db = setupDb();
  const { rows, total } = listTransactions(db, { ...base, limit: 2, page: 2 });
  assert.equal(total, 4);
  assert.deepEqual(rows.map((r) => r.id), ['t2', 't1']);
});

test('sorts by amount ascending', () => {
  const db = setupDb();
  const { rows } = listTransactions(db, { ...base, sortBy: 'amount', sortDir: 'asc' });
  assert.deepEqual(rows.map((r) => r.id), ['t2', 't1', 't4', 't3']);
});

test('filters by type income and expense on amount sign', () => {
  const db = setupDb();
  assert.deepEqual(listTransactions(db, { ...base, type: 'income' }).rows.map((r) => r.id), ['t3']);
  assert.deepEqual(listTransactions(db, { ...base, type: 'expense' }).rows.map((r) => r.id), ['t4', 't2', 't1']);
});

test('filters uncategorized', () => {
  const db = setupDb();
  assert.deepEqual(listTransactions(db, { ...base, uncategorized: true }).rows.map((r) => r.id), ['t4']);
});

test('filters by account', () => {
  const db = setupDb();
  assert.deepEqual(listTransactions(db, { ...base, accountIds: ['acc_b'] }).rows.map((r) => r.id), ['t4', 't3']);
});

test('filtering a parent category also matches its children', () => {
  const db = setupDb();
  // cat_food should match t2 (Food) AND t1 (Dining, a child of Food)
  assert.deepEqual(listTransactions(db, { ...base, categoryIds: ['cat_food'] }).rows.map((r) => r.id), ['t2', 't1']);
});

test('filters by dollar amount range (converted to cents)', () => {
  const db = setupDb();
  // minAmount/maxAmount are dollars; -42.00 <= amount <= -10.00 matches t1 (-15) and t2 (-42)
  // but not t4 (-9.99, just above the ceiling).
  const { rows } = listTransactions(db, { ...base, minAmount: -42, maxAmount: -10 });
  assert.deepEqual(rows.map((r) => r.id).sort(), ['t1', 't2']);
});

test('search matches merchant, original name, or notes', () => {
  const db = setupDb();
  assert.deepEqual(listTransactions(db, { ...base, search: 'paycheck' }).rows.map((r) => r.id), ['t3']);
  assert.deepEqual(listTransactions(db, { ...base, search: 'CHIPOTLE' }).rows.map((r) => r.id), ['t1']);
});
