import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { addMonths, format, subDays, subMonths } from 'date-fns';
import { _setDbForTesting } from '../server/src/db/index';
import { detectRecurring } from '../server/src/services/recurring';
import { insertAccount, insertTransaction, migratedTestDb } from './helpers/schema';

// detectRecurring() runs on the module singleton and had no direct test: it's one of the
// riskiest untested services (heuristic grouping + frequency classification + variance gates).
// These lock its current behavior so a future semi-monthly/cadence improvement has a net.
//
// It runs against the migrated schema rather than a hand-written one because three of the bugs
// below were invisible to a hand-written table: the FOREIGN KEY on recurring_patterns.category_id,
// the INTEGER-cents average_amount, and the seeded category taxonomy the majority vote reads.

function setupDb(): Database.Database {
  const db = migratedTestDb();
  _setDbForTesting(db);
  return db;
}

function teardown(db: Database.Database): void {
  _setDbForTesting(undefined as unknown as Database.Database);
  db.close();
}

/** Insert `count` transactions for `merchant`, `gapDays` apart, ending `endDaysAgo` before today. */
function seedSeries(
  db: Database.Database,
  merchant: string,
  amountCents: number,
  gapDays: number,
  count: number,
  options: { endDaysAgo?: number; categoryId?: string | null } = {}
): void {
  const accountId = insertAccount(db);
  for (let i = 0; i < count; i++) {
    const daysAgo = (options.endDaysAgo ?? 0) + gapDays * (count - 1 - i);
    insertTransaction(db, {
      id: `${merchant}_${i}`,
      account_id: accountId,
      date: format(subDays(new Date(), daysAgo), 'yyyy-MM-dd'),
      amount: amountCents,
      merchant_name: merchant,
      original_name: merchant.toUpperCase(),
      category_id: options.categoryId ?? null,
    });
  }
}

/** Insert one transaction per element of `dates`, pairing each with the matching `amounts` entry. */
function seedDates(
  db: Database.Database,
  merchant: string,
  rows: Array<{ date: string; amount: number; categoryId?: string | null }>
): void {
  const accountId = insertAccount(db);
  rows.forEach((row, i) => {
    insertTransaction(db, {
      id: `${merchant}_${i}`,
      account_id: accountId,
      date: row.date,
      amount: row.amount,
      merchant_name: merchant,
      original_name: merchant.toUpperCase(),
      category_id: row.categoryId ?? null,
    });
  });
}

function patternFor(db: Database.Database, merchant: string): Record<string, unknown> | undefined {
  return db.prepare('SELECT * FROM recurring_patterns WHERE merchant_name = ?').get(merchant) as
    | Record<string, unknown>
    | undefined;
}

/** The most recent occurrence of `dayOfMonth` that has already happened, as YYYY-MM-DD. */
function lastAnchorOn(dayOfMonth: number): Date {
  const today = new Date();
  const thisMonth = new Date(today.getFullYear(), today.getMonth(), dayOfMonth);
  return thisMonth > today ? subMonths(thisMonth, 1) : thisMonth;
}

test('detects a monthly pattern and links its transactions', () => {
  const db = setupDb();
  try {
    seedSeries(db, 'Netflix', -1599, 30, 4);
    detectRecurring();

    const rows = db.prepare('SELECT * FROM recurring_patterns').all() as Array<Record<string, unknown>>;
    assert.equal(rows.length, 1);
    const p = rows[0];
    assert.equal(p.merchant_name, 'netflix'); // normalizeMerchant lowercases
    assert.equal(p.frequency, 'monthly');
    assert.equal(p.average_amount, 1599); // median of abs amounts, stays cents
    assert.equal(p.transaction_count, 4);
    assert.equal(p.is_active, 1);
    assert.equal(p.is_confirmed, 0);

    const linked = db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE recurring_id = ?').get(p.id) as { n: number };
    assert.equal(linked.n, 4);
  } finally {
    teardown(db);
  }
});

