import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { addDays, format, subDays } from 'date-fns';
import { buildSubscriptionInsights } from '../server/src/services/subscriptionInsights';

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
      transaction_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE transactions (
      id TEXT PRIMARY KEY,
      recurring_id TEXT,
      date TEXT NOT NULL,
      amount REAL NOT NULL,
      pending INTEGER NOT NULL DEFAULT 0
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
      ('income', 'Income', '#4ecba3', 1),
      ('bills', 'Bills', '#e07070', 0)
  `).run();

  const today = format(new Date(), 'yyyy-MM-dd');
  const inTwentyDays = format(addDays(new Date(), 20), 'yyyy-MM-dd');
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
    category_id: 'income',
    average_amount: 250000,
    frequency: 'monthly',
    last_seen: today,
    next_expected: today,
    is_active: 1,
    is_confirmed: 1,
    transaction_count: 4,
  });
  insertPattern.run({
    id: 'rent',
    merchant_name: 'Rent',
    category_id: 'bills',
    average_amount: 100000,
    frequency: 'monthly',
    last_seen: today,
    next_expected: today,
    is_active: 1,
    is_confirmed: 1,
    transaction_count: 4,
  });
  insertPattern.run({
    id: 'streaming',
    merchant_name: 'Streaming',
    category_id: 'bills',
    average_amount: 1500,
    frequency: 'monthly',
    last_seen: today,
    next_expected: today,
    is_active: 1,
    is_confirmed: 1,
    transaction_count: 4,
  });
  insertPattern.run({
    id: 'cloud',
    merchant_name: 'Cloud Storage',
    category_id: 'bills',
    average_amount: 12000,
    frequency: 'annual',
    last_seen: today,
    next_expected: inTwentyDays,
    is_active: 1,
    is_confirmed: 1,
    transaction_count: 3,
  });
  insertPattern.run({
    id: 'coffee',
    merchant_name: 'Coffee Club',
    category_id: 'bills',
    average_amount: 1000,
    frequency: 'weekly',
    last_seen: today,
    next_expected: today,
    is_active: 1,
    is_confirmed: 1,
    transaction_count: 5,
  });
  insertPattern.run({
    id: 'trial',
    merchant_name: 'App Trial',
    category_id: 'bills',
    average_amount: 800,
    frequency: 'monthly',
    last_seen: today,
    next_expected: today,
    is_active: 1,
    is_confirmed: 0,
    transaction_count: 3,
  });
  insertPattern.run({
    id: 'weak',
    merchant_name: 'Weak Pattern',
    category_id: 'bills',
    average_amount: 4000,
    frequency: 'monthly',
    last_seen: today,
    next_expected: today,
    is_active: 1,
    is_confirmed: 0,
    transaction_count: 2,
  });

  const insertTransaction = db.prepare(`
    INSERT INTO transactions (id, recurring_id, date, amount, pending)
    VALUES (?, ?, ?, ?, 0)
  `);
  insertTransaction.run('streaming_1', 'streaming', format(subDays(new Date(), 90), 'yyyy-MM-dd'), -1500);
  insertTransaction.run('streaming_2', 'streaming', format(subDays(new Date(), 60), 'yyyy-MM-dd'), -1500);
  insertTransaction.run('streaming_3', 'streaming', format(subDays(new Date(), 30), 'yyyy-MM-dd'), -1900);

  return db;
}

function closeTo(actual: number, expected: number) {
  assert.ok(Math.abs(actual - expected) < 0.01, `${actual} should be close to ${expected}`);
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
  const now = new Date().toISOString();
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
    now,
    now
  );
}

test('subscription insights summarize recurring bills without income or weak patterns', (t) => {
  const db = setupDb();
  t.after(() => db.close());

  const insights = buildSubscriptionInsights(db, 30);

  assert.equal(insights.subscription_count, 5);
  assert.equal(insights.unconfirmed_count, 1);
  assert.equal(insights.increase_count, 1);
  assert.equal(insights.increases[0].merchant_name, 'Streaming');
  closeTo(insights.increases[0].increase_amount ?? 0, 400);
  closeTo(insights.increases[0].increase_percent ?? 0, 4 / 15);
  assert.equal(insights.subscriptions.some((item) => item.merchant_name === 'MIT Payroll'), false);
  assert.equal(insights.subscriptions.some((item) => item.merchant_name === 'Weak Pattern'), false);
  assert.equal(insights.unconfirmed[0].merchant_name, 'App Trial');
  assert.ok(insights.upcoming.some((item) => item.merchant_name === 'Cloud Storage'));
  closeTo(insights.total_monthly_amount, 100000 + (4900 / 3) + 1000 + (1000 * 52 / 12) + 800);
  assert.ok(insights.total_upcoming_amount > insights.total_monthly_amount);
});

test('subscription insights apply recurring occurrence adjustments', (t) => {
  const db = setupDb();
  t.after(() => db.close());

  const today = format(new Date(), 'yyyy-MM-dd');
  insertAdjustment(db, {
    id: 'adj_rent_skip',
    recurringId: 'rent',
    originalDate: today,
    action: 'skip',
  });
  insertAdjustment(db, {
    id: 'adj_streaming_amount',
    recurringId: 'streaming',
    originalDate: today,
    action: 'adjust',
    adjustedAmount: -25,
  });

  const insights = buildSubscriptionInsights(db, 1);
  const rent = insights.subscriptions.find((item) => item.pattern_id === 'rent');
  const streaming = insights.subscriptions.find((item) => item.pattern_id === 'streaming');

  assert.equal(rent?.upcoming_amount, 0);
  assert.equal(insights.upcoming.some((item) => item.pattern_id === 'rent'), false);
  assert.equal(streaming?.upcoming_amount, 25);
});
