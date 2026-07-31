import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migratedTestDb, insertAccount } from './helpers/schema';
import { expandCategoryIds, listTransactions, type TransactionListFilters } from '../server/src/services/transactions';

// The query logic extracted out of routes/transactions.ts. Amounts are integer cents (the DB
// contract); listTransactions returns cents, callers dollarize. `cat_food_restaurants` is a real
// child of `cat_food` in the seeded taxonomy, so the parent-expansion test walks the tree
// production has rather than one this file invented.
function setupDb(): Database.Database {
  const db = migratedTestDb();
  insertAccount(db, { id: 'acc_a', account_name: 'Checking', institution_name: 'Bank A' });
  insertAccount(db, { id: 'acc_b', account_name: 'Savings', institution_name: 'Bank B', type: 'savings' });

  const ins = db.prepare(`INSERT INTO transactions
    (id, account_id, date, amount, merchant_name, original_name, category_id, notes, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  // amounts in cents
  ins.run('t1', 'acc_a', '2026-07-01', -1500, 'Chipotle', 'CHIPOTLE', 'cat_food_restaurants', null, '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z');
  ins.run('t2', 'acc_a', '2026-07-02', -4200, 'Whole Foods', 'WHOLEFOODS', 'cat_food', null, '2026-07-02T00:00:00Z', '2026-07-02T00:00:00Z');
  ins.run('t3', 'acc_b', '2026-07-03', 500000, 'Employer', 'PAYROLL', 'cat_income_paycheck', 'paycheck', '2026-07-03T00:00:00Z', '2026-07-03T00:00:00Z');
  ins.run('t4', 'acc_b', '2026-07-04', -999, 'Kiosk', 'KIOSK', null, null, '2026-07-04T00:00:00Z', '2026-07-04T00:00:00Z');
  return db;
}

const base: Omit<TransactionListFilters, never> = {
  page: 1, limit: 50, sortBy: 'date', sortDir: 'desc', accountIds: [], categoryIds: [],
};

test('expandCategoryIds includes a category and all its descendants', () => {
  const db = setupDb();
  assert.deepEqual(
    expandCategoryIds(db, ['cat_food']).sort(),
    ['cat_food', 'cat_food_alcohol', 'cat_food_bars', 'cat_food_coffee', 'cat_food_delivery',
     'cat_food_groceries', 'cat_food_restaurants']
  );
  assert.deepEqual(expandCategoryIds(db, ['cat_food_restaurants']), ['cat_food_restaurants']);
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
