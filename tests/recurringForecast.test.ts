import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { addDays, addMonths, format, lastDayOfMonth, parseISO, subDays, subMonths } from 'date-fns';
import { buildRecurringForecast } from '../server/src/services/recurringForecast';
import { occurrenceDate } from '../server/src/services/recurring';
import { insertAccount, insertTransaction, migratedTestDb } from './helpers/schema';

// Built on the migrated schema rather than a hand-written one: the day-of-month, calendar-day, and
// expected-amount bugs below all lived in queries and walks that a trimmed-down table hid.

interface PatternSeed {
  id: string;
  merchant_name: string;
  category_id: string | null;
  average_amount: number;
  frequency: string;
  next_expected: string;
  is_confirmed: number;
  transaction_count: number;
  last_seen?: string;
}

function insertPattern(db: Database.Database, seed: PatternSeed): void {
  db.prepare(`
    INSERT INTO recurring_patterns (
      id, merchant_name, category_id, average_amount, frequency, last_seen, next_expected,
      is_active, is_confirmed, transaction_count, created_at, updated_at
    )
    VALUES (@id, @merchant_name, @category_id, @average_amount, @frequency, @last_seen,
            @next_expected, 1, @is_confirmed, @transaction_count, '2026-01-01', '2026-01-01')
  `).run({ ...seed, last_seen: seed.last_seen ?? seed.next_expected });
}

function linkTransactions(
  db: Database.Database,
  patternId: string,
  amounts: number[],
  startDaysAgo = 180
): void {
  const accountId = insertAccount(db);
  amounts.forEach((amount, i) => {
    const id = insertTransaction(db, {
      id: `${patternId}_${i}`,
      account_id: accountId,
      date: format(subDays(new Date(), startDaysAgo - i * 30), 'yyyy-MM-dd'),
      amount,
      merchant_name: patternId,
    });
    db.prepare('UPDATE transactions SET recurring_id = ? WHERE id = ?').run(patternId, id);
  });
}

function setupRecurringDb(): Database.Database {
  const db = migratedTestDb();
  const today = format(new Date(), 'yyyy-MM-dd');

  insertPattern(db, {
    id: 'paycheck',
    merchant_name: 'MIT Payroll',
    category_id: 'cat_income_paycheck',
    average_amount: 2000,
    frequency: 'monthly',
    next_expected: today,
    is_confirmed: 1,
    transaction_count: 3,
  });
  insertPattern(db, {
    id: 'rent',
    merchant_name: 'Rent',
    category_id: 'cat_home_rent',
    average_amount: 1000,
    frequency: 'monthly',
    next_expected: today,
    is_confirmed: 1,
    transaction_count: 3,
  });
  insertPattern(db, {
    id: 'streaming',
    merchant_name: 'Streaming',
    category_id: 'cat_ent_streaming',
    average_amount: 20,
    frequency: 'monthly',
    next_expected: today,
    is_confirmed: 1,
    transaction_count: 3,
  });
  insertPattern(db, {
    id: 'unconfirmed',
    merchant_name: 'Not Ready',
    category_id: 'cat_ent_streaming',
    average_amount: 500,
    frequency: 'monthly',
    next_expected: today,
    is_confirmed: 0,
    transaction_count: 2,
  });

  linkTransactions(db, 'streaming', [-12, -16]);

  return db;
}

function insertAdjustment(
  db: Database.Database,
  params: {
    id: string;
    recurringId: string;
    originalDate: string;
    action: 'skip' | 'snooze' | 'adjust';
    adjustedDate?: string | null;
    adjustedAmount?: number | null;
  }
): void {
  db.prepare(`
    INSERT INTO recurring_occurrence_adjustments (
      id, recurring_id, original_date, action, adjusted_date, adjusted_amount, note, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
  `).run(
    params.id,
    params.recurringId,
    params.originalDate,
    params.action,
    params.adjustedDate ?? null,
    params.adjustedAmount ?? null,
    new Date().toISOString(),
    new Date().toISOString()
  );
}

/** The most recent day-31 that has already passed, so the anchor is a real month-end. */
function lastThirtyFirst(): Date {
  let candidate = new Date();
  for (let back = 0; back < 14; back++) {
    const month = subMonths(candidate, back);
    const end = lastDayOfMonth(month);
    if (end.getDate() === 31 && end <= new Date()) return end;
  }
  return candidate;
}

test('recurring forecast uses signed amounts and ignores weak patterns', (t) => {
  const db = setupRecurringDb();
  t.after(() => db.close());

  const forecast = buildRecurringForecast(db, 1);

  assert.equal(forecast.income, 2000);
  assert.equal(forecast.bills, 1014);
  assert.equal(forecast.net, 986);
  assert.deepEqual(
    forecast.occurrences.map((occurrence) => [occurrence.pattern_id, occurrence.amount]),
    [
      ['paycheck', 2000],
      ['rent', -1000],
      ['streaming', -14],
    ]
  );
  assert.equal(forecast.confirmed_income, 2000);
  assert.equal(forecast.confirmed_bills, 1014);
  assert.equal(forecast.review_count, 0);
});

