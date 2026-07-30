import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { format, lastDayOfMonth, parseISO, subMonths } from 'date-fns';
import {
  deleteRecurringAdjustment,
  listRecurringAdjustments,
  upsertRecurringAdjustment,
} from '../server/src/services/recurringAdjustments';
import { buildRecurringForecast } from '../server/src/services/recurringForecast';
import { migratedTestDb } from './helpers/schema';

// The migrated schema, not a hand-written one: adjustments are keyed by (recurring_id,
// original_date) with a UNIQUE constraint and a foreign key, and the last test here depends on the
// forecast producing exactly the date the adjustment was filed under.

function insertPattern(
  db: Database.Database,
  overrides: Partial<{ id: string; next_expected: string; frequency: string; average_amount: number }> = {}
): string {
  const id = overrides.id ?? 'rent';
  const nextExpected = overrides.next_expected ?? '2026-07-01';
  db.prepare(`
    INSERT INTO recurring_patterns (
      id, merchant_name, category_id, average_amount, frequency, last_seen, next_expected,
      is_active, is_confirmed, transaction_count, created_at, updated_at
    )
    VALUES (?, ?, 'cat_home_rent', ?, ?, ?, ?, 1, 1, 4, '2026-01-01', '2026-01-01')
  `).run(
    id,
    id,
    overrides.average_amount ?? 1000,
    overrides.frequency ?? 'monthly',
    nextExpected,
    nextExpected
  );
  return id;
}

function setupDb(): Database.Database {
  const db = migratedTestDb();
  insertPattern(db);
  return db;
}

test('recurring adjustments upsert and delete by original occurrence date', (t) => {
  const db = setupDb();
  t.after(() => db.close());

  const snooze = upsertRecurringAdjustment(db, 'rent', {
    original_date: '2026-07-01',
    action: 'snooze',
    adjusted_date: '2026-07-03',
    note: 'travel',
  });

  assert.equal(snooze.action, 'snooze');
  assert.equal(snooze.adjusted_date, '2026-07-03');
  assert.equal(listRecurringAdjustments(db, 'rent').length, 1);

  const adjusted = upsertRecurringAdjustment(db, 'rent', {
    original_date: '2026-07-01',
    action: 'adjust',
    adjusted_amount: -900,
  });

  assert.equal(adjusted.id, snooze.id);
  assert.equal(adjusted.action, 'adjust');
  assert.equal(adjusted.adjusted_amount, -90000);
  assert.equal(adjusted.adjusted_date, null);
  assert.equal(listRecurringAdjustments(db, 'rent').length, 1);
  assert.equal(deleteRecurringAdjustment(db, 'rent', adjusted.id), true);
  assert.equal(listRecurringAdjustments(db, 'rent').length, 0);
});

test('recurring adjustments validate action-specific fields', (t) => {
  const db = setupDb();
  t.after(() => db.close());

  assert.throws(() => upsertRecurringAdjustment(db, 'rent', {
    original_date: '2026-07-01',
    action: 'snooze',
  }), /adjusted_date is required/);

  assert.throws(() => upsertRecurringAdjustment(db, 'rent', {
    original_date: '2026-07-01',
    action: 'adjust',
  }), /adjusted_amount is required/);

  assert.throws(() => upsertRecurringAdjustment(db, 'missing', {
    original_date: '2026-07-01',
    action: 'skip',
  }), /Recurring pattern not found/);
});

// An adjustment is looked up as `${pattern.id}:${originalDate}`, so it only lands if the forecast
// generates exactly that date. While the walk chained addMonths, a month-end pattern drifted onto
// the 28th after the first short month, and every skip or snooze the owner filed against the real
// month-end silently did nothing.
test('an adjustment filed on a month-end occurrence is applied', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const anchor = (() => {
    for (let back = 0; back < 14; back++) {
      const end = lastDayOfMonth(subMonths(new Date(), back));
      if (end.getDate() === 31 && end <= new Date()) return end;
    }
    throw new Error('no month end found');
  })();

  insertPattern(db, {
    id: 'month_end_rent',
    next_expected: format(anchor, 'yyyy-MM-dd'),
    average_amount: 150000,
  });

  const upcoming = buildRecurringForecast(db, 130).occurrences
    .filter((occurrence) => occurrence.pattern_id === 'month_end_rent' && occurrence.status === 'upcoming');
  assert.ok(upcoming.length >= 2);

  // The third month out: far enough past the anchor that the old chained walk had already clamped.
  const target = upcoming[upcoming.length - 1];
  assert.equal(target.expected_date, format(lastDayOfMonth(parseISO(target.expected_date)), 'yyyy-MM-dd'));

  upsertRecurringAdjustment(db, 'month_end_rent', {
    original_date: target.expected_date,
    action: 'skip',
  });

  const applied = buildRecurringForecast(db, 130).occurrences
    .find((occurrence) => occurrence.id === target.id);
  assert.equal(applied?.adjustment_action, 'skip');
});
