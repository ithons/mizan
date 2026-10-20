import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _setDbForTesting } from '../server/src/db/index';
import { buildFinancialContext } from '../server/src/services/aiContext';
import { insertAccount, insertCategory, insertTransaction, migratedTestDb } from './helpers/schema';

/**
 * What the model is told has to be true. These pin the two ways it was not.
 */

function monthsBack(back: number): string {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() - back, 15);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-15`;
}

function firstOfMonthsBack(back: number): string {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() - back, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

test('the cash-flow average divides complete months by the number of complete months', () => {
  const db = migratedTestDb();
  _setDbForTesting(db);
  const account = insertAccount(db, { type: 'checking', current_balance: 100000 });
  const income = insertCategory(db, { name: 'Test Pay', is_income: 1 });

  // Three complete months of income, plus a large amount in the current partial month. Only the
  // complete months may enter a "3 complete months" average, in either the numerator or the divisor.
  for (const back of [1, 2, 3]) {
    insertTransaction(db, { account_id: account, date: monthsBack(back), amount: 300000, category_id: income });
  }
  insertTransaction(db, { account_id: account, date: monthsBack(0), amount: 999999, category_id: income });

  const context = buildFinancialContext();
  const line = context.split('\n').find((l) => l.trim().startsWith('Income:'));
  assert.ok(line, 'the cash-flow section must be present');
  // $3,000.00 x 3 / 3. The old form ran the window to TODAY, so it summed four calendar buckets
  // and divided by the literal 3: on the real ledger it reported $2,862.93/mo of income where the
  // truth was $2,139.19/mo, inflating every figure behind "can I afford this" by a third.
  assert.match(line, /\$3,000\.00\/mo/);
  assert.doesNotMatch(context, /9,999\.99\/mo/);
  db.close();
});

test('a stored estimate never reaches the model, and the trend it reads is the timeline', () => {
  const db = migratedTestDb();
  _setDbForTesting(db);
  const account = insertAccount(db, { type: 'checking', current_balance: 100000 });
  insertTransaction(db, { account_id: account, date: firstOfMonthsBack(5), amount: 100000 });
  db.prepare(`
    INSERT INTO net_worth_snapshots
      (id, date, total_assets, total_liabilities, net_worth, breakdown, is_estimated, created_at)
    VALUES ('e1', ?, 523456, 0, 523456, ?, 1, '2026-07-30T00:00:00.000Z')
  `).run(firstOfMonthsBack(3), JSON.stringify({ [account]: 523456 }));

  const context = buildFinancialContext();
  assert.match(context, /### Net Worth Trend/);
  assert.doesNotMatch(context, /5,234\.56/);
  assert.doesNotMatch(context, /\(estimated\)/, 'a cash account walked from its ledger is never an estimate');
  db.close();
});
