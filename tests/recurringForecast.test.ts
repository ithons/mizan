import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { format, subDays } from 'date-fns';
import { buildRecurringForecast } from '../server/src/services/recurringForecast';

function setupRecurringDb(): Database.Database {
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
      transaction_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE transactions (
      id TEXT PRIMARY KEY,
      recurring_id TEXT,
      amount REAL NOT NULL
    );
  `);

  db.prepare(`
    INSERT INTO categories (id, name, color, is_income)
    VALUES
      ('cat_income', 'Income', '#4ecba3', 1),
      ('cat_bills', 'Bills', '#e07070', 0)
  `).run();

  const today = format(new Date(), 'yyyy-MM-dd');
  const insertPattern = db.prepare(`
    INSERT INTO recurring_patterns (
      id,
      merchant_name,
      category_id,
      average_amount,
      frequency,
      last_seen,
      next_expected,
      is_active,
      is_confirmed,
      transaction_count
    )
    VALUES (@id, @merchant_name, @category_id, @average_amount, @frequency, @last_seen, @next_expected, @is_active, @is_confirmed, @transaction_count)
  `);

  insertPattern.run({
    id: 'paycheck',
    merchant_name: 'MIT Payroll',
    category_id: 'cat_income',
    average_amount: 2000,
    frequency: 'monthly',
    last_seen: today,
    next_expected: today,
    is_active: 1,
    is_confirmed: 1,
    transaction_count: 3,
  });
  insertPattern.run({
    id: 'rent',
    merchant_name: 'Rent',
    category_id: 'cat_bills',
    average_amount: 1000,
    frequency: 'monthly',
    last_seen: today,
    next_expected: today,
    is_active: 1,
    is_confirmed: 1,
    transaction_count: 3,
  });
  insertPattern.run({
    id: 'streaming',
    merchant_name: 'Streaming',
    category_id: 'cat_bills',
    average_amount: 20,
    frequency: 'monthly',
    last_seen: today,
    next_expected: today,
    is_active: 1,
    is_confirmed: 1,
    transaction_count: 3,
  });
  insertPattern.run({
    id: 'unconfirmed',
    merchant_name: 'Not Ready',
    category_id: 'cat_bills',
    average_amount: 500,
    frequency: 'monthly',
    last_seen: today,
    next_expected: today,
    is_active: 1,
    is_confirmed: 0,
    transaction_count: 2,
  });

  db.prepare(`
    INSERT INTO transactions (id, recurring_id, amount)
    VALUES
      ('streaming_1', 'streaming', -12),
      ('streaming_2', 'streaming', -16)
  `).run();

  return db;
}

test('recurring forecast uses signed amounts and ignores weak patterns', (t) => {
  const db = setupRecurringDb();
  t.after(() => db.close());

  const forecast = buildRecurringForecast(db, 1);

  assert.equal(forecast.income, 2000);
  assert.equal(forecast.bills, 1014);
  assert.equal(forecast.net, 986);
  assert.deepEqual(
    forecast.occurrences.map((occurrence) => [occurrence.pattern_id, occurrence.amount]),
    [
      ['paycheck', 2000],
      ['rent', -1000],
      ['streaming', -14],
    ]
  );
  assert.equal(forecast.confirmed_income, 2000);
  assert.equal(forecast.confirmed_bills, 1014);
  assert.equal(forecast.review_count, 0);
});

test('recurring forecast keeps one overdue occurrence visible for review', (t) => {
  const db = setupRecurringDb();
  t.after(() => db.close());

  const overdueDate = format(subDays(new Date(), 5), 'yyyy-MM-dd');
  db.prepare(`
    INSERT INTO recurring_patterns (
      id,
      merchant_name,
      category_id,
      average_amount,
      frequency,
      last_seen,
      next_expected,
      is_active,
      is_confirmed,
      transaction_count
    )
    VALUES ('overdue_bill', 'Overdue Bill', 'cat_bills', 100, 'monthly', ?, ?, 1, 0, 3)
  `).run(overdueDate, overdueDate);

  const forecast = buildRecurringForecast(db, 1);
  const overdue = forecast.occurrences.find((occurrence) => occurrence.pattern_id === 'overdue_bill');

  assert.equal(forecast.overdue_count, 1);
  assert.equal(forecast.review_count, 1);
  assert.equal(forecast.likely_bills, 100);
  assert.equal(overdue?.status, 'overdue');
  assert.equal(overdue?.needs_review, true);
  assert.equal(overdue?.confidence_label, 'likely');
  assert.ok((overdue?.days_until ?? 0) <= -5);
});
