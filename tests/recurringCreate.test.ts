import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { addDays, format } from 'date-fns';
import { createRecurringPattern } from '../server/src/services/recurring';
import { buildRecurringForecast } from '../server/src/services/recurringForecast';

function setupDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT,
      is_income INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE recurring_patterns (
      id TEXT PRIMARY KEY,
      merchant_name TEXT NOT NULL,
      category_id TEXT,
      average_amount REAL NOT NULL,
      frequency TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      next_expected TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      is_confirmed INTEGER NOT NULL DEFAULT 0,
      transaction_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(merchant_name)
    );
    CREATE TABLE transactions (id TEXT PRIMARY KEY, recurring_id TEXT, amount REAL NOT NULL);
    CREATE TABLE recurring_occurrence_adjustments (
      id TEXT PRIMARY KEY,
      recurring_id TEXT NOT NULL,
      original_date TEXT NOT NULL,
      action TEXT NOT NULL,
      adjusted_date TEXT,
      adjusted_amount REAL,
      note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(recurring_id, original_date)
    );
  `);
  db.prepare(`INSERT INTO categories (id, name, color, is_income) VALUES
    ('cat_income', 'Income', '#4ecba3', 1),
    ('cat_bills', 'Bills', '#e07070', 0)`).run();
  return db;
}

test('createRecurringPattern inserts a confirmed pattern with an unsigned amount', () => {
  const db = setupDb();
  const next = format(addDays(new Date(), 5), 'yyyy-MM-dd');
  const id = createRecurringPattern(db, {
    merchant_name: 'Rent',
    frequency: 'monthly',
    average_amount: -1800, // sign should be stripped
    next_expected: next,
    category_id: 'cat_bills',
  });

  const row = db.prepare('SELECT * FROM recurring_patterns WHERE id = ?').get(id) as any;
  assert.equal(row.merchant_name, 'Rent');
  assert.equal(row.average_amount, 1800);
  assert.equal(row.is_confirmed, 1);
  assert.equal(row.is_active, 1);
  assert.equal(row.transaction_count, 0);
  assert.equal(row.next_expected, next);
  assert.equal(row.last_seen, next);
});

test('a manually created pattern appears in the forecast with the right sign', () => {
  const db = setupDb();
  const next = format(addDays(new Date(), 5), 'yyyy-MM-dd');
  createRecurringPattern(db, {
    merchant_name: 'Paycheck',
    frequency: 'monthly',
    average_amount: 4000,
    next_expected: next,
    category_id: 'cat_income',
  });

  const forecast = buildRecurringForecast(db, 30);
  const paycheck = forecast.occurrences.find((o) => o.merchant_name === 'Paycheck');
  assert.ok(paycheck, 'manual pattern should surface in the forecast');
  assert.equal(paycheck!.is_income, true);
  assert.ok(paycheck!.amount > 0, 'income occurrence amount should be positive');
});

test('createRecurringPattern rejects a duplicate name with 409', () => {
  const db = setupDb();
  const next = format(addDays(new Date(), 5), 'yyyy-MM-dd');
  const input = { merchant_name: 'Spotify', frequency: 'monthly' as const, average_amount: 12, next_expected: next };
  createRecurringPattern(db, input);
  assert.throws(() => createRecurringPattern(db, input), (err: any) => err.status === 409);
});

test('createRecurringPattern rejects an unknown category with 400', () => {
  const db = setupDb();
  const next = format(addDays(new Date(), 5), 'yyyy-MM-dd');
  assert.throws(
    () => createRecurringPattern(db, { merchant_name: 'Gym', frequency: 'monthly', average_amount: 40, next_expected: next, category_id: 'nope' }),
    (err: any) => err.status === 400,
  );
});
