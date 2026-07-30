import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { getAnomalyInsights } from '../server/src/services/anomalyInsights';

function setupDb(): Database.Database {
  const db = new Database(':memory:');

  db.exec(`
    CREATE TABLE categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      parent_id TEXT,
      is_income INTEGER NOT NULL DEFAULT 0,
      is_investment INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE transactions (
      manually_categorized INTEGER NOT NULL DEFAULT 0,
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      amount REAL NOT NULL,
      category_id TEXT,
      pending INTEGER NOT NULL DEFAULT 0,
      transfer_status TEXT NOT NULL DEFAULT 'none'
    );

    INSERT INTO categories (id, name, parent_id, is_income, is_investment)
    VALUES
      ('cat_food', 'Food', NULL, 0, 0),
      ('cat_income_paycheck', 'Paycheck', NULL, 1, 0),
      ('cat_xfer', 'Transfers', NULL, 0, 0),
      ('cat_xfer_child', 'Internal Transfer', 'cat_xfer', 0, 0);
  `);

  return db;
}

function insertTransaction(
  db: Database.Database,
  id: string,
  date: string,
  amount: number,
  categoryId: string,
  transferStatus = 'none'
): void {
  db.prepare(`
    INSERT INTO transactions (id, date, amount, category_id, transfer_status)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, date, amount, categoryId, transferStatus);
}

test('anomaly insights flag category spending spikes and income gaps', (t) => {
  const db = setupDb();
  t.after(() => db.close());

  insertTransaction(db, 'food_previous', '2026-05-20', -10000, 'cat_food');
  insertTransaction(db, 'food_current', '2026-06-20', -65000, 'cat_food');
  insertTransaction(db, 'paycheck_previous', '2026-05-25', 300000, 'cat_income_paycheck');
  insertTransaction(db, 'paycheck_current', '2026-06-25', 100000, 'cat_income_paycheck');

  const insights = getAnomalyInsights(db, new Date('2026-06-30T12:00:00.000Z'));

  const spendingSpike = insights.find((insight) => insight.id === 'spending-category-spike');
  const incomeGap = insights.find((insight) => insight.id === 'income-gap');
  assert.equal(spendingSpike?.severity, 'warning');
  assert.match(spendingSpike?.message ?? '', /Food spending is up 550%/);
  assert.equal(incomeGap?.severity, 'warning');
  assert.match(incomeGap?.message ?? '', /Income in the last 30 days is \$1,000/);
});

test('anomaly insights exclude transfer categories from spending spikes', (t) => {
  const db = setupDb();
  t.after(() => db.close());

  insertTransaction(db, 'transfer_previous', '2026-05-20', -50, 'cat_xfer_child');
  insertTransaction(db, 'transfer_current', '2026-06-20', -2500, 'cat_xfer_child');
  insertTransaction(db, 'food_current', '2026-06-20', -80, 'cat_food');

  const insights = getAnomalyInsights(db, new Date('2026-06-30T12:00:00.000Z'));

  assert.equal(insights.find((insight) => insight.id === 'spending-category-spike'), undefined);
});
