import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migratedTestDb, insertAccount } from './helpers/schema';
import { getAnomalyInsights } from '../server/src/services/anomalyInsights';

// The real taxonomy is what production classifies against, so the category names the insight
// copy prints are the seeded ones ("Food & Drink", not "Food"). The hand-written schema this
// replaced also declared `amount REAL`, where production has been INTEGER cents since 022.
function setupDb(): Database.Database {
  const db = migratedTestDb();
  insertAccount(db, { id: 'acct' });
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
    INSERT INTO transactions
      (id, account_id, date, amount, category_id, transfer_status, created_at, updated_at)
    VALUES (?, 'acct', ?, ?, ?, ?, ?, ?)
  `).run(id, date, amount, categoryId, transferStatus, `${date}T00:00:00.000Z`, `${date}T00:00:00.000Z`);
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
  assert.match(spendingSpike?.message ?? '', /Food & Drink spending is up 550%/);
  assert.equal(incomeGap?.severity, 'warning');
  assert.match(incomeGap?.message ?? '', /Income in the last 30 days is \$1,000/);
});

test('anomaly insights exclude transfer categories from spending spikes', (t) => {
  const db = setupDb();
  t.after(() => db.close());

  insertTransaction(db, 'transfer_previous', '2026-05-20', -50, 'cat_xfer_in');
  insertTransaction(db, 'transfer_current', '2026-06-20', -2500, 'cat_xfer_in');
  insertTransaction(db, 'food_current', '2026-06-20', -80, 'cat_food');

  const insights = getAnomalyInsights(db, new Date('2026-06-30T12:00:00.000Z'));

  assert.equal(insights.find((insight) => insight.id === 'spending-category-spike'), undefined);
});
