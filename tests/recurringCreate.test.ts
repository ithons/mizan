import test from 'node:test';
import assert from 'node:assert/strict';
import { addDays, format } from 'date-fns';
import { migratedTestDb } from './helpers/schema';
import { createRecurringPattern } from '../server/src/services/recurring';
import { buildRecurringForecast } from '../server/src/services/recurringForecast';

// The hand-written schema this replaced declared `average_amount REAL` and
// `adjusted_amount REAL`, where production has both as INTEGER cents since migration 022, and
// dropped the CHECK on `frequency`. Categories are the seeded taxonomy.
const setupDb = migratedTestDb;

test('createRecurringPattern inserts a confirmed pattern with an unsigned amount', () => {
  const db = setupDb();
  const next = format(addDays(new Date(), 5), 'yyyy-MM-dd');
  const id = createRecurringPattern(db, {
    merchant_name: 'Rent',
    frequency: 'monthly',
    average_amount: -1800, // sign should be stripped
    next_expected: next,
    category_id: 'cat_home_rent',
  });

  const row = db.prepare('SELECT * FROM recurring_patterns WHERE id = ?').get(id) as any;
  assert.equal(row.merchant_name, 'Rent');
  assert.equal(row.average_amount, 180000);
  assert.equal(row.is_confirmed, 1);
  assert.equal(row.is_active, 1);
  assert.equal(row.transaction_count, 0);
  assert.equal(row.next_expected, next);
  assert.equal(row.last_seen, next);
});

test('a manually created pattern appears in the forecast with the right sign', () => {
  const db = setupDb();
  const next = format(addDays(new Date(), 5), 'yyyy-MM-dd');
  createRecurringPattern(db, {
    merchant_name: 'Paycheck',
    frequency: 'monthly',
    average_amount: 4000,
    next_expected: next,
    category_id: 'cat_income_paycheck',
  });

  const forecast = buildRecurringForecast(db, 30);
  const paycheck = forecast.occurrences.find((o) => o.merchant_name === 'Paycheck');
  assert.ok(paycheck, 'manual pattern should surface in the forecast');
  assert.equal(paycheck!.is_income, true);
  assert.ok(paycheck!.amount > 0, 'income occurrence amount should be positive');
});

test('createRecurringPattern rejects a duplicate name with 409', () => {
  const db = setupDb();
  const next = format(addDays(new Date(), 5), 'yyyy-MM-dd');
  const input = { merchant_name: 'Spotify', frequency: 'monthly' as const, average_amount: 12, next_expected: next };
  createRecurringPattern(db, input);
  assert.throws(() => createRecurringPattern(db, input), (err: any) => err.status === 409);
});

test('createRecurringPattern rejects an unknown category with 400', () => {
  const db = setupDb();
  const next = format(addDays(new Date(), 5), 'yyyy-MM-dd');
  assert.throws(
    () => createRecurringPattern(db, { merchant_name: 'Gym', frequency: 'monthly', average_amount: 40, next_expected: next, category_id: 'nope' }),
    (err: any) => err.status === 400,
  );
});
