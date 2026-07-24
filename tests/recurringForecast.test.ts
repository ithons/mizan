import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { addDays, format, subDays } from 'date-fns';
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
      amount_variance REAL NOT NULL DEFAULT 0,
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

function insertAdjustment(
  db: Database.Database,
  params: {
    id: string;
    recurringId: string;
    originalDate: string;
    action: 'skip' | 'snooze' | 'adjust';
    adjustedDate?: string | null;
    adjustedAmount?: number | null;
  }
): void {
  db.prepare(`
    INSERT INTO recurring_occurrence_adjustments (
      id, recurring_id, original_date, action, adjusted_date, adjusted_amount, note, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
  `).run(
    params.id,
    params.recurringId,
    params.originalDate,
    params.action,
    params.adjustedDate ?? null,
    params.adjustedAmount ?? null,
    new Date().toISOString(),
    new Date().toISOString()
  );
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

test('recurring forecast applies skip, snooze, and amount adjustments', (t) => {
  const db = setupRecurringDb();
  t.after(() => db.close());

  const today = format(new Date(), 'yyyy-MM-dd');
  const tomorrow = format(addDays(new Date(), 1), 'yyyy-MM-dd');
  insertAdjustment(db, {
    id: 'adj_rent_skip',
    recurringId: 'rent',
    originalDate: today,
    action: 'skip',
  });
  insertAdjustment(db, {
    id: 'adj_paycheck_snooze',
    recurringId: 'paycheck',
    originalDate: today,
    action: 'snooze',
    adjustedDate: tomorrow,
  });
  insertAdjustment(db, {
    id: 'adj_streaming_amount',
    recurringId: 'streaming',
    originalDate: today,
    action: 'adjust',
    adjustedAmount: -25,
  });

  const forecast = buildRecurringForecast(db, 2);
  const rent = forecast.occurrences.find((occurrence) => occurrence.pattern_id === 'rent');
  const paycheck = forecast.occurrences.find((occurrence) => occurrence.pattern_id === 'paycheck');
  const streaming = forecast.occurrences.find((occurrence) => occurrence.pattern_id === 'streaming');

  // Skipped occurrences stay in the payload (so the UI can offer undo) but are
  // excluded from every total below.
  assert.equal(rent?.adjustment_action, 'skip');
  assert.equal(rent?.needs_review, false);
  assert.equal(paycheck?.expected_date, tomorrow);
  assert.equal(paycheck?.original_expected_date, today);
  assert.equal(paycheck?.adjustment_action, 'snooze');
  assert.equal(streaming?.amount, -25);
  assert.equal(streaming?.adjustment_action, 'adjust');
  assert.equal(forecast.income, 2000);
  assert.equal(forecast.bills, 25);
  assert.equal(forecast.net, 1975);
});
