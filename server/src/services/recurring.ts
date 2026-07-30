import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import {
  differenceInDays,
  addDays,
  addMonths,
  addQuarters,
  addYears,
  format,
  parseISO,
  subMonths,
} from 'date-fns';
import { getDb } from '../db/index';
import { compareTwoStrings } from "string-similarity";
import { toCents } from './money';
import { excludedFromTotalsSql } from './transactionFilters';

export type RecurringFrequency = 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'annual';

export interface CreateRecurringPatternInput {
  merchant_name: string;
  frequency: RecurringFrequency;
  average_amount: number;
  next_expected: string;
  category_id?: string | null;
}

function httpError(message: string, status: number): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

/**
 * Create a user-defined recurring pattern. Manual patterns are stored confirmed
 * (transaction_count 0) so they surface in the forecast immediately. Income vs. bill
 * is derived downstream from the assigned category's is_income flag.
 */
export function createRecurringPattern(db: Database.Database, input: CreateRecurringPatternInput): string {
  const name = input.merchant_name.trim();
  if (!name) throw httpError('Name is required', 400);

  const existing = db.prepare('SELECT id FROM recurring_patterns WHERE merchant_name = ?').get(name);
  if (existing) throw httpError('A recurring item with that name already exists', 409);

  if (input.category_id) {
    const category = db.prepare('SELECT id FROM categories WHERE id = ?').get(input.category_id);
    if (!category) throw httpError('Category not found', 400);
  }

  const id = uuidv4();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO recurring_patterns
      (id, merchant_name, category_id, frequency, average_amount, last_seen, next_expected,
       is_active, is_confirmed, transaction_count, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, 0, ?, ?)
  `).run(
    id,
    name,
    input.category_id ?? null,
    input.frequency,
    toCents(Math.abs(input.average_amount)),
    input.next_expected,
    input.next_expected,
    now,
    now,
  );

  return id;
}


const US_STATES = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY','DC',
]);

const STRIP_SUFFIXES = /\b(llc|inc|corp|co|ltd)\b/gi;
const STRIP_TRAILING_DIGITS = /\s+\d+$/;
const STRIP_HASH_DIGITS = /\s*#\d+/g;
const STRIP_PUNCTUATION = /[^\w\s]/g;

// Aggressive on purpose: strips store numbers, corporate suffixes, and trailing state codes so a
// merchant's variants ("STARBUCKS #1234 WA", "STARBUCKS #5678 OR") group into one recurring
// pattern. This is intentionally stronger than transactionIntegrity.normalizeMerchant, which must
// stay minimal to avoid merging distinct charges into false duplicates. Keep them separate.
function normalizeMerchant(name: string): string {
  let n = name.toLowerCase().trim();
  n = n.replace(STRIP_PUNCTUATION, ' ');
  n = n.replace(STRIP_HASH_DIGITS, '');
  n = n.replace(STRIP_SUFFIXES, '');
  n = n.replace(STRIP_TRAILING_DIGITS, '');

  // Strip trailing US state abbreviations
  const words = n.trim().split(/\s+/);
  while (words.length > 0 && US_STATES.has(words[words.length - 1].toUpperCase())) {
    words.pop();
  }
  n = words.join(' ').trim();

  // Collapse multiple spaces
  n = n.replace(/\s+/g, ' ').trim();
  return n;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * How many recent occurrences the expected amount is estimated from.
 *
 * A median over the pattern's whole history said $398.93 for a payroll that had paid $544.18 four
 * times running: a year of smaller stipend checks still outvoted the raise. The mean the forecast
 * computed over that same history said $476.91, dragged up by one $1,048.77 bonus. A median over a
 * short recent window survives both the stale history and the outlier.
 */
export const RECENT_AMOUNT_WINDOW = 6;

/**
 * The expected amount per occurrence, signed, keyed by pattern id.
 *
 * detectRecurring writes this same statistic over this same window into `average_amount`, so the
 * Bills list (which renders the stored column) and the forecast (which recomputes here) quote one
 * number. They used to disagree by $78 on the live payroll pattern, both on screen at once.
 *
 * Only `pending` is filtered: detection already applied excludedFromTotalsSql before linking these
 * rows, so a transfer or a confirmed duplicate never carries a recurring_id to begin with.
 */
export function recentSignedAmounts(
  db: Database.Database,
  patternIds: string[]
): Map<string, number> {
  if (patternIds.length === 0) return new Map();

  const placeholders = patternIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT recurring_id, amount
    FROM transactions
    WHERE recurring_id IN (${placeholders})
      AND pending = 0
    ORDER BY recurring_id ASC, date DESC, id DESC
  `).all(...patternIds) as Array<{ recurring_id: string; amount: number }>;

  const windows = new Map<string, number[]>();
  for (const row of rows) {
    const window = windows.get(row.recurring_id);
    if (!window) windows.set(row.recurring_id, [row.amount]);
    else if (window.length < RECENT_AMOUNT_WINDOW) window.push(row.amount);
  }

  return new Map(
    Array.from(windows, ([id, amounts]): [string, number] => [id, Math.round(median(amounts))])
  );
}

