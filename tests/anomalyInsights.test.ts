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

const NOW = new Date('2026-06-30T12:00:00.000Z');

/**
 * `months` of steady spending in one category, one charge per 30-day window, oldest first.
 *
 * The windows the detector reads are 30 days wide and contiguous back from `NOW - 29d`, so a
 * charge placed 30 days apart lands one per window, which is what a habit looks like.
 */
function steadySpend(db: Database.Database, category: string, amountsCents: number[]): void {
  amountsCents.forEach((cents, i) => {
    // i = 0 is the current window, i = 1 the one before it, and so on.
    const day = new Date(NOW.getTime() - (i * 30 + 10) * 86400000).toISOString().slice(0, 10);
    insertTransaction(db, `${category}_${i}`, day, -cents, category);
  });
}

test('a category that beats its own worst month by 2x is a spike', (t) => {
  const db = setupDb();
  t.after(() => db.close());

  // Six months of a real habit between $400 and $520, then $2,000.
  steadySpend(db, 'cat_food', [200000, 45000, 52000, 40000, 48000, 44000, 50000]);
  insertTransaction(db, 'paycheck_previous', '2026-05-25', 300000, 'cat_income_paycheck');
  insertTransaction(db, 'paycheck_current', '2026-06-25', 100000, 'cat_income_paycheck');

  const insights = getAnomalyInsights(db, NOW);

  const spendingSpike = insights.find((insight) => insight.id === 'spending-category-spike');
  const incomeGap = insights.find((insight) => insight.id === 'income-gap');
  assert.equal(spendingSpike?.severity, 'warning');
  // Measured against the worst of the six prior windows ($520), not against last month.
  assert.match(spendingSpike?.message ?? '', /Food & Drink spending is \$2,000 in the last 30 days/);
  assert.match(spendingSpike?.message ?? '', /up 285% on its usual \$520 over the last 6 months/);
  assert.equal(incomeGap?.severity, 'warning');
  assert.match(incomeGap?.message ?? '', /Income in the last 30 days is \$1,000/);
});

/**
 * The silence cases. The old rule fired on 303 of 365 days of the owner's real ledger and its test
 * file proved detection twice and silence never, which is precisely how a warning that is on 83% of
 * the year survived four verification rounds.
 */
test('HEALTHY: an ordinary lumpy category says nothing', (t) => {
  const db = setupDb();
  t.after(() => db.close());

  // Real month-to-month variance: the biggest month is more than double the smallest, and the
  // current month is the second-highest. Ordinary. The old rule fired on this shape constantly.
  steadySpend(db, 'cat_food', [72000, 38000, 81000, 41000, 65000, 35000, 58000]);

  assert.deepEqual(
    getAnomalyInsights(db, NOW).filter((i) => i.id === 'spending-category-spike'),
    []
  );
});

test('HEALTHY: a fixed monthly bill straddling the window boundary says nothing', (t) => {
  const db = setupDb();
  t.after(() => db.close());

  // The same charge every 30 days. Nothing has changed and nothing may be reported.
  steadySpend(db, 'cat_home', [95000, 95000, 95000, 95000, 95000, 95000, 95000]);

  assert.deepEqual(
    getAnomalyInsights(db, NOW).filter((i) => i.id === 'spending-category-spike'),
    []
  );
});

test('HEALTHY: an empty ledger says nothing at all', (t) => {
  const db = setupDb();
  t.after(() => db.close());
  assert.deepEqual(getAnomalyInsights(db, NOW), []);
});

test('a category with no habit to depart from is not a spike, however large', (t) => {
  const db = setupDb();
  t.after(() => db.close());

  // $2,000 this month against $12 once, seven months ago. The old rule called this "up 16567%".
  // There is no baseline here, so there is no reading, and a new category is not an anomaly.
  steadySpend(db, 'cat_travel', [200000, 0, 0, 1200, 0, 0, 0]);

  assert.deepEqual(
    getAnomalyInsights(db, NOW).filter((i) => i.id === 'spending-category-spike'),
    []
  );
});

test('a spike is measured against the worst prior month, not the most recent one', (t) => {
  const db = setupDb();
  t.after(() => db.close());

  // Last month was quiet ($50) but the category has run at $920 before. Against the neighbouring
  // window this month is "up 2900%", which is what the old rule reported. Against the habit it is
  // $1,500 on a category that has already spent $920 in a month: 1.6x, not a spike.
  steadySpend(db, 'cat_food', [150000, 5000, 90000, 6000, 88000, 7000, 92000]);

  assert.deepEqual(
    getAnomalyInsights(db, NOW).filter((i) => i.id === 'spending-category-spike'),
    []
  );
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