test('detects a biweekly pattern (~14-day gaps)', () => {
  const db = setupDb();
  try {
    seedSeries(db, 'Gym', -4000, 14, 4);
    detectRecurring();
    assert.equal(patternFor(db, 'gym')?.frequency, 'biweekly');
  } finally {
    teardown(db);
  }
});

test('a weekly pattern with one forgotten occurrence still detects as weekly', () => {
  const db = setupDb();
  try {
    // Occurrences at 28, 21, 14, 0 days ago: the day-7 entry is missing, leaving a single
    // 14-day gap among 7-day gaps. Without skip-tolerance the gap variance rejects this.
    seedDates(db, 'blue bottle', [28, 21, 14, 0].map((d) => ({
      date: format(subDays(new Date(), d), 'yyyy-MM-dd'),
      amount: -650,
    })));
    detectRecurring();
    const p = patternFor(db, 'blue bottle');
    assert.equal(p?.frequency, 'weekly');
    assert.equal(p?.transaction_count, 4);
  } finally {
    teardown(db);
  }
});

test('requires at least 3 transactions', () => {
  const db = setupDb();
  try {
    seedSeries(db, 'Rare', -2000, 30, 2);
    detectRecurring();
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM recurring_patterns').get() as { n: number }).n, 0);
  } finally {
    teardown(db);
  }
});

test('rejects irregular gaps (high gap variance)', () => {
  const db = setupDb();
  try {
    // Same merchant, deliberately erratic spacing: gaps 4, 45, 10 days.
    seedDates(db, 'erratic', [59, 55, 10, 0].map((d) => ({
      date: format(subDays(new Date(), d), 'yyyy-MM-dd'),
      amount: -2500,
    })));
    detectRecurring();
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM recurring_patterns').get() as { n: number }).n, 0);
  } finally {
    teardown(db);
  }
});

// This pair replaces an earlier test that rejected ANY pattern with amount CV >= 0.25. That gate
// threw away the most valuable recurring items on real data: a weekly paycheck tracking hours
// (gap CV 0.11, amount CV 0.43), a monthly interest credit, a utility bill. A varying amount is now
// disqualifying only when the cadence is also loose.
test('admits a varying amount when the cadence is rigid, and records the variance', () => {
  const db = setupDb();
  try {
    // Exactly-monthly cadence (gap CV 0), amounts all over the place: the paycheck shape.
    const amts = [-1000, -9000, -2000, -8000];
    seedDates(db, 'varamt', amts.map((amount, i) => ({
      date: format(subDays(new Date(), 30 * (amts.length - 1 - i)), 'yyyy-MM-dd'),
      amount,
    })));
    detectRecurring();

    const p = patternFor(db, 'varamt');
    assert.equal(p?.frequency, 'monthly');
    // Recorded, not discarded: the forecast renders this as "~$X · varies" rather than a firm bill.
    assert.ok((p?.amount_variance as number) >= 0.25);
  } finally {
    teardown(db);
  }
});

test('still rejects a varying amount when the cadence is only loosely regular', () => {
  const db = setupDb();
  try {
    // Gaps 30/22/38/30 -> gap CV ~0.19: regular enough to pass the base gate, too loose to earn the
    // variable-amount exception. Amount CV ~0.71.
    const offsets = [120, 90, 68, 30, 0];
    const amts = [-1000, -9000, -2000, -8000, -1500];
    seedDates(db, 'loose', offsets.map((off, i) => ({
      date: format(subDays(new Date(), off), 'yyyy-MM-dd'),
      amount: amts[i],
    })));
    detectRecurring();
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM recurring_patterns').get() as { n: number }).n, 0);
  } finally {
    teardown(db);
  }
});