/**
 * The k-th occurrence after `anchor`, always measured from the anchor itself.
 *
 * Chaining addMonths one step at a time walks a month-end bill backwards and never lets it
 * recover: from 01-31 it yields 02-28, then 03-28 where the answer is 03-31, and it stays on the
 * 28th forever. Rent anchored on the 31st was shown due, flagged overdue, and dropped out of the
 * month's budget projection three days early, every month.
 */
export function occurrenceDate(anchor: Date, frequency: RecurringFrequency, step: number): Date {
  switch (frequency) {
    case 'weekly':
      return addDays(anchor, 7 * step);
    case 'biweekly':
      return addDays(anchor, 14 * step);
    case 'monthly':
      return addMonths(anchor, step);
    case 'quarterly':
      return addQuarters(anchor, step);
    case 'annual':
      return addYears(anchor, step);
  }
}

/**
 * Where the next occurrence lands after `lastDate`.
 *
 * Monthly and longer cadences are anchored by day-of-month rather than by the median day-gap.
 * Backblaze charges on the 17th; its gaps [28,31,30,31,30] have a median of 30, so adding days put
 * the next charge on 08-16. The Bills screen called it due on the 16th, and then on the 17th, its
 * real due date, the forecast called the same charge overdue. addMonths clamps short months itself.
 */
function nextExpectedAfter(
  lastDate: string,
  frequency: RecurringFrequency,
  medianGap: number
): string {
  const last = parseISO(lastDate);
  const next = frequency === 'weekly' || frequency === 'biweekly'
    ? addDays(last, Math.round(medianGap))
    : occurrenceDate(last, frequency, 1);
  return format(next, 'yyyy-MM-dd');
}

// Writing a category_id that no longer resolves raises "FOREIGN KEY constraint failed" and takes
// the whole detection pass down with it, the failure knownCategoryIds guards against in rules.ts.
function knownCategoryIds(db: Database.Database): Set<string> {
  return new Set(
    (db.prepare('SELECT id FROM categories').all() as Array<{ id: string }>).map((row) => row.id)
  );
}

/**
 * The category a clear majority of a pattern's own transactions already carry.
 *
 * NULL on a tie is deliberate. budgetProjection turns this category into a budget's
 * expected_recurring, so a merchant whose charges genuinely straddle two categories has to feed
 * neither rather than an arbitrary winner. Uncategorized rows abstain instead of voting against:
 * they say nothing about which category is right.
 */
function majorityCategoryId(categoryIds: Array<string | null>, known: Set<string>): string | null {
  const counts = new Map<string, number>();
  for (const id of categoryIds) {
    if (!id || !known.has(id)) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  let winner: string | null = null;
  let best = 0;
  let total = 0;
  for (const [id, count] of counts) {
    total += count;
    if (count > best) {
      best = count;
      winner = id;
    }
  }

  return best * 2 > total ? winner : null;
}

/**
 * Which category the pattern row should end up carrying.
 *
 * A stored category that appears on none of the pattern's own transactions was set by hand on the
 * Bills screen (PATCH /api/recurring/:id). Detection re-runs on every sync, so re-deriving over it
 * would revert the owner's choice on the hour. A stored id that no longer resolves is dropped
 * rather than rewritten, so a category a later migration deleted cannot dangle here.
 */
function resolvePatternCategory(
  stored: string | null,
  majority: string | null,
  observed: Set<string>,
  known: Set<string>
): string | null {
  const storedIsKnown = Boolean(stored && known.has(stored));
  if (stored && storedIsKnown && !observed.has(stored)) return stored;
  if (majority) return majority;
  return storedIsKnown ? stored : null;
}

const GAP_VARIANCE_MAX = 0.2;
const AMOUNT_VARIANCE_MAX = 0.25;
/** Cadence bar a pattern must clear to be admitted on timing alone, with a variable amount. */
const STRICT_GAP_VARIANCE_MAX = 0.15;

function classifyFrequency(
  medianGap: number
): 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'annual' | null {
  if (medianGap >= 5 && medianGap <= 9) return 'weekly';
  if (medianGap >= 12 && medianGap <= 16) return 'biweekly';
  if (medianGap >= 27 && medianGap <= 33) return 'monthly';
  if (medianGap >= 85 && medianGap <= 95) return 'quarterly';
  if (medianGap >= 355 && medianGap <= 375) return 'annual';
  return null;
}

function variance(values: number[], med: number): number {
  if (values.length === 0 || med === 0) return 0;
  // Coefficient of variation: std_dev / mean, using median as center
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean === 0) return 0;
  const variance =
    values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
  const stdDev = Math.sqrt(variance);
  return stdDev / Math.abs(mean);
}

