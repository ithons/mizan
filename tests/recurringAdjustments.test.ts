import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  deleteRecurringAdjustment,
  listRecurringAdjustments,
  upsertRecurringAdjustment,
} from '../server/src/services/recurringAdjustments';

function setupDb(): Database.Database {
  const db = new Database(':memory:');

  db.exec(`
    CREATE TABLE recurring_patterns (
      id TEXT PRIMARY KEY,
      merchant_name TEXT NOT NULL,
      category_id TEXT,
      average_amount REAL NOT NULL,
      amount_variance REAL NOT NULL DEFAULT 0,
      frequency TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      next_expected TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      is_confirmed INTEGER NOT NULL DEFAULT 0,
      transaction_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE recurring_occurrence_adjustments (
      id TEXT PRIMARY KEY,
      recurring_id TEXT NOT NULL,
      original_date TEXT NOT NULL,
      action TEXT NOT NULL,
      adjusted_date TEXT,
      adjusted_amount REAL,
      note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(recurring_id, original_date)
    );
  `);

  db.prepare(`
    INSERT INTO recurring_patterns (
      id, merchant_name, category_id, average_amount, frequency, last_seen, next_expected,
      is_active, is_confirmed, transaction_count
    )
    VALUES ('rent', 'Rent', NULL, 1000, 'monthly', '2026-06-01', '2026-07-01', 1, 1, 4)
  `).run();

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
