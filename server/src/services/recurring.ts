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
const PAYROLL_WORDS = /payroll|echeckpay|dir dep|direct dep|salary/i;
const ACH_IDS = /\b(?:ppd|ccd|web|tel|arc)\s*id\s*:?\s*\S+/gi;
const PAYER_NOISE = new Set([
  'payroll', 'echeckpay', 'dir', 'dep', 'direct', 'deposit', 'salary', 'ach', 'credit', 'edi',
  'pymnt', 'pymnts', 'payment', 'inc', 'llc', 'co', 'corp',
]);

/** Income that names an employer rather than a merchant. */
function isPayrollLike(txn: { amount: number; original_name: string; is_income: number | null }): boolean {
  return txn.amount > 0 && (txn.is_income === 1 || PAYROLL_WORDS.test(txn.original_name));
}

/**
 * The payer behind an ACH credit, with the clearing-house noise gone: "MASS INST PAYROLL PPD ID:
 * 9111111101" and "MASS. INST. OF T ECHECKPAY 00000000 CCD ID: 1042103594" both name MIT.
 */
export function payerKey(description: string): string {
  return description
    .toLowerCase()
    .replace(ACH_IDS, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((token) => token && !PAYER_NOISE.has(token) && !/^\d+$/.test(token))
    .join(' ');
}

/** One payer key extends the other ("mass inst" and "mass inst of t"), sharing at least two words. */
export function samePayer(a: string, b: string): boolean {
  const [short, long] = a.length <= b.length ? [a.split(' '), b.split(' ')] : [b.split(' '), a.split(' ')];
  return short.length >= 2 && short.every((token, i) => long[i] === token);
}

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
 * `pending` and the transfer-category predicate are filtered, and the second one is here because
 * the sentence that used to stand in its place was false. It said detection had already applied
 * its exclusions before linking these rows, "so a transfer never carries a recurring_id to begin
 * with". Detection's pool also excludes `category_id LIKE 'cat_xfer%'`, and nothing clears
 * `recurring_id` when a linked row is LATER recategorized into a transfer: on the live ledger four
 * rows carried both (`SELECT COUNT(*) FROM transactions WHERE recurring_id IS NOT NULL AND
 * COALESCE(category_id,'') LIKE 'cat_xfer%'` -> 4 on 2026-09-01). A transfer leg in the amount
 * window pulls a bill's estimate toward the transfer's size. The predicate is detection's own, so
 * the two agree about what a pattern is made of.
 */
export function recentSignedAmounts(
  db: Database.Database,
  patternIds: string[]
): Map<string, number> {
  return new Map(
    Array.from(recentExpectedAmounts(db, patternIds), ([id, expected]): [string, number] => [id, expected.amount])
  );
}

/** recentSignedAmounts, with the level shift that produced the figure when there was one. */
export function recentExpectedAmounts(
  db: Database.Database,
  patternIds: string[]
): Map<string, ExpectedAmount> {
  if (patternIds.length === 0) return new Map();

  const placeholders = patternIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT recurring_id, amount, date
    FROM transactions
    WHERE recurring_id IN (${placeholders})
      AND pending = 0
      AND COALESCE(category_id, '') NOT LIKE 'cat_xfer%'
    ORDER BY recurring_id ASC, date DESC, id DESC
  `).all(...patternIds) as Array<{ recurring_id: string; amount: number; date: string }>;

  const windows = new Map<string, Array<{ amount: number; date: string }>>();
  for (const row of rows) {
    const window = windows.get(row.recurring_id);
    if (!window) windows.set(row.recurring_id, [row]);
    else if (window.length < RECENT_AMOUNT_WINDOW) window.push(row);
  }

  return new Map(Array.from(windows, ([id, recent]): [string, ExpectedAmount] => [id, expectedAmount(recent)]));
}

export interface ExpectedAmount {
  /** Integer cents, signed as the rows are. */
  amount: number;
  /** The level the pattern moved off, when its last two occurrences left it together. */
  changedFrom: number | null;
  changedOn: string | null;
}

/** How far both of the last two occurrences must sit from the window median, in one direction. */
export const LEVEL_SHIFT_RATIO = 0.15;

function farFrom(level: number, value: number): -1 | 0 | 1 {
  if (Math.abs(value - level) <= LEVEL_SHIFT_RATIO * Math.abs(level)) return 0;
  return value > level ? 1 : -1;
}

/**
 * What the next occurrence should be, from the most recent ones (newest first).
 *
 * The window median survives an outlier and stale history, and is also what kept forecasting
 * $544.18 after pay dropped. Two occurrences in a row on the same side of it, both well off it, are
 * a new level rather than noise: forecast at their mean when they agree, and at the latest when
 * they do not. One odd occurrence, or two pulling opposite ways, leave the median in charge.
 */
export function expectedAmount(recent: ReadonlyArray<{ amount: number; date: string }>): ExpectedAmount {
  const window = recent.slice(0, RECENT_AMOUNT_WINDOW);
  const unchanged = { amount: Math.round(median(window.map((row) => row.amount))), changedFrom: null, changedOn: null };
  if (window.length < 4) return unchanged;

  // The level the last two are measured against is what came before them, and it is an amount
  // that was actually paid: the lower median, never a midpoint between two levels.
  const before = window.slice(2).map((row) => row.amount).sort((a, b) => a - b);
  const level = before[Math.floor((before.length - 1) / 2)];
  if (level === 0) return unchanged;

  const [latest, previous] = window;
  const direction = farFrom(level, latest.amount);
  if (direction === 0 || farFrom(level, previous.amount) !== direction) return unchanged;

  const agree = farFrom(latest.amount, previous.amount) === 0;
  return {
    amount: Math.round(agree ? (latest.amount + previous.amount) / 2 : latest.amount),
    changedFrom: Math.round(level),
    changedOn: latest.date,
  };
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
  medianGap: number,
  usualWeekday: number | null = null
): string {
  const last = parseISO(lastDate);
  if (frequency !== 'weekly' && frequency !== 'biweekly') {
    return format(occurrenceDate(last, frequency, 1), 'yyyy-MM-dd');
  }
  const next = addDays(last, Math.round(medianGap));
  if (usualWeekday === null) return format(next, 'yyyy-MM-dd');
  // A holiday pushes one occurrence a day late; the next lands back on the usual weekday.
  const shift = ((usualWeekday - next.getDay() + 10) % 7) - 3;
  return format(addDays(next, shift), 'yyyy-MM-dd');
}

/** The weekday a strict majority of the dates fall on, or null. */
export function usualWeekday(dates: readonly string[]): number | null {
  const counts = new Map<number, number>();
  for (const date of dates) {
    const day = parseISO(date).getDay();
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  for (const [day, count] of counts) if (count * 2 > dates.length) return day;
  return null;
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

/**
 * Coefficient of variation: standard deviation over the mean, centred on the MEAN.
 *
 * The comment here used to say "using median as center", which the code has never done: `med` is
 * only a guard against a degenerate series and every term below is centred on `mean`. Changing the
 * code to match the sentence would move the variance of every pattern and re-decide what gets
 * detected, which is a behaviour change and not a documentation fix. The sentence is corrected
 * instead, and the parameter's real job is stated.
 */
/**
 * How many bigrams `compareTwoStrings` sees in `s`: it strips whitespace first, then a string of
 * length n has n-1 bigrams. Mirrors the library so the bound in `detectRecurring` is exact; if
 * string-similarity ever changes its normalisation this and the test that pins it both move.
 */
export function bigramLength(s: string): number {
  return Math.max(0, s.replace(/\s+/g, '').length - 1);
}

function variance(values: number[], med: number): number {
  // `med` is a guard, not a centre: a series whose median is 0 has no scale to be a fraction of.
  if (values.length === 0 || med === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean === 0) return 0;
  const variance =
    values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
  const stdDev = Math.sqrt(variance);
  return stdDev / Math.abs(mean);
}

// Approximate days per period for the stale check: a pattern is stale two periods past its last charge.
const FREQUENCY_DAYS: Record<string, number> = {
  weekly: 7,
  biweekly: 14,
  monthly: 30,
  quarterly: 91,
  annual: 365,
};

function isStale(lastSeen: string, frequency: string, today: string): boolean {
  const approxGap = FREQUENCY_DAYS[frequency] || 30;
  return format(addDays(parseISO(lastSeen), 2 * approxGap), 'yyyy-MM-dd') < today;
}

interface Cadence {
  frequency: RecurringFrequency;
  medianGap: number;
  amountVariance: number;
}

/**
 * The cadence a date-sorted series repeats on, or null when it does not repeat regularly enough to
 * forecast. An irregular cadence is disqualifying however steady the amounts (that separates a
 * subscription from a merchant visited often); a moving amount is allowed when the cadence is tight
 * (a weekly paycheck, a card payment). A single gap that is a near multiple of the median is folded
 * back, so one skipped week does not reject a weekly item.
 */
function cadenceOf(txns: ReadonlyArray<{ date: string; amount: number }>): Cadence | null {
  const gaps: number[] = [];
  for (let i = 1; i < txns.length; i++) {
    gaps.push(differenceInDays(parseISO(txns[i].date), parseISO(txns[i - 1].date)));
  }

  const medianGap = median(gaps);
  const frequency = classifyFrequency(medianGap);
  if (!frequency) return null;

  const amounts = txns.map((t) => Math.abs(t.amount));
  const perOccurrenceGaps = medianGap > 0
    ? gaps.map((g) => g / Math.max(1, Math.round(g / medianGap)))
    : gaps;
  const gapVariance = variance(perOccurrenceGaps, medianGap);
  const amountVariance = variance(amounts, median(amounts));

  if (gapVariance >= GAP_VARIANCE_MAX) return null;
  if (amountVariance >= AMOUNT_VARIANCE_MAX && gapVariance >= STRICT_GAP_VARIANCE_MAX) return null;
  return { frequency, medianGap, amountVariance };
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
    is_income: number | null;
    recurring_id: string | null;
  }

  // 1. Load all non-pending transactions from last 13 months.
  //
  // Transfers and confirmed duplicates are excluded for the same reason every other total excludes
  // them: they are not spending. It also keeps the relaxed amount gate honest: card payments
  // ("PAYMENT THANK YOU", "AUTOMATIC PAYMENT") have a rigid monthly cadence and a wildly varying
  // amount, so they would otherwise be admitted as recurring bills and double-count against the
  // spending they are paying off.
  const transactions = db.prepare(`
    SELECT t.id, t.date, t.amount, t.merchant_name, t.original_name, t.category_id, t.recurring_id,
           c.is_income
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.pending = 0
      AND t.date >= ?
      AND ${excludedFromTotalsSql('t')}
      AND COALESCE(t.category_id, '') NOT LIKE 'cat_xfer%'
      -- What happens inside a brokerage or wallet (a dividend, a reinvestment) never reaches the
      -- cash the forecast is about.
      AND a.type NOT IN ('brokerage', 'ira_traditional', 'ira_roth', 'crypto_wallet')
    ORDER BY t.date ASC
  `).all(cutoff) as TxnRow[];

  // 2. Group by normalized merchant name
  const groups = new Map<
    string,
    Array<{ id: string; date: string; amount: number; category_id: string | null; recurring_id: string | null }>
  >();
  const payers: string[] = [];
  // A payer group is keyed by its payer but named the way its rows read.
  const labels = new Map<string, string>();
  const groupNames: string[] = [];
  const groupBigramLengths: number[] = [];


  for (const txn of transactions) {
    const raw = txn.merchant_name || txn.original_name;
    if (!raw) continue;
    const payer = isPayrollLike(txn) ? payerKey(txn.original_name || raw) : '';
    let normalized = payer ? payerGroup(payer, payers, groups, labels) : normalizeMerchant(raw);
    if (!normalized) continue;
    if (payer && !labels.has(normalized)) labels.set(normalized, normalizeMerchant(raw) || normalized);
    // Fuzzy matching: check if normalized name is very similar to an existing group.
    //
    // The exact-hit short circuit is semantics-preserving and is most of the speed. The scan
    // below keeps the HIGHEST-scoring group, and `compareTwoStrings(x, x)` is 1.0, the maximum,
    // with no other group able to tie it because group names are unique. So when the normalized
    // name is already a group the scan can only return that group, and running it is O(groups)
    // of bigram comparisons to learn what a Map lookup already knows. On the owner's ledger
    // most rows are repeat merchants, and this pass ran on every hourly sync: measured at
    // 995.6 / 922.7 / 913.8 ms against a copy of the live database before this line, and the
    // figure after it is stated in the test that pins it.
    let matchedGroup = normalized;
    if (!payer && !groups.has(normalized)) {
      let highestScore = 0;
      const ownLength = bigramLength(normalized);
      for (let g = 0; g < groupNames.length; g++) {
        // Exact upper bound, so skipping never changes which group wins. `compareTwoStrings` is
        // the Dice coefficient over bigrams, 2|A∩B| / (|A|+|B|), and |A∩B| cannot exceed the
        // smaller of the two bigram counts, so the score is at most
        // 2·min(|A|,|B|) / (|A|+|B|). A pair whose bound is under the 0.85 threshold cannot be the
        // winner (the winner must clear the threshold) and cannot change the outcome when nothing
        // clears it (the result is then `normalized` whatever the runner-up scored), so the
        // comparison is skipped. `tests/recurringDetect.test.ts` pins the bound against the real
        // library on adversarial pairs.
        const otherLength = groupBigramLengths[g];
        const bound = (2 * Math.min(ownLength, otherLength)) / (ownLength + otherLength);
        if (bound <= 0.85) continue;
        const score = compareTwoStrings(normalized, groupNames[g]);
        if (score > highestScore) {
          highestScore = score;
          matchedGroup = score > 0.85 ? groupNames[g] : normalized;
        }
      }
    }
    normalized = matchedGroup;


    if (!groups.has(normalized)) {
      if (!payer) {
        groupNames.push(normalized);
        groupBigramLengths.push(bigramLength(normalized));
      }
      groups.set(normalized, []);
    }
    groups.get(normalized)!.push({
      id: txn.id,
      date: txn.date,
      amount: txn.amount,
      category_id: txn.category_id,
      recurring_id: txn.recurring_id,
    });
  }

  const known = knownCategoryIds(db);
  const claimed = new Set<string>();

  // 3. For each group with >= 3 transactions
  for (const [groupKey, txns] of groups) {
    const normalizedName = labels.get(groupKey) ?? groupKey;
    if (txns.length < 3) continue;

    // Sort by date ascending. The id tie-break is not cosmetic: the recent-amount window below has
    // to select the same rows recentSignedAmounts() selects in SQL, or the stored amount and the
    // recomputed one disagree again for two rows sharing a date.
    txns.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));

    const cadence = cadenceOf(txns);
    if (!cadence) continue;
    const { frequency, medianGap, amountVariance } = cadence;

    const lastTxn = txns[txns.length - 1];
    const nextExpected = nextExpectedAfter(
      lastTxn.date, frequency, medianGap, usualWeekday(txns.slice(-RECENT_AMOUNT_WINDOW).map((t) => t.date))
    );
    const expected = expectedAmount(
      txns.slice(-RECENT_AMOUNT_WINDOW).reverse().map((t) => ({ amount: Math.abs(t.amount), date: t.date }))
    );
    const observed = new Set(
      txns.map((t) => t.category_id).filter((id): id is string => Boolean(id))
    );
    const majority = majorityCategoryId(txns.map((t) => t.category_id), known);
    const now = new Date().toISOString();

    // The pattern these rows already belong to keeps its identity when grouping changes (a merged
    // payer, a renamed merchant); otherwise the name decides.
    const linked = patternLinkedBy(db, txns, claimed);
    const existing = db.prepare(
      "SELECT id, is_active, is_confirmed, dismissed_at, category_id FROM recurring_patterns WHERE kind = 'flow' AND (id = ? OR (? IS NULL AND merchant_name = ?))"
    ).get(linked, linked, normalizedName) as
      | {
          id: string;
          is_active: number;
          is_confirmed: number;
          dismissed_at: string | null;
          category_id: string | null;
        }
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
      // A dismissal is honoured on its own terms, not only through the is_active/is_confirmed
      // pair, so a future change to either flag cannot quietly revive a pattern the owner refused.
      if (existing.dismissed_at) continue;
      // Inactive-and-unconfirmed is also what step 6 leaves behind when a bill merely pauses, so it
      // cannot be read as a refusal: skipping it held every paused-then-resumed bill down forever,
      // its new charges unlinked. Revive it once a charge brings it back inside the stale window;
      // until then there is nothing new, and writing it active only for step 6 to retire it again
      // in the same pass would be churn.
      if (!existing.is_active && !existing.is_confirmed && isStale(lastTxn.date, frequency, today)) {
        continue;
      }

      patternId = existing.id;
      db.prepare(`
        UPDATE recurring_patterns
        SET frequency = ?, category_id = ?, average_amount = ?, amount_variance = ?, last_seen = ?,
            next_expected = ?, transaction_count = ?, is_active = 1, amount_changed_from = ?,
            amount_changed_on = ?, updated_at = ?
        WHERE id = ?
      `).run(
        frequency,
        categoryId,
        expected.amount,
        amountVariance,
        lastTxn.date,
        nextExpected,
        txns.length,
        expected.changedFrom,
        expected.changedOn,
        now,
        patternId
      );
    } else {
      patternId = uuidv4();
      db.prepare(`
        INSERT INTO recurring_patterns
          (id, merchant_name, category_id, frequency, average_amount, amount_variance, last_seen,
           next_expected, is_active, is_confirmed, transaction_count, amount_changed_from,
           amount_changed_on, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?, ?)
      `).run(
        patternId,
        normalizedName,
        categoryId,
        frequency,
        expected.amount,
        amountVariance,
        lastTxn.date,
        nextExpected,
        txns.length,
        expected.changedFrom,
        expected.changedOn,
        now,
        now
      );
    }

    claimed.add(patternId);

    // 5. Link matched transactions
    const ids = txns.map(t => t.id);
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(
      `UPDATE transactions SET recurring_id = ? WHERE id IN (${placeholders})`
    ).run(patternId, ...ids);
  }

  detectRecurringTransfers(db, cutoff, today, known);

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

  for (const pattern of allPatterns) {
    if (isStale(pattern.last_seen, pattern.frequency, today)) {
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
  // still linked to them AND were never dismissed. A confirmed pattern is the user's own
  // decision, and a manually created one legitimately carries transaction_count = 0
  // (createRecurringPattern seeds it confirmed so it shows up immediately), so both are excluded.
  //
  // `dismissed_at IS NULL` is the fourth condition and it was the missing one. Dismissal sets
  // exactly `is_active = 0, is_confirmed = 0` and unlinks every transaction, which is this
  // predicate precisely, so this statement deleted the record of the owner's decision on the next
  // sync and the guard above (`if (!existing.is_active && !existing.is_confirmed) continue`) had
  // nothing left to honour. The bill returned on the sync after that.
  const stranded = db.prepare(`
    DELETE FROM recurring_patterns
    WHERE is_active = 0
      AND is_confirmed = 0
      AND dismissed_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.recurring_id = recurring_patterns.id)
  `).run();
  if (stranded.changes > 0) {
    console.log(`[recurring] Removed ${stranded.changes} stranded pattern(s) with no linked transactions.`);
  }
}

/** Payer keys merge into the shortest one already seen that they extend, or the other way round. */
function payerGroup(
  payer: string,
  payers: string[],
  groups: Map<string, unknown[]>,
  labels: Map<string, string>
): string {
  const match = payers.find((existing) => samePayer(existing, payer));
  if (!match) {
    payers.push(payer);
    return payer;
  }
  if (payer.length < match.length) {
    const rows = groups.get(match);
    if (rows) {
      groups.delete(match);
      groups.set(payer, rows);
    }
    const label = labels.get(match);
    if (label) {
      labels.delete(match);
      labels.set(payer, label);
    }
    payers[payers.indexOf(match)] = payer;
    return payer;
  }
  return match;
}

/** The flow pattern most of these rows already link to, unless another group took it this run. */
function patternLinkedBy(
  db: Database.Database,
  txns: ReadonlyArray<{ recurring_id: string | null }>,
  claimed: Set<string>
): string | null {
  const counts = new Map<string, number>();
  for (const txn of txns) {
    if (txn.recurring_id && !claimed.has(txn.recurring_id)) {
      counts.set(txn.recurring_id, (counts.get(txn.recurring_id) ?? 0) + 1);
    }
  }
  const ranked = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  for (const [id] of ranked) {
    const flow = db.prepare("SELECT 1 FROM recurring_patterns WHERE id = ? AND kind = 'flow'").get(id);
    if (flow) return id;
  }
  return null;
}

const TRANSFER_CADENCE_WINDOW = 8;

interface TransferLegRow {
  id: string;
  date: string;
  amount: number;
  category_id: string | null;
  from_id: string;
  from_name: string;
  to_id: string;
  to_name: string;
  to_is_liability: number;
}

/**
 * Money the owner moves between their own accounts on a schedule: the weekly brokerage
 * contribution, a card autopay. Built from paired transfer legs, keyed by the two accounts, and
 * forecast as an outflow from the account the money leaves.
 */
function detectRecurringTransfers(
  db: Database.Database,
  cutoff: string,
  today: string,
  known: Set<string>
): void {
  const legs = db.prepare(`
    SELECT o.id, o.date, o.amount, o.category_id,
           o.account_id AS from_id, fa.account_name AS from_name,
           i.account_id AS to_id, ta.account_name AS to_name, ta.is_liability AS to_is_liability
    FROM transactions o
    JOIN transactions i ON i.transfer_pair_id = o.transfer_pair_id AND i.id <> o.id
    JOIN accounts fa ON fa.id = o.account_id
    JOIN accounts ta ON ta.id = i.account_id
    WHERE o.amount < 0
      AND o.pending = 0
      AND o.date >= ?
      AND o.transfer_status IN ('candidate', 'confirmed')
    ORDER BY o.date ASC, o.id ASC
  `).all(cutoff) as TransferLegRow[];

  const groups = new Map<string, TransferLegRow[]>();
  for (const leg of legs) {
    const key = `${leg.from_id}|${leg.to_id}`;
    groups.set(key, [...(groups.get(key) ?? []), leg]);
  }

  for (const txns of groups.values()) {
    if (txns.length < 3) continue;
    // A schedule is judged on what it does now: the weekly contribution doubled in July, and the
    // whole-history amount spread would reject it for having changed once.
    const cadence = cadenceOf(txns.slice(-TRANSFER_CADENCE_WINDOW));
    if (!cadence) continue;
    upsertTransferPattern(db, txns, cadence, today, known);
  }
}

function upsertTransferPattern(
  db: Database.Database,
  txns: TransferLegRow[],
  cadence: Cadence,
  today: string,
  known: Set<string>
): void {
  const first = txns[0];
  const last = txns[txns.length - 1];
  const label = `${first.from_name} to ${first.to_name}`;
  const categoryId = first.to_is_liability
    ? 'cat_xfer_cc'
    : majorityCategoryId(txns.map((t) => t.category_id), known);
  const recent = txns.slice(-RECENT_AMOUNT_WINDOW).reverse().map((t) => ({ amount: Math.abs(t.amount), date: t.date }));
  // A card payment follows each month's spending; two large months are not a new level.
  const expected = first.to_is_liability
    ? { amount: Math.round(median(recent.map((t) => t.amount))), changedFrom: null, changedOn: null }
    : expectedAmount(recent);
  const nextExpected = nextExpectedAfter(
    last.date, cadence.frequency, cadence.medianGap,
    usualWeekday(txns.slice(-TRANSFER_CADENCE_WINDOW).map((t) => t.date))
  );
  const now = new Date().toISOString();

  const existing = db.prepare(`
    SELECT id, is_active, is_confirmed, dismissed_at FROM recurring_patterns
    WHERE kind = 'transfer' AND account_id = ? AND counterparty_account_id = ?
  `).get(first.from_id, first.to_id) as
    | { id: string; is_active: number; is_confirmed: number; dismissed_at: string | null }
    | undefined;

  let patternId: string;
  if (existing) {
    if (existing.dismissed_at) return;
    if (!existing.is_active && !existing.is_confirmed && isStale(last.date, cadence.frequency, today)) return;
    patternId = existing.id;
    db.prepare(`
      UPDATE recurring_patterns
      SET frequency = ?, category_id = ?, average_amount = ?, amount_variance = ?, last_seen = ?,
          next_expected = ?, transaction_count = ?, is_active = 1, amount_changed_from = ?,
          amount_changed_on = ?, updated_at = ?
      WHERE id = ?
    `).run(cadence.frequency, categoryId, expected.amount, cadence.amountVariance, last.date,
      nextExpected, txns.length, expected.changedFrom, expected.changedOn, now, patternId);
  } else {
    const taken = db.prepare('SELECT 1 FROM recurring_patterns WHERE merchant_name = ?').get(label);
    patternId = uuidv4();
    db.prepare(`
      INSERT INTO recurring_patterns
        (id, merchant_name, category_id, frequency, average_amount, amount_variance, last_seen,
         next_expected, is_active, is_confirmed, transaction_count, kind, account_id,
         counterparty_account_id, amount_changed_from, amount_changed_on, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, 'transfer', ?, ?, ?, ?, ?, ?)
    `).run(patternId, taken ? `${label} (${patternId.slice(0, 8)})` : label, categoryId,
      cadence.frequency, expected.amount, cadence.amountVariance, last.date, nextExpected,
      txns.length, first.from_id, first.to_id, expected.changedFrom, expected.changedOn, now, now);
  }

  const ids = txns.map((t) => t.id);
  db.prepare(`UPDATE transactions SET recurring_id = ? WHERE id IN (${ids.map(() => '?').join(',')})`)
    .run(patternId, ...ids);
}