export function detectRecurring(): void {
  const db = getDb();
  const cutoff = format(subMonths(new Date(), 13), 'yyyy-MM-dd');
  const today = format(new Date(), 'yyyy-MM-dd');

  interface TxnRow {
    id: string;
    date: string;
    amount: number;
    merchant_name: string | null;
    original_name: string;
    category_id: string | null;
  }

  // 1. Load all non-pending transactions from last 13 months.
  //
  // Transfers and confirmed duplicates are excluded for the same reason every other total excludes
  // them: they are not spending. It also keeps the relaxed amount gate honest — card payments
  // ("PAYMENT THANK YOU", "AUTOMATIC PAYMENT") have a rigid monthly cadence and a wildly varying
  // amount, so they would otherwise be admitted as recurring bills and double-count against the
  // spending they are paying off.
  const transactions = db.prepare(`
    SELECT id, date, amount, merchant_name, original_name, category_id
    FROM transactions
    WHERE pending = 0
      AND date >= ?
      AND ${excludedFromTotalsSql()}
      AND COALESCE(category_id, '') NOT LIKE 'cat_xfer%'
    ORDER BY date ASC
  `).all(cutoff) as TxnRow[];

  // 2. Group by normalized merchant name
  const groups = new Map<
    string,
    Array<{ id: string; date: string; amount: number; category_id: string | null }>
  >();
  const groupNames: string[] = [];


  for (const txn of transactions) {
    const raw = txn.merchant_name || txn.original_name;
    if (!raw) continue;
    let normalized = normalizeMerchant(raw);
    if (!normalized) continue;
    // Fuzzy matching: check if normalized name is very similar to an existing group
    let matchedGroup = normalized;
    let highestScore = 0;
    for (const gName of groupNames) {
      const score = compareTwoStrings(normalized, gName);
      if (score > highestScore) {
        highestScore = score;
        matchedGroup = score > 0.85 ? gName : normalized;
      }
    }
    normalized = matchedGroup;


    if (!groups.has(normalized)) {
      groupNames.push(normalized);

      groups.set(normalized, []);
    }
    groups.get(normalized)!.push({
      id: txn.id,
      date: txn.date,
      amount: txn.amount,
      category_id: txn.category_id,
    });
  }

  const known = knownCategoryIds(db);

  // 3. For each group with >= 3 transactions
  for (const [normalizedName, txns] of groups) {
    if (txns.length < 3) continue;

    // Sort by date ascending. The id tie-break is not cosmetic: the recent-amount window below has
    // to select the same rows recentSignedAmounts() selects in SQL, or the stored amount and the
    // recomputed one disagree again for two rows sharing a date.
    txns.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));

    // Compute day-gaps between consecutive dates
    const gaps: number[] = [];
    for (let i = 1; i < txns.length; i++) {
      const gap = differenceInDays(parseISO(txns[i].date), parseISO(txns[i - 1].date));
      gaps.push(gap);
    }

    const medianGap = median(gaps);
    const frequency = classifyFrequency(medianGap);
    if (!frequency) continue;

    const amounts = txns.map(t => Math.abs(t.amount));
    const medianAmount = median(amounts);

    // Tolerate occasional missed occurrences. A forgotten logging (or a skipped week) shows
    // up as a single gap that is a near-integer multiple of the base period; fold each gap
    // back to a per-occurrence gap before measuring regularity, so one skipped week doesn't
    // spike the variance and reject a genuinely weekly item. The median gap (robust to a few
    // skips) is the base; classification still uses it unchanged.
    const perOccurrenceGaps = medianGap > 0
      ? gaps.map((g) => g / Math.max(1, Math.round(g / medianGap)))
      : gaps;
    const gapVariance = variance(perOccurrenceGaps, medianGap);
    const amountVariance = variance(amounts, medianAmount);

    // An irregular cadence is disqualifying no matter how steady the amounts look — that is what
    // separates a subscription from a merchant you simply visit often (Chipotle, MBTA, DoorDash all
    // land here on real data).
    if (gapVariance >= GAP_VARIANCE_MAX) continue;

    // A moving amount is NOT disqualifying when the cadence is tight. Requiring both gates rejected
    // every variable-amount commitment: a weekly paycheck (gap CV 0.11, amount CV 0.43), a monthly
    // interest credit, a utility bill. The stricter cadence bar is the price of relaxing the amount.
    if (amountVariance >= AMOUNT_VARIANCE_MAX && gapVariance >= STRICT_GAP_VARIANCE_MAX) continue;

    const lastTxn = txns[txns.length - 1];
    const nextExpected = nextExpectedAfter(lastTxn.date, frequency, medianGap);
    // The stored amount is a short-window median, not the full-history one the variance gate above
    // needs: see RECENT_AMOUNT_WINDOW. Rounded because average_amount is integer cents.
    const expectedAmount = Math.round(
      median(txns.slice(-RECENT_AMOUNT_WINDOW).map((t) => Math.abs(t.amount)))
    );
    const observed = new Set(
      txns.map((t) => t.category_id).filter((id): id is string => Boolean(id))
    );
    const majority = majorityCategoryId(txns.map((t) => t.category_id), known);
    const now = new Date().toISOString();

    // Upsert recurring_pattern matching on merchant_name
    const existing = db.prepare(
      'SELECT id, is_active, is_confirmed, category_id FROM recurring_patterns WHERE merchant_name = ?'
    ).get(normalizedName) as
      | { id: string; is_active: number; is_confirmed: number; category_id: string | null }
      | undefined;

    let patternId: string;

    // Detection never wrote a category, so every detected pattern carried NULL and
    // budgetProjection's `rp.category_id IS NOT NULL` filter dropped all of them: every budget
    // reported expected_recurring 0 and forecast_confidence 'none' on real data.
    const categoryId = resolvePatternCategory(
      existing?.category_id ?? null,
      majority,
      observed,
      known
    );

    if (existing) {
      if (!existing.is_active && !existing.is_confirmed) continue;

      patternId = existing.id;
      db.prepare(`
        UPDATE recurring_patterns
        SET frequency = ?, category_id = ?, average_amount = ?, amount_variance = ?, last_seen = ?,
            next_expected = ?, transaction_count = ?, is_active = 1, updated_at = ?
        WHERE id = ?
      `).run(
        frequency,
        categoryId,
        expectedAmount,
        amountVariance,
        lastTxn.date,
        nextExpected,
        txns.length,
        now,
        patternId
      );
    } else {
      patternId = uuidv4();
      db.prepare(`
        INSERT INTO recurring_patterns
          (id, merchant_name, category_id, frequency, average_amount, amount_variance, last_seen,
           next_expected, is_active, is_confirmed, transaction_count, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?)
      `).run(
        patternId,
        normalizedName,
        categoryId,
        frequency,
        expectedAmount,
        amountVariance,
        lastTxn.date,
        nextExpected,
        txns.length,
        now,
        now
      );
    }

    // 5. Link matched transactions
    const ids = txns.map(t => t.id);
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(
      `UPDATE transactions SET recurring_id = ? WHERE id IN (${placeholders})`
    ).run(patternId, ...ids);
  }

  // 6. Deactivate stale patterns
  const allPatterns = db.prepare(`
    SELECT id, last_seen, frequency, average_amount
    FROM recurring_patterns
    WHERE is_active = 1
  `).all() as Array<{
    id: string;
    last_seen: string;
    frequency: string;
    average_amount: number;
  }>;

  // Map frequency to approximate days for stale check
  const freqDays: Record<string, number> = {
    weekly: 7,
    biweekly: 14,
    monthly: 30,
    quarterly: 91,
    annual: 365,
  };

  for (const pattern of allPatterns) {
    const approxGap = freqDays[pattern.frequency] || 30;
    const staleThreshold = format(
      addDays(parseISO(pattern.last_seen), 2 * approxGap),
      'yyyy-MM-dd'
    );
    if (staleThreshold < today) {
      db.prepare(
        'UPDATE recurring_patterns SET is_active = 0, updated_at = ? WHERE id = ?'
      ).run(new Date().toISOString(), pattern.id);
    }
  }

  // 7. Drop stranded patterns.
  //
  // merchant_name is UNIQUE and detection upserts against it, so any change to
  // normalizeMerchant() renames the group and leaves the old row behind forever, inactive and
  // pointing at nothing. The live DB accumulated two rows for the same Cursor subscription
  // that way; migration 029 hand-deleted an earlier one. Deleting them here removes the need
  // for the next hand-written migration.
  //
  // Deliberately narrow: only rows that are inactive AND unconfirmed AND have no transactions
  // still linked to them. A confirmed pattern is the user's own decision, and a manually
  // created one legitimately carries transaction_count = 0 (createRecurringPattern seeds it
  // confirmed so it shows up immediately), so both are excluded.
  const stranded = db.prepare(`
    DELETE FROM recurring_patterns
    WHERE is_active = 0
      AND is_confirmed = 0
      AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.recurring_id = recurring_patterns.id)
  `).run();
  if (stranded.changes > 0) {
    console.log(`[recurring] Removed ${stranded.changes} stranded pattern(s) with no linked transactions.`);
  }
}
