import test from 'node:test';
import assert from 'node:assert/strict';
import { explainMonth, fundingMix } from '../server/src/services/monthStudies';
import { insertAccount, insertTransaction, migratedTestDb } from './helpers/schema';
import { _setDbForTesting } from '../server/src/db/index';
import { detectRecurring } from '../server/src/services/recurring';

function ledger(septemberFood: number) {
  const db = migratedTestDb();
  const chase = insertAccount(db, { account_name: 'Chase', type: 'checking' });
  for (const [month, food] of [['2026-06', 40000], ['2026-07', 41000], ['2026-08', 39000], ['2026-09', septemberFood]] as const) {
    insertTransaction(db, { account_id: chase, date: `${month}-10`, amount: -food, merchant_name: 'Grocer', original_name: 'GROCER', category_id: 'cat_food' });
    insertTransaction(db, { account_id: chase, date: `${month}-12`, amount: -6000, merchant_name: 'Gas', original_name: 'GAS', category_id: 'cat_transport' });
    insertTransaction(db, { account_id: chase, date: `${month}-15`, amount: 200000, merchant_name: 'Payroll', original_name: 'PAYROLL', category_id: 'cat_income_paycheck' });
  }
  _setDbForTesting(db);
  detectRecurring();
  _setDbForTesting(undefined as unknown as typeof db);
  return db;
}

test('HEALTHY: a month like the three before it names no category move', () => {
  const result = explainMonth(ledger(40500), '2026-09') as { category_moves: unknown[]; large_one_offs: unknown[] };
  assert.deepEqual(result.category_moves, []);
  assert.deepEqual(result.large_one_offs, []);
});

test('a category well past its usual range is named with its usual level and change', () => {
  const result = explainMonth(ledger(90000), '2026-09') as { category_moves: Array<{ category: string; usual: number; change: number }> };
  assert.equal(result.category_moves.length, 1);
  assert.equal(result.category_moves[0].usual, 400);
  assert.equal(result.category_moves[0].change, 500);
});

test('a malformed month is refused', () => {
  assert.deepEqual(explainMonth(migratedTestDb(), 'Sept'), { error: 'month must be YYYY-MM' });
  assert.deepEqual(explainMonth(migratedTestDb(), '2026-13'), { error: 'month must be YYYY-MM' });
});

test('funding mix splits income into recurring and other, and reports what pay covers', () => {
  const db = ledger(40000);
  const months = fundingMix(db, 6, new Date('2026-10-16T12:00:00')).months;
  const september = months.find((m) => m.month === '2026-09');
  assert.ok(september);
  assert.equal(september.recurring_income + september.other_income, 2000);
  assert.equal(september.spending, 460);
});
