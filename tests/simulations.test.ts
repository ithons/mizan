import test from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { format, subDays } from 'date-fns';
import { _setDbForTesting } from '../server/src/db/index';
import { computeSafeToSpend } from '../server/src/services/safeToSpend';
import { checkAdjustments, compoundGrowth, cashRunway, debtPayoff, goalTimeline, projectFree } from '../server/src/services/simulations';
import { getMonthlyBudgetsWithProjection } from '../server/src/services/budgetProjection';
import { detectRecurring } from '../server/src/services/recurring';
import { refreshTransactionIntegrity } from '../server/src/services/transactionIntegrity';
import { insertAccount, insertTransaction, migratedTestDb } from './helpers/schema';

const day = (daysAgo: number) => format(subDays(new Date(), daysAgo), 'yyyy-MM-dd');

function withLedger(run: (db: Database.Database) => void): void {
  const db = migratedTestDb();
  _setDbForTesting(db);
  try {
    const chase = insertAccount(db, { account_name: 'Chase Checking', type: 'checking', current_balance: 300000 });
    const fidelity = insertAccount(db, { account_name: 'Fidelity', type: 'brokerage', current_balance: 500000 });
    insertAccount(db, { account_name: 'Sapphire', type: 'credit', is_liability: 1, current_balance: 40000 });
    for (const weeksAgo of [6, 5, 4, 3, 2, 1]) {
      insertTransaction(db, { account_id: chase, date: day(7 * weeksAgo), amount: 54418, merchant_name: 'Mass Inst Payroll', original_name: 'MASS INST PAYROLL PPD', category_id: 'cat_income_paycheck' });
      insertTransaction(db, { account_id: chase, date: day(7 * weeksAgo), amount: -10000, original_name: 'FID BKG SVC LLC MONEYLINE', category_id: 'cat_inv_transfer', category_source: 'rule' });
      insertTransaction(db, { account_id: fidelity, date: day(7 * weeksAgo), amount: 10000, original_name: 'Electronic Funds Transfer Received' });
      insertTransaction(db, { account_id: chase, date: day(7 * weeksAgo + 2), amount: -4200, merchant_name: 'Cava', original_name: 'CAVA', category_id: 'cat_food_restaurants' });
    }
    for (const monthsAgo of [4, 3, 2, 1]) {
      insertTransaction(db, { account_id: chase, date: day(30 * monthsAgo + 5), amount: -1599, merchant_name: 'Netflix', original_name: 'NETFLIX.COM', category_id: 'cat_ent_streaming' });
    }
    refreshTransactionIntegrity(db);
    detectRecurring();
    run(db);
  } finally {
    _setDbForTesting(undefined as unknown as Database.Database);
    db.close();
  }
}

test('the dated schedule adds up to exactly what free to spend adds and subtracts', () => {
  withLedger((db) => {
    const sheet = computeSafeToSpend(db, { forecastDays: 30 });
    assert.ok(sheet.scheduled.length > 0);
    const total = sheet.scheduled.reduce((sum, item) => sum + item.cents, 0);
    assert.equal(total, sheet.expectedInflows + sheet.cardRelief - sheet.upcomingBills - sheet.recurringTransfers - sheet.budgetsAhead);
  });
});

test('with no what-if, the projection ends on the free-to-spend figure to the cent', () => {
  withLedger((db) => {
    const now = new Date();
    const sheet = computeSafeToSpend(db, { budgets: getMonthlyBudgetsWithProjection(db, now.getFullYear(), now.getMonth() + 1), forecastDays: 30 });
    const projection = projectFree(db, 30, [], now);
    assert.equal(Math.round(projection.baseline.free_at_end * 100), sheet.free);
    assert.ok(projection.baseline.lowest <= projection.baseline.free_at_end);
    assert.ok(!('scenario' in projection), 'a plain projection carries no scenario');
  });
});