test('detection ignores transfers and confirmed duplicates', () => {
  const db = setupDb();
  try {
    // A card payment: rigid monthly cadence, wild amount. Without the exclusion the relaxed gate
    // would book it as a recurring bill and double-count the spending it settles.
    const accountId = insertAccount(db);
    const amts = [-69300, -146500, -55200, -109600];
    amts.forEach((amount, i) => {
      const id = insertTransaction(db, {
        id: `pay_${i}`,
        account_id: accountId,
        date: format(subDays(new Date(), 30 * (amts.length - 1 - i)), 'yyyy-MM-dd'),
        amount,
        merchant_name: 'Payment Thank You',
        original_name: 'PAYMENT THANK YOU',
      });
      db.prepare("UPDATE transactions SET transfer_status = 'confirmed' WHERE id = ?").run(id);
    });
    detectRecurring();
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM recurring_patterns').get() as { n: number }).n, 0);
  } finally {
    teardown(db);
  }
});

// merchant_name is UNIQUE and detection upserts against it, so changing normalizeMerchant()
// renames the group and strands the old row: inactive, unconfirmed, pointing at nothing. The
// live DB accumulated two rows for one Cursor subscription that way, and migration 029
// hand-deleted an earlier one. Detection now clears them itself.
test('detection removes stranded patterns but keeps confirmed and manual ones', () => {
  const db = setupDb();
  try {
    const recent = format(subDays(new Date(), 3), 'yyyy-MM-dd');
    const ins = db.prepare(`
      INSERT INTO recurring_patterns
        (id, merchant_name, category_id, average_amount, amount_variance, frequency, last_seen,
         next_expected, is_active, is_confirmed, transaction_count, created_at, updated_at)
      VALUES (?, ?, NULL, ?, 0, 'monthly', ?, ?, ?, ?, ?, '2024-01-01', '2024-01-01')
    `);
    //         id          merchant_name                     amt   last_seen     next        active confirmed count
    ins.run('stranded', 'cursor ai powered ide 8314259504', 2125, '2024-01-01', '2024-02-01', 0, 0, 0);
    ins.run('confirmed', 'spotify',                          699, '2024-01-01', '2024-02-01', 0, 1, 0);
    ins.run('active',    'trupanion',                       3902, recent,        recent,      1, 0, 5);

    detectRecurring();

    const surviving = (db.prepare('SELECT id FROM recurring_patterns ORDER BY id').all() as Array<{ id: string }>)
      .map((r) => r.id);
    assert.ok(!surviving.includes('stranded'), 'the renamed leftover is gone');
    assert.ok(surviving.includes('confirmed'), 'a confirmed pattern is the user\'s own decision');
    assert.ok(surviving.includes('active'), 'an active pattern stays');
  } finally {
    teardown(db);
  }
});

// Detection never wrote category_id, so all 11 patterns on the live database carried NULL and
// budgetProjection's `rp.category_id IS NOT NULL` filter dropped every one of them: expected_recurring
// was 0 and forecast_confidence 'none' for every budget in every month.
test('a detected pattern takes the majority category of its own transactions', () => {
  const db = setupDb();
  try {
    seedSeries(db, 'Backblaze', -1803, 30, 4, { categoryId: 'cat_sub_software' });
    detectRecurring();
    assert.equal(patternFor(db, 'backblaze')?.category_id, 'cat_sub_software');
  } finally {
    teardown(db);
  }
});

test('a clear majority wins over a minority, and uncategorized rows abstain', () => {
  const db = setupDb();
  try {
    seedDates(db, 'mixed', [120, 90, 60, 30, 0].map((d, i) => ({
      date: format(subDays(new Date(), d), 'yyyy-MM-dd'),
      amount: -1500,
      // 3 software, 1 streaming, 1 uncategorized: 3 of the 4 votes cast is a majority.
      categoryId: i < 3 ? 'cat_sub_software' : i === 3 ? 'cat_ent_streaming' : null,
    })));
    detectRecurring();
    assert.equal(patternFor(db, 'mixed')?.category_id, 'cat_sub_software');
  } finally {
    teardown(db);
  }
});

test('a tie records no category rather than picking one', () => {
  const db = setupDb();
  try {
    seedDates(db, 'split', [90, 60, 30, 0].map((d, i) => ({
      date: format(subDays(new Date(), d), 'yyyy-MM-dd'),
      amount: -1500,
      categoryId: i % 2 === 0 ? 'cat_sub_software' : 'cat_ent_streaming',
    })));
    detectRecurring();
    assert.equal(patternFor(db, 'split')?.category_id, null);
  } finally {
    teardown(db);
  }
});

