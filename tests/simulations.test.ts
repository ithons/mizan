import test from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { format, subDays } from 'date-fns';
import { _setDbForTesting } from '../server/src/db/index';
import { computeSafeToSpend, readSafeToSpend } from '../server/src/services/safeToSpend';
import { checkAdjustments, compoundGrowth, cashRunway, debtPayoff, emergencyFund, goalTimeline, projectFree, projectFreeBand } from '../server/src/services/simulations';
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

test('the emergency fund is sized from the spread of essential spending, with its assumptions', () => {
  const db = migratedTestDb();
  const chase = insertAccount(db, { account_name: 'Chase', type: 'checking', current_balance: 900000 });
  const today = new Date('2026-10-16T12:00:00');
  [100000, 120000, 80000, 100000, 120000, 80000].forEach((cents, index) => {
    const month = format(new Date(2026, 3 + index, 10), 'yyyy-MM-dd');
    insertTransaction(db, { account_id: chase, date: month, amount: -cents, category_id: 'cat_food' });
  });
  const result = emergencyFund(db, { months: 3, confidence: 0.9 }, today) as { target: number; essential_monthly_mean: number; essential_monthly_sd: number; assumptions: string[] };
  assert.equal(result.essential_monthly_mean, 1000);
  const sdCents = Math.sqrt((4 * 20000 ** 2) / 5);
  assert.equal(result.target, Math.round(3 * 100000 + 1.28 * sdCents * Math.sqrt(3)) / 100);
  assert.ok(result.assumptions.some((line) => line.includes('cat_food')));
});

test('with under three months of essentials it declines to size a fund', () => {
  assert.equal((emergencyFund(migratedTestDb()) as { target: number | null }).target, null);
});

test('the daily allowance appears only when something is free and income is ahead', () => {
  withLedger((db) => {
    const sheet = readSafeToSpend(db);
    if (sheet.free > 0) {
      assert.ok(sheet.next_income_date && sheet.per_day_until_next_income !== null);
      assert.ok(sheet.per_day_until_next_income! <= sheet.free);
    } else {
      assert.equal(sheet.per_day_until_next_income, null);
    }
  });
  const broke = migratedTestDb();
  insertAccount(broke, { type: 'credit', is_liability: 1, current_balance: 50000 });
  assert.equal(readSafeToSpend(broke).per_day_until_next_income, null);
});

test('income expected already but not posted is named when a projection counts it', () => {
  withLedger((db) => {
    const healthy = projectFree(db, 30) as { overdue_income_counted?: unknown };
    assert.equal(healthy.overdue_income_counted, undefined, 'HEALTHY: nothing named when pay is on time');
    db.prepare("UPDATE recurring_patterns SET next_expected = ? WHERE merchant_name LIKE '%payroll%'").run(day(3));
    const late = projectFree(db, 30) as { overdue_income_counted?: Array<{ name: string; expected_on: string }>; assumptions: string[] };
    assert.ok(late.overdue_income_counted && late.overdue_income_counted.some((item) => item.expected_on === day(3)));
    assert.ok(late.assumptions.some((line) => line.includes('has not posted')));
  });
});

function steadyLedger(): Database.Database {
  const db = migratedTestDb();
  const chase = insertAccount(db, { account_name: 'Chase', type: 'checking', current_balance: 500000 });
  for (let back = 150; back >= 1; back--) {
    insertTransaction(db, { account_id: chase, date: day(back), amount: -2000, merchant_name: `Cafe ${back}`, original_name: `CAFE ${back}`, category_id: 'cat_food_restaurants' });
  }
  for (let weeks = 20; weeks >= 1; weeks--) {
    insertTransaction(db, { account_id: chase, date: day(7 * weeks), amount: 50000, merchant_name: 'Payroll', original_name: 'PAYROLL', category_id: 'cat_income_paycheck' });
  }
  _setDbForTesting(db);
  detectRecurring();
  return db;
}

test('HEALTHY: steady spending and fixed pay give a band of no width around the point estimate', () => {
  const db = steadyLedger();
  try {
    const result = projectFreeBand(db, 30, 500) as { point_estimate: number; band: { p10: number; p50: number; p90: number }; chance_of_dropping_below_claims: number };
    assert.ok(result.band);
    assert.ok(Math.abs(result.band.p90 - result.band.p10) < 1, `${result.band.p10}..${result.band.p90}`);
    assert.ok(Math.abs(result.band.p50 - result.point_estimate) < 1);
    assert.equal(result.chance_of_dropping_below_claims, 0, 'a comfortable ledger never reads as at risk');
  } finally {
    _setDbForTesting(undefined as unknown as Database.Database);
  }
});

