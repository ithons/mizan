import test from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { format, subDays } from 'date-fns';
import { _setDbForTesting } from '../server/src/db/index';
import { detectRecurring, expectedAmount } from '../server/src/services/recurring';
import { buildRecurringForecast } from '../server/src/services/recurringForecast';
import { occurrenceMeta } from '../client/src/views/ledger/spine';
import { insertAccount, insertTransaction, migratedTestDb } from './helpers/schema';

const series = (amounts: number[], dates?: string[]) =>
  amounts.map((amount, i) => ({ amount, date: dates?.[i] ?? `2026-10-${String(7 - i).padStart(2, '0')}` }));

test('pay that dropped twice running is forecast at the latest amount, with the old level kept', () => {
  const paid = series([22878, 45288, 112542, 55362, 54418, 54418], ['2026-10-07', '2026-09-30', '2026-09-16', '2026-09-02', '2026-08-26', '2026-08-19']);
  assert.deepEqual(expectedAmount(paid), { amount: 22878, changedFrom: 54418, changedOn: '2026-10-07' });
});

test('the week before, a bonus then a short check pulled opposite ways and the median held', () => {
  const paid = series([45288, 112542, 55362, 54418, 54418, 54418]);
  assert.deepEqual(expectedAmount(paid), { amount: 54418, changedFrom: null, changedOn: null });
});

test('one short check is an outlier, not a new level', () => {
  const paid = series([6120, 60228, 66038, 36158, 36158, 36158]);
  assert.equal(expectedAmount(paid).changedFrom, null);
});

test('two occurrences that agree set the new level at their mean, in either direction', () => {
  assert.equal(expectedAmount(series([30000, 31000, 54418, 54418, 54418, 54418])).amount, 30500);
  assert.equal(expectedAmount(series([-1037, -1037, -1004, -1834, -1883, -1803])).amount, -1037);
  assert.equal(expectedAmount(series([70000, 71000, 54418, 54418, 54418])).amount, 70500);
});

test('three occurrences are too few to call a level', () => {
  assert.deepEqual(expectedAmount(series([22878, 22878, 54418])), { amount: 22878, changedFrom: null, changedOn: null });
});

test('a steady series is silent', () => {
  assert.deepEqual(expectedAmount(series([54418, 54418, 55362, 54418, 54418])), { amount: 54418, changedFrom: null, changedOn: null });
});

test('the forecast quotes the new pay and says it changed', () => {
  const db = migratedTestDb();
  _setDbForTesting(db);
  try {
    const checking = insertAccount(db, { type: 'checking' });
    const amounts = [54418, 54418, 54418, 54418, 55362, 54418, 54418, 45288, 22878];
    amounts.forEach((amount, index) => {
      insertTransaction(db, {
        account_id: checking,
        date: format(subDays(new Date(), 7 * (amounts.length - 1 - index) + 1), 'yyyy-MM-dd'),
        amount,
        merchant_name: 'Mass Inst Payroll',
        original_name: 'MASS INST PAYROLL PPD ID: 9111111101',
        category_id: 'cat_income_paycheck',
      });
    });
    detectRecurring();

    const stored = db.prepare('SELECT average_amount, amount_changed_from FROM recurring_patterns').get();
    assert.deepEqual(stored, { average_amount: 22878, amount_changed_from: 54418 });

    const next = buildRecurringForecast(db, 14).occurrences.find((o) => o.status === 'upcoming');
    assert.ok(next);
    assert.equal(next.amount, 22878);
    assert.deepEqual(next.amount_change?.from, 54418);
    assert.match(occurrenceMeta({ ...next, amount_change: { from: 544.18, since: next.amount_change?.since ?? '' } }), /amount changed from \$544\.18/);
  } finally {
    _setDbForTesting(undefined as unknown as Database.Database);
    db.close();
  }
});

test('once the new level has repeated, the old one is still named as it was paid', () => {
  const paid = series([22878, 22878, 22878, 54418, 54418, 54418]);
  assert.deepEqual(expectedAmount(paid).changedFrom, 54418);
});

test('one old outlier is not a level the series moved off', () => {
  assert.equal(expectedAmount(series([250000, 250000, 250000, 120000])).changedFrom, null);
  assert.equal(expectedAmount(series([10000, 10000, 10000, 10000, 5000, 5000])).changedFrom, null);
});