test('a one-off purchase moves the end and the low by its amount, and cancelling a bill raises them', () => {
  withLedger((db) => {
    const soon = format(new Date(Date.now() + 3 * 86_400_000), 'yyyy-MM-dd');
    const bought = projectFree(db, 30, [{ kind: 'one_off', date: soon, amount: -500 }]);
    assert.equal(bought.change_at_end, -500);
    assert.equal(Math.round((bought.scenario!.free_at_end - bought.baseline.free_at_end) * 100), -50000);
    const paycheck = db.prepare("SELECT id FROM recurring_patterns WHERE merchant_name LIKE '%payroll%'").get() as { id: string };
    const withoutPay = projectFree(db, 30, [{ kind: 'cancel_recurring', pattern_id: paycheck.id }]);
    assert.ok(withoutPay.change_at_end! < 0, 'losing the paycheck lowers what is free');
  });
});

test('payoff, goal and growth arithmetic hold on figures checkable by hand', () => {
  assert.deepEqual(debtPayoff(1000, 0, 100).months, 10);
  assert.equal(debtPayoff(1000, 0, 100).total_interest, 0);
  assert.equal(debtPayoff(1000, 24, 10).months, null, 'a payment under the interest never clears');
  assert.equal(goalTimeline(1200, 0, 100).months, 12);
  assert.equal(goalTimeline(1200, 0, 0).months, null);
  assert.deepEqual(compoundGrowth(1000, 100, 0, 1), { final_value: 2200, contributed: 2200, growth: 0 });
});

test('runway with no spending history says it cannot measure rather than claiming a figure', () => {
  const db = migratedTestDb();
  assert.equal(cashRunway(db).months_covered, null);
});

test('a what-if that would silently change the answer is refused with its reasons', () => {
  withLedger((db) => {
    const today = new Date('2026-10-16T12:00:00');
    const checked = checkAdjustments(db, [
      { kind: 'monthly', amount: -50, start_date: '2026-01-01' },
      { kind: 'one_off', date: '2027-06-01', amount: -100 },
      { kind: 'one_off', date: '2026-10-20' },
      { kind: 'cancel_recurring', pattern_id: 'no-such-pattern' },
      { kind: 'teleport' },
    ], 30, today);
    assert.equal(checked.ok, false);
    assert.equal(checked.ok === false && checked.errors.length, 5);
    assert.deepEqual(checkAdjustments(db, [{ kind: 'one_off', date: '2026-10-20', amount: -100 }], 30, today).ok, true);
  });
});

test('payoff refuses a missing payment instead of blaming the interest', () => {
  assert.equal(debtPayoff(1000, 0, 0).months, null);
  assert.match(debtPayoff(1000, 0, 0).note ?? '', /payment above zero/);
});

test('a goal timeline grows what is already saved, not only new contributions', () => {
  const withoutGrowth = goalTimeline(10000, 9000, 10, 0).months!;
  const withGrowth = goalTimeline(10000, 9000, 10, 6).months!;
  assert.ok(withGrowth < withoutGrowth, `${withGrowth} < ${withoutGrowth}`);
});

test('runway is measured net of what the cards owe, and states its assumptions', () => {
  withLedger((db) => {
    const runway = cashRunway(db);
    assert.ok('cards_owed' in runway && runway.cards_owed === 400);
    assert.ok('assumptions' in runway && runway.assumptions!.length >= 2);
  });
});

test('a window reaching into next month claims that month\'s budgets for the days it covers', () => {
  const db = migratedTestDb();
  const today = new Date();
  const daysLeft = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate() - today.getDate();
  const next = new Date(today.getFullYear(), today.getMonth() + 1, 1);
  const daysInNext = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
  const into = 15;
  const sheet = computeSafeToSpend(db, { budgets: [{ category_id: 'cat_food', amount: 30000, projected_remaining: 0 }], forecastDays: daysLeft + into });
  assert.equal(sheet.budgetsAhead, Math.round((30000 * into) / daysInNext));
  const none = computeSafeToSpend(db, { budgets: [{ category_id: 'cat_food', amount: 30000, projected_remaining: 0 }], forecastDays: daysLeft });
  assert.equal(none.budgetsAhead, 0, 'a window ending this month claims nothing ahead');
});
