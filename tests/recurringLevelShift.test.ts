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
  assert.deepEqual(expectedAmount(paid), { amount: 63133, changedFrom: 36158, changedOn: '2026-10-05' });
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

test('a shift is still found once the new level fills half the window', () => {
  assert.deepEqual(
    [expectedAmount(series([8000, 8000, 8000, 10000, 10000, 10000])).amount, expectedAmount(series([8000, 8000, 8000, 10000, 10000, 10000])).changedFrom],
    [8000, 10000]
  );
  assert.equal(expectedAmount(series([8000, 8000, 10000, 10000])).amount, 8000);
  assert.equal(expectedAmount(series([12500, 12500, 10000, 10000])).amount, 12500);
});

test('a bonus on the latest check is not the new level, even with an older level beneath it', () => {
  assert.equal(expectedAmount(series([112542, 54418, 54418, 54418, 30000, 30000])).amount, 54418);
  assert.equal(expectedAmount(series([22878, 54418, 54418, 54418, 80000, 80000])).amount, 54418);
});

test('the most recent change is the one named, whatever was paid before it', () => {
  assert.deepEqual(expectedAmount(series([30000, 30000, 54418, 54418, 80000, 80000])), {
    amount: 30000, changedFrom: 54418, changedOn: '2026-10-06',
  });
});

test('a change is dated from the first charge at the new amount, not the latest one', () => {
  const backblaze = series(
    [-1037, -1037, -1004, -1834, -1883, -1803],
    ['2026-09-17', '2026-08-17', '2026-07-17', '2026-06-17', '2026-05-17', '2026-04-17']
  );
  assert.deepEqual(expectedAmount(backblaze), { amount: -1037, changedFrom: -1834, changedOn: '2026-07-17' });
});

test('a bill that ran high and came back has not changed level', () => {
  for (const amounts of [
    [30000, 30000, 54418, 54500, 30000, 30000],
    [1000, 1000, 1500, 1000, 1510, 1000],
    [1000, 700, 1500, 1510, 1000, 1000],
    [10000, 15000, 15000, 10000, 10000, 10000],
    [-10000, -15000, -15000, -10000, -10000, -10000],
    [30000, 54418, 54418, 30000, 30000, 30000],
    [5000, 1500, 1500, 1500, 5000, 5000],
  ]) {
    assert.equal(expectedAmount(series(amounts)).changedFrom, null, String(amounts));
  }
});

test('the level named is the one moved off, even when it was never paid twice exactly', () => {
  assert.equal(expectedAmount(series([30000, 30000, 54418, 55000, 80000, 80000])).changedFrom, 54418);
});

test('a bonus on a raise only two checks old is still not the forecast', () => {
  assert.deepEqual(expectedAmount(series([112542, 54418, 54418, 30000, 30000, 30000])), {
    amount: 54418, changedFrom: 30000, changedOn: '2026-10-05',
  });
});

test('every series of five amounts names only a real level it left, dated on its first new amount', () => {
  const near = (a: number, b: number) => Math.abs(a - b) <= Math.abs(b) * 0.15;
  for (const sign of [1, -1]) {
    const values = [700, 1000, 1050, 1500, 3000].map((value) => value * sign);
    const walk = (prefix: number[]): void => {
      if (prefix.length >= 4) {
        const rows = series(prefix);
        const result = expectedAmount(rows);
        const label = String(prefix);
        if (result.changedFrom !== null) {
          assert.ok(!near(result.changedFrom, result.amount), label);
          assert.ok(!near(result.changedFrom, prefix[0]), label);
          assert.ok(prefix.includes(result.changedFrom), label);
          const paidThen = rows.find((row) => row.date === result.changedOn)?.amount;
          assert.ok(paidThen !== undefined && !near(paidThen, result.changedFrom) && !near(result.changedFrom, paidThen), label);
        }
        if (prefix.every((value) => near(value, prefix[0]))) assert.equal(result.changedFrom, null, label);
      }
      if (prefix.length < 6) for (const value of values) walk([...prefix, value]);
    };
    walk([]);
  }
});

test('a series that moves by a constant step is never a level change', () => {
  for (const start of [500, 900, 1000, 3000]) for (const step of [20, 50, 80, 100, 150]) for (const length of [4, 5, 6]) {
    for (const sign of [1, -1]) {
      const amounts = Array.from({ length }, (_, i) => sign * (start + step * (length - 1 - i)));
      assert.equal(expectedAmount(series(amounts)).changedFrom, null, String(amounts));
    }
  }
});

test('three agreeing occurrences after an erratic stretch are the forecast, with nothing named', () => {
  assert.deepEqual(expectedAmount(series([700, 700, 700, 1000, 1500, 3000])), { amount: 700, changedFrom: null, changedOn: null });
});

test('a rise just past the threshold is still reported, against the level it left', () => {
  assert.deepEqual(expectedAmount(series([11700, 11700, 10000, 10000, 10000, 10000])), {
    amount: 11700, changedFrom: 10000, changedOn: '2026-10-06',
  });
  assert.equal(expectedAmount(series([11600, 11600, 11600, 10000, 10000, 10000])).changedFrom, 10000);
});

test('a payment still at the old level is never the date a change began', () => {
  assert.equal(expectedAmount(series([11800, 11800, 10400, 10000, 10000, 10000])).changedOn, '2026-10-06');
  assert.notEqual(expectedAmount(series([1400, 1350, 1200, 1100, 1100, 1100])).changedOn, '2026-10-05');
});

test('a bill that rises a little every cycle has no level to have changed from', () => {
  assert.equal(expectedAmount(series([1400, 1300, 1200, 1100, 1000, 900])).changedFrom, null);
  assert.equal(expectedAmount(series([-1400, -1300, -1200, -1100, -1000, -900])).changedFrom, null);
});