test('recurring forecast keeps one overdue occurrence visible for review', (t) => {
  const db = setupRecurringDb();
  t.after(() => db.close());

  const overdueDate = format(subDays(new Date(), 5), 'yyyy-MM-dd');
  insertPattern(db, {
    id: 'overdue_bill',
    merchant_name: 'Overdue Bill',
    category_id: 'cat_home_utilities',
    average_amount: 100,
    frequency: 'monthly',
    next_expected: overdueDate,
    is_confirmed: 0,
    transaction_count: 3,
  });

  const forecast = buildRecurringForecast(db, 1);
  const overdue = forecast.occurrences.find((occurrence) => occurrence.pattern_id === 'overdue_bill');

  assert.equal(forecast.overdue_count, 1);
  assert.equal(forecast.review_count, 1);
  assert.equal(forecast.likely_bills, 100);
  assert.equal(overdue?.status, 'overdue');
  assert.equal(overdue?.needs_review, true);
  assert.equal(overdue?.confidence_label, 'likely');
  // Its true calendar age, not the floored -1 the wall-clock delta used to report.
  assert.equal(overdue?.days_until, -5);
});

test('recurring forecast applies skip, snooze, and amount adjustments', (t) => {
  const db = setupRecurringDb();
  t.after(() => db.close());

  const today = format(new Date(), 'yyyy-MM-dd');
  const tomorrow = format(addDays(new Date(), 1), 'yyyy-MM-dd');
  insertAdjustment(db, {
    id: 'adj_rent_skip',
    recurringId: 'rent',
    originalDate: today,
    action: 'skip',
  });
  insertAdjustment(db, {
    id: 'adj_paycheck_snooze',
    recurringId: 'paycheck',
    originalDate: today,
    action: 'snooze',
    adjustedDate: tomorrow,
  });
  insertAdjustment(db, {
    id: 'adj_streaming_amount',
    recurringId: 'streaming',
    originalDate: today,
    action: 'adjust',
    adjustedAmount: -25,
  });

  const forecast = buildRecurringForecast(db, 2);
  const rent = forecast.occurrences.find((occurrence) => occurrence.pattern_id === 'rent');
  const paycheck = forecast.occurrences.find((occurrence) => occurrence.pattern_id === 'paycheck');
  const streaming = forecast.occurrences.find((occurrence) => occurrence.pattern_id === 'streaming');

  // Skipped occurrences stay in the payload (so the UI can offer undo) but are
  // excluded from every total below.
  assert.equal(rent?.adjustment_action, 'skip');
  assert.equal(rent?.needs_review, false);
  assert.equal(paycheck?.expected_date, tomorrow);
  assert.equal(paycheck?.original_expected_date, today);
  assert.equal(paycheck?.adjustment_action, 'snooze');
  assert.equal(streaming?.amount, -25);
  assert.equal(streaming?.adjustment_action, 'adjust');
  assert.equal(forecast.income, 2000);
  assert.equal(forecast.bills, 25);
  assert.equal(forecast.net, 1975);
});

// Chaining addMonths from each previous value clamps a month-end anchor and never recovers:
// 01-31 -> 02-28 -> 03-28, where the third occurrence is 03-31. Rent anchored on the 31st was
// shown due three days early, flagged overdue three days early, and dropped from the month's
// budget projection three days early, forever after the first short month.
test('a month-end anchor does not stick to the 28th', () => {
  const anchor = parseISO('2026-01-31');
  assert.equal(format(occurrenceDate(anchor, 'monthly', 0), 'yyyy-MM-dd'), '2026-01-31');
  assert.equal(format(occurrenceDate(anchor, 'monthly', 1), 'yyyy-MM-dd'), '2026-02-28');
  assert.equal(format(occurrenceDate(anchor, 'monthly', 2), 'yyyy-MM-dd'), '2026-03-31');
  assert.equal(format(occurrenceDate(anchor, 'monthly', 3), 'yyyy-MM-dd'), '2026-04-30');
  assert.equal(format(occurrenceDate(anchor, 'monthly', 4), 'yyyy-MM-dd'), '2026-05-31');

  assert.equal(format(occurrenceDate(anchor, 'quarterly', 1), 'yyyy-MM-dd'), '2026-04-30');
  assert.equal(format(occurrenceDate(anchor, 'annual', 1), 'yyyy-MM-dd'), '2027-01-31');
  assert.equal(format(occurrenceDate(anchor, 'weekly', 3), 'yyyy-MM-dd'), '2026-02-21');
  assert.equal(format(occurrenceDate(anchor, 'biweekly', 2), 'yyyy-MM-dd'), '2026-02-28');
});