test('a plurality short of half records no category either', () => {
  const db = setupDb();
  try {
    const categories = ['cat_sub_software', 'cat_sub_software', 'cat_ent_streaming', 'cat_ent_streaming', 'cat_pets'];
    seedDates(db, 'threeway', [120, 90, 60, 30, 0].map((d, i) => ({
      date: format(subDays(new Date(), d), 'yyyy-MM-dd'),
      amount: -1500,
      categoryId: categories[i],
    })));
    detectRecurring();
    assert.equal(patternFor(db, 'threeway')?.category_id, null);
  } finally {
    teardown(db);
  }
});

// A category the owner picked on the Bills screen (PATCH /api/recurring/:id) is not derived from
// the rows, so it appears on none of them. Detection runs every sync; re-deriving over it would
// revert the choice on the hour.
test('detection does not overwrite a category set by hand', () => {
  const db = setupDb();
  try {
    seedSeries(db, 'Backblaze', -1803, 30, 4, { categoryId: 'cat_sub_software' });
    detectRecurring();
    db.prepare("UPDATE recurring_patterns SET category_id = 'cat_shop' WHERE merchant_name = 'backblaze'").run();

    detectRecurring();
    assert.equal(patternFor(db, 'backblaze')?.category_id, 'cat_shop');
  } finally {
    teardown(db);
  }
});

// category_id is a FOREIGN KEY. Writing an id a later migration deleted raises "FOREIGN KEY
// constraint failed" and takes the whole detection pass down, the failure knownCategoryIds guards
// against in rules.ts.
test('a category a migration deleted is dropped, not rewritten', () => {
  const db = setupDb();
  try {
    seedSeries(db, 'Backblaze', -1803, 30, 4, { categoryId: 'cat_sub_software' });
    detectRecurring();
    assert.equal(patternFor(db, 'backblaze')?.category_id, 'cat_sub_software');

    db.pragma('foreign_keys = OFF');
    db.prepare("DELETE FROM categories WHERE id = 'cat_sub_software'").run();
    db.pragma('foreign_keys = ON');

    assert.doesNotThrow(() => detectRecurring());
    assert.equal(patternFor(db, 'backblaze')?.category_id, null);
  } finally {
    teardown(db);
  }
});

// Backblaze charges on the 17th of every month. Its gaps [28,31,30,31,30] have a median of 30, so
// anchoring on the day-gap put the next charge on the 16th: the Bills screen called it due a day
// early, and on the 17th, its real due date, the forecast called the same charge overdue.
test('a monthly bill is anchored by day-of-month, not by the median day-gap', () => {
  const db = setupDb();
  try {
    const anchor = lastAnchorOn(17);
    seedDates(db, 'backblaze', [5, 4, 3, 2, 1, 0].map((back) => ({
      date: format(subMonths(anchor, back), 'yyyy-MM-dd'),
      amount: -1803,
    })));
    detectRecurring();

    const p = patternFor(db, 'backblaze');
    assert.equal(p?.frequency, 'monthly');
    assert.equal(p?.next_expected, format(addMonths(anchor, 1), 'yyyy-MM-dd'));
    assert.equal(String(p?.next_expected).slice(8), '17');
  } finally {
    teardown(db);
  }
});

test('a weekly bill still steps by the median day-gap', () => {
  const db = setupDb();
  try {
    seedSeries(db, 'Coffee Club', -650, 7, 5);
    detectRecurring();

    const p = patternFor(db, 'coffee club');
    assert.equal(p?.frequency, 'weekly');
    assert.equal(p?.next_expected, format(subDays(new Date(), -7), 'yyyy-MM-dd'));
  } finally {
    teardown(db);
  }
});