test('a band is refused without ninety days of history, and the same seed gives the same band', () => {
  const young = migratedTestDb();
  insertTransaction(young, { date: day(10), amount: -500, category_id: 'cat_food' });
  assert.equal((projectFreeBand(young, 30, 100) as { band: unknown }).band, null);
  withLedger((db) => {
    db.prepare("UPDATE transactions SET date = ? WHERE id = (SELECT id FROM transactions ORDER BY date LIMIT 1)").run(day(120));
    assert.deepEqual(projectFreeBand(db, 30, 300), projectFreeBand(db, 30, 300));
  });
});

test('the daily allowance spends only what exists before the next pay, not the pay after it', () => {
  const db = migratedTestDb();
  _setDbForTesting(db);
  try {
    const chase = insertAccount(db, { account_name: 'Chase', type: 'checking', current_balance: 10000 });
    for (const k of [8, 7, 6, 5, 4, 3, 2, 1]) {
      insertTransaction(db, { account_id: chase, date: day(14 * k - 5), amount: 200000, merchant_name: 'Payroll', original_name: 'ACME PAYROLL PPD', category_id: 'cat_income_paycheck' });
    }
    detectRecurring();
    const sheet = readSafeToSpend(db);
    assert.ok(sheet.expected_inflows >= 4000, 'two paychecks are in the window');
    assert.ok(sheet.per_day_until_next_income !== null && sheet.per_day_until_next_income <= 100, `${sheet.per_day_until_next_income} a day from $100 on hand`);
  } finally {
    _setDbForTesting(undefined as unknown as Database.Database);
  }
});

test('next month\'s budget does not claim a recurring bill the forecast already claims', () => {
  const db = migratedTestDb();
  _setDbForTesting(db);
  try {
    const chase = insertAccount(db, { account_name: 'Chase', type: 'checking', current_balance: 500000 });
    for (const m of [5, 4, 3, 2, 1, 0]) {
      const first = new Date(new Date().getFullYear(), new Date().getMonth() - m, 1);
      insertTransaction(db, { account_id: chase, date: format(first, 'yyyy-MM-dd'), amount: -200000, merchant_name: 'Landlord', original_name: 'LANDLORD RENT', category_id: 'cat_home_rent' });
    }
    detectRecurring();
    db.prepare("INSERT INTO budgets (id, category_id, amount, period, rollover, created_at, updated_at) VALUES ('b1', 'cat_home', 200000, 'monthly', 0, datetime(), datetime())").run();
    const now = new Date();
    const daysLeft = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate() - now.getDate();
    const sheet = computeSafeToSpend(db, { budgets: getMonthlyBudgetsWithProjection(db, now.getFullYear(), now.getMonth() + 1), forecastDays: daysLeft + 10 });
    assert.ok(sheet.upcomingBills >= 200000, 'next month\'s rent is a forecast bill');
    assert.equal(sheet.budgetsAhead, 0, 'so the Home budget claims nothing more for it');
  } finally {
    _setDbForTesting(undefined as unknown as Database.Database);
  }
});

test('a purchase in a band what-if lowers the typical outcome by its amount and never lowers the risk', () => {
  withLedger((db) => {
    db.prepare("UPDATE transactions SET date = ? WHERE id = (SELECT id FROM transactions ORDER BY date LIMIT 1)").run(day(120));
    const soon = format(new Date(Date.now() + 3 * 86_400_000), 'yyyy-MM-dd');
    const result = projectFreeBand(db, 30, 400, new Date(), 7, [{ kind: 'one_off', date: soon, amount: -1500 }]) as {
      band: { p50: number }; chance_of_dropping_below_claims: number;
      scenario: { band: { p50: number }; chance_of_dropping_below_claims: number };
    };
    assert.ok(Math.abs(result.band.p50 - result.scenario.band.p50 - 1500) < 0.01, `${result.band.p50} vs ${result.scenario.band.p50}`);
    assert.ok(result.scenario.chance_of_dropping_below_claims >= result.chance_of_dropping_below_claims);
  });
});

test('cancelling steady pay in a band what-if moves every percentile by exactly that pay', () => {
  const db = steadyLedger();
  try {
    const payroll = db.prepare("SELECT id FROM recurring_patterns WHERE merchant_name LIKE '%payroll%'").get() as { id: string };
    const result = projectFreeBand(db, 30, 300, new Date(), 11, [{ kind: 'cancel_recurring', pattern_id: payroll.id }]) as {
      point_estimate: number; band: { p10: number; p50: number; p90: number };
      scenario: { point_estimate: number; band: { p10: number; p50: number; p90: number } };
    };
    const shift = result.point_estimate - result.scenario.point_estimate;
    assert.ok(shift > 0);
    for (const q of ['p10', 'p50', 'p90'] as const) assert.ok(Math.abs(result.band[q] - result.scenario.band[q] - shift) < 0.01, q);
  } finally {
    _setDbForTesting(undefined as unknown as Database.Database);
  }
});