test('a month-end bill lands on every month end the forecast covers', (t) => {
  const db = setupRecurringDb();
  t.after(() => db.close());

  const anchor = lastThirtyFirst();
  insertPattern(db, {
    id: 'month_end_rent',
    merchant_name: 'Month End Rent',
    category_id: 'cat_home_rent',
    average_amount: 150000,
    frequency: 'monthly',
    next_expected: format(anchor, 'yyyy-MM-dd'),
    is_confirmed: 1,
    transaction_count: 6,
  });

  const dates = buildRecurringForecast(db, 130).occurrences
    .filter((occurrence) => occurrence.pattern_id === 'month_end_rent')
    .map((occurrence) => occurrence.expected_date);

  assert.ok(dates.length >= 4, `expected several occurrences, got ${dates.join(', ')}`);
  for (const date of dates) {
    assert.equal(date, format(lastDayOfMonth(parseISO(date)), 'yyyy-MM-dd'), `${date} is not a month end`);
  }
  // One occurrence per month, no month skipped or doubled.
  assert.deepEqual(
    dates.map((date) => date.slice(0, 7)),
    dates.map((_, i) => format(addMonths(parseISO(dates[0]), i), 'yyyy-MM'))
  );
});

// days_until came from a wall-clock subtraction while status came from comparing date strings, so
// from local noon onward an occurrence dated today reported days_until -1 with status 'upcoming'.
test('days_until is 0 for an occurrence dated today, late in the day', (t) => {
  const db = setupRecurringDb();
  t.after(() => db.close());

  const lateToday = new Date();
  lateToday.setHours(23, 30, 0, 0);
  t.mock.timers.enable({ apis: ['Date'], now: lateToday });

  const forecast = buildRecurringForecast(db, 1);
  const rent = forecast.occurrences.find((occurrence) => occurrence.pattern_id === 'rent');

  assert.equal(rent?.expected_date, format(lateToday, 'yyyy-MM-dd'));
  assert.equal(rent?.days_until, 0);
  assert.equal(rent?.status, 'upcoming');
});

test('days_until never contradicts status', (t) => {
  const db = setupRecurringDb();
  t.after(() => db.close());

  insertPattern(db, {
    id: 'stale_bill',
    merchant_name: 'Stale Bill',
    category_id: 'cat_home_utilities',
    average_amount: 4200,
    frequency: 'monthly',
    next_expected: format(subDays(new Date(), 3), 'yyyy-MM-dd'),
    is_confirmed: 1,
    transaction_count: 4,
  });

  const forecast = buildRecurringForecast(db, 45);
  assert.ok(forecast.occurrences.length > 1);
  for (const occurrence of forecast.occurrences) {
    const overdue = occurrence.status === 'overdue';
    assert.equal(overdue, occurrence.days_until < 0, `${occurrence.id} says ${occurrence.status} at ${occurrence.days_until}d`);
  }
});

// The forecast used to average every linked row, so one bonus moved the expected amount for good.
// It now takes the same short-window median detection stores, so the Bills list and the forecast
// cannot print two different numbers for one pattern.
test('the expected amount is a recent median, not a mean over the whole history', (t) => {
  const db = setupRecurringDb();
  t.after(() => db.close());

  insertPattern(db, {
    id: 'variable_bill',
    merchant_name: 'Variable Bill',
    category_id: 'cat_home_utilities',
    average_amount: 2000,
    frequency: 'monthly',
    next_expected: format(new Date(), 'yyyy-MM-dd'),
    is_confirmed: 1,
    transaction_count: 10,
  });
  linkTransactions(
    db,
    'variable_bill',
    [-1000, -1000, -1000, -1000, -1000, -10000, -2000, -2000, -2000, -2000],
    300
  );

  const forecast = buildRecurringForecast(db, 1);
  const occurrence = forecast.occurrences.find((o) => o.pattern_id === 'variable_bill');

  assert.equal(occurrence?.amount, -2000); // the mean over all ten rows is -2400
});

test('a pattern with no linked rows falls back to its stored amount, signed by its category', (t) => {
  const db = setupRecurringDb();
  t.after(() => db.close());

  const forecast = buildRecurringForecast(db, 1);
  const paycheck = forecast.occurrences.find((occurrence) => occurrence.pattern_id === 'paycheck');
  const rent = forecast.occurrences.find((occurrence) => occurrence.pattern_id === 'rent');

  assert.equal(paycheck?.amount, 2000);
  assert.equal(paycheck?.is_income, true);
  assert.equal(rent?.amount, -1000);
  assert.equal(rent?.is_income, false);
});