// The live payroll pattern stored $398.93 (a median over its whole history, still outvoted by a
// year of smaller stipend checks) while the forecast recomputed $476.91 (a mean over that same
// history, dragged up by one $1,048.77 bonus), and the last four checks were all $544.18.
test('the stored amount is a median of recent occurrences, not of the whole history', () => {
  const db = setupDb();
  try {
    const amounts = [30000, 30000, 30000, 30000, 30000, 30000, 100000, 54418, 54418, 54418, 54418];
    seedDates(db, 'mass inst payroll', amounts.map((amount, i) => ({
      date: format(subDays(new Date(), 7 * (amounts.length - 1 - i)), 'yyyy-MM-dd'),
      amount,
      categoryId: 'cat_income_paycheck',
    })));
    detectRecurring();

    const p = patternFor(db, 'mass inst payroll');
    assert.equal(p?.average_amount, 54418);
    assert.equal(p?.category_id, 'cat_income_paycheck');
  } finally {
    teardown(db);
  }
});

/**
 * A dismissed bill stays dismissed, across as many detection passes as you like.
 *
 * `POST /api/recurring/:id/dismiss` sets `is_active = 0, is_confirmed = 0` and NULLs
 * `recurring_id` on every linked transaction. `detectRecurring` honoured that state and then, at
 * the end of the same function, deleted rows matching exactly that predicate plus "has no linked
 * transactions", which the unlinking had just made true. So the record of the decision was gone by
 * the next sync and the merchant was detected fresh on the one after. Migration 057 adds
 * `dismissed_at` to tell a dismissal apart from the rename-stranded rows that delete exists for.
 */
function dismissPattern(db: Database.Database, id: string): void {
  const now = '2026-09-01T00:00:00.000Z';
  db.prepare(
    'UPDATE recurring_patterns SET is_active = 0, is_confirmed = 0, dismissed_at = ?, updated_at = ? WHERE id = ?'
  ).run(now, now, id);
  db.prepare('UPDATE transactions SET recurring_id = NULL, updated_at = ? WHERE recurring_id = ?').run(now, id);
}

test('a dismissed pattern survives repeated detection and never comes back', () => {
  const db = setupDb();
  try {
    // A clean monthly bill, seeded relative to today the way every other test in this file does,
    // because detection windows off the wall clock.
    seedSeries(db, 'Netflix', -1599, 30, 4);
    detectRecurring();

    const found = patternFor(db, 'netflix');
    assert.ok(found, 'detection never found the pattern, so this test proves nothing');
    dismissPattern(db, found.id as string);

    // The pass that used to delete the decision, and the two after it that used to re-detect.
    detectRecurring();
    detectRecurring();
    detectRecurring();

    const rows = db
      .prepare("SELECT is_active, dismissed_at FROM recurring_patterns WHERE merchant_name = 'netflix'")
      .all() as Array<{ is_active: number; dismissed_at: string | null }>;

    assert.equal(rows.length, 1, 'the dismissal record was deleted and the pattern re-created');
    assert.equal(rows[0].is_active, 0, 'a dismissed pattern was reactivated');
    assert.ok(rows[0].dismissed_at, 'the dismissal marker was lost');
  } finally {
    teardown(db);
  }
});

test('HEALTHY: a genuinely stranded pattern is still cleaned up', () => {
  const db = setupDb();
  try {
    // The case the delete exists for: `merchant_name` is UNIQUE and detection upserts against it,
    // so renaming a group in normalizeMerchant() leaves the old row behind with nothing linked.
    // It was never dismissed, so it must still be removed.
    db.prepare(`
      INSERT INTO recurring_patterns
        (id, merchant_name, average_amount, frequency, last_seen, next_expected,
         is_active, is_confirmed, transaction_count, created_at, updated_at)
      VALUES ('stranded', 'old cursor name', 2000, 'monthly', '2026-05-01', '2026-06-01', 0, 0, 0,
              '2026-05-01', '2026-05-01')
    `).run();

    detectRecurring();

    const left = db.prepare("SELECT COUNT(*) AS n FROM recurring_patterns WHERE id = 'stranded'").get() as {
      n: number;
    };
    assert.equal(left.n, 0, 'the stranded-row cleanup stopped working');
  } finally {
    teardown(db);
  }
});
