import type Database from 'better-sqlite3';
import { addDays, differenceInCalendarDays, format, isValid, parseISO } from 'date-fns';
import type {
  RecurringForecast,
  RecurringForecastOccurrence,
  RecurringOccurrenceAdjustment,
  RecurringPattern,
} from '../../../shared/types';
import { getRecurringAdjustmentMap } from './recurringAdjustments';
import { occurrenceDate, recentExpectedAmounts, type ExpectedAmount } from './recurring';

type Frequency = RecurringPattern['frequency'];

interface RecurringForecastRow {
  id: string;
  merchant_name: string;
  category_id: string | null;
  category_name: string | null;
  category_color: string | null;
  frequency: Frequency;
  next_expected: string;
  is_confirmed: number;
  transaction_count: number;
  average_amount: number;
  is_income: number | null;
  amount_variance: number | null;
  kind: 'flow' | 'transfer';
  account_id: string | null;
  account_name: string | null;
  counterparty_account_id: string | null;
  counterparty_account_name: string | null;
  amount_changed_from: number | null;
  amount_changed_on: string | null;
  counterparty_is_liability: number | null;
  statement_balance: number | null;
  statement_due_date: string | null;
}

/** Matches detection's AMOUNT_VARIANCE_MAX: above it, the stored amount is a median, not a bill. */
const AMOUNT_VARIES_THRESHOLD = 0.25;

/** How many occurrences one pattern may contribute before the walk is cut off. */
const OCCURRENCE_LIMIT = 500;

function confidenceForPattern(pattern: RecurringForecastRow): number {
  if (pattern.is_confirmed) return 1;
  return Math.min(0.9, 0.45 + pattern.transaction_count * 0.1);
}

function confidenceLabel(confidence: number): RecurringForecastOccurrence['confidence_label'] {
  if (confidence >= 0.95) return 'confirmed';
  if (confidence >= 0.7) return 'likely';
  return 'uncertain';
}

function forecastBucket(occurrence: RecurringForecastOccurrence): 'confirmed' | 'likely' | 'uncertain' {
  if (occurrence.is_confirmed) return 'confirmed';
  return occurrence.confidence_label === 'likely' ? 'likely' : 'uncertain';
}

// Calendar days, not a wall-clock delta. `status` is decided by comparing date strings, so the old
// millisecond subtraction contradicted it from local noon onward: an occurrence dated today came
// back days_until -1 while status stayed 'upcoming', and Today's rail said "in 3d" for a bill four
// calendar days out. No floor on the negative side either, so an overdue row reports its true age.
function daysUntil(date: Date, now: Date): number {
  return differenceInCalendarDays(date, now);
}

function buildOccurrence(
  pattern: RecurringForecastRow,
  originalDate: string,
  expected: ExpectedAmount,
  confidence: number,
  confidenceLabelValue: RecurringForecastOccurrence['confidence_label'],
  now: Date,
  today: string,
  endDate: string,
  adjustment?: RecurringOccurrenceAdjustment,
  basis?: 'statement' | 'history'
): RecurringForecastOccurrence | null {
  // Skipped occurrences stay in the payload (dimmed + undoable in the UI) but
  // are excluded from every total and review count by the aggregation below.
  const skipped = adjustment?.action === 'skip';

  const expectedDate = adjustment?.action === 'snooze' && adjustment.adjusted_date
    ? adjustment.adjusted_date
    : originalDate;
  if (expectedDate > endDate) return null;

  const amount = adjustment?.action === 'adjust' && adjustment.adjusted_amount != null
    ? adjustment.adjusted_amount
    : expected.amount;
  const effectiveDate = parseISO(expectedDate);
  const status: RecurringForecastOccurrence['status'] = expectedDate < today ? 'overdue' : 'upcoming';
  const needsReview = skipped
    ? false
    : status === 'overdue'
      ? true
      : !pattern.is_confirmed && confidenceLabelValue !== 'likely';

  return {
    id: `${pattern.id}:${originalDate}`,
    pattern_id: pattern.id,
    merchant_name: pattern.merchant_name,
    category_id: pattern.category_id,
    category_name: pattern.category_name,
    category_color: pattern.category_color,
    frequency: pattern.frequency,
    expected_date: expectedDate,
    amount,
    // A user-adjusted occurrence is an exact figure the user supplied, so it is never "varies".
    amount_varies: adjustment?.action === 'adjust' && adjustment.adjusted_amount != null
      ? false
      : (pattern.amount_variance ?? 0) >= AMOUNT_VARIES_THRESHOLD,
    is_income: pattern.kind === 'flow' && amount > 0,
    amount_change: expected.changedFrom !== null && expected.changedOn !== null
      ? { from: expected.changedFrom, since: expected.changedOn }
      : null,
    kind: pattern.kind,
    ...(basis ? { amount_basis: basis } : {}),
    account_id: pattern.account_id,
    account_name: pattern.account_name,
    counterparty_account_id: pattern.counterparty_account_id,
    counterparty_account_name: pattern.counterparty_account_name,
    is_confirmed: Boolean(pattern.is_confirmed),
    confidence,
    confidence_label: confidenceLabelValue,
    status,
    days_until: daysUntil(effectiveDate, now),
    needs_review: needsReview,
    adjustment_id: adjustment?.id ?? null,
    adjustment_action: adjustment?.action ?? null,
    original_expected_date: adjustment ? originalDate : null,
    adjusted_date: adjustment?.adjusted_date ?? null,
    adjusted_amount: adjustment?.adjusted_amount ?? null,
    adjustment_note: adjustment?.note ?? null,
  };
}

/** The cadence occurrence a statement due date stands in for, rather than a second payment. */
const STATEMENT_MATCH_DAYS = 12;
/** A payment this long before the due date pays that statement. */
const STATEMENT_PAYMENT_DAYS = 25;

/**
 * The owner's statement for the card this pattern pays, while it is still owed: due today or
 * later, and no payment into the card since the statement could have closed.
 */
function openStatement(
  db: Database.Database,
  pattern: RecurringForecastRow,
  today: string
): { balance: number; dueDate: string } | null {
  if (pattern.statement_balance === null || pattern.statement_due_date === null) return null;
  if (pattern.statement_due_date < today || pattern.statement_balance <= 0) return null;
  if (!isValid(parseISO(pattern.statement_due_date))) return null;
  const since = format(addDays(parseISO(pattern.statement_due_date), -STATEMENT_PAYMENT_DAYS), 'yyyy-MM-dd');
  const paid = db.prepare(`
    SELECT 1 FROM transactions
    WHERE account_id = ? AND amount > 0 AND pending = 0
      AND transfer_status IN ('candidate', 'confirmed') AND date >= ?
    LIMIT 1
  `).get(pattern.counterparty_account_id, since);
  return paid ? null : { balance: pattern.statement_balance, dueDate: pattern.statement_due_date };
}

// A transfer is always money leaving its account. Anything else is signed by its own rows, or by
// its category when it has none (a pattern the owner typed in).
function expectedFor(pattern: RecurringForecastRow, recent: ExpectedAmount | undefined): ExpectedAmount {
  if (pattern.kind === 'transfer') {
    return {
      amount: -pattern.average_amount,
      changedFrom: pattern.amount_changed_from === null ? null : -pattern.amount_changed_from,
      changedOn: pattern.amount_changed_on,
    };
  }
  return recent ?? {
    amount: pattern.is_income === 1 ? pattern.average_amount : -pattern.average_amount,
    changedFrom: null,
    changedOn: null,
  };
}

// Amounts stay in cents; every consumer (recurring route, subscription insights,
// AI context) dollarizes at its own response/display boundary.
export function buildRecurringForecast(
  db: Database.Database,
  days: number
): RecurringForecast {
  const now = new Date();
  const today = format(now, 'yyyy-MM-dd');
  const endDate = format(addDays(now, days), 'yyyy-MM-dd');

  const patterns = db.prepare(`
    SELECT
      rp.id,
      rp.merchant_name,
      rp.category_id,
      rp.frequency,
      rp.next_expected,
      rp.is_confirmed,
      rp.transaction_count,
      rp.amount_variance,
      rp.average_amount,
      rp.kind,
      rp.amount_changed_from,
      rp.amount_changed_on,
      rp.account_id,
      rp.counterparty_account_id,
      c.name AS category_name,
      c.color AS category_color,
      c.is_income,
      fa.account_name AS account_name,
      ta.account_name AS counterparty_account_name,
      ta.is_liability AS counterparty_is_liability,
      ta.statement_balance,
      ta.statement_due_date
    FROM recurring_patterns rp
    LEFT JOIN categories c ON c.id = rp.category_id
    LEFT JOIN accounts fa ON fa.id = rp.account_id
    LEFT JOIN accounts ta ON ta.id = rp.counterparty_account_id
    WHERE rp.is_active = 1
      AND rp.next_expected <= ?
      AND (rp.is_confirmed = 1 OR rp.transaction_count >= 3)
    ORDER BY rp.next_expected ASC
  `).all(endDate) as RecurringForecastRow[];

  const patternIds = patterns.map((pattern) => pattern.id);
  const adjustmentMap = getRecurringAdjustmentMap(db, patternIds);
  // One definition of the expected amount, shared with the stored column detection writes. A
  // manual pattern has no linked rows, so it falls back to what its owner typed, signed by
  // the category (an unset category is an expense, as it was before).
  const recentAmounts = recentExpectedAmounts(db, patternIds);
  const occurrences: RecurringForecastOccurrence[] = [];

  for (const pattern of patterns) {
    const anchor = parseISO(pattern.next_expected);
    let step = 0;
    let expected = anchor;
    const confidence = confidenceForPattern(pattern);
    const confidence_label = confidenceLabel(confidence);
    const amount = expectedFor(pattern, recentAmounts.get(pattern.id));
    let overdueExpectedDate: Date | null = null;

    while (format(expected, 'yyyy-MM-dd') < today && step < OCCURRENCE_LIMIT) {
      overdueExpectedDate = expected;
      step++;
      expected = occurrenceDate(anchor, pattern.frequency, step);
    }

    const cardPayment = pattern.kind === 'transfer' && pattern.counterparty_is_liability === 1;
    const basis = cardPayment ? 'history' as const : undefined;
    const statement = cardPayment ? openStatement(db, pattern, today) : null;
    const replacedByStatement = (date: string): boolean =>
      statement !== null && Math.abs(differenceInCalendarDays(parseISO(date), parseISO(statement.dueDate))) <= STATEMENT_MATCH_DAYS;
    if (statement) {
      const occurrence = buildOccurrence(
        pattern,
        statement.dueDate,
        { amount: -statement.balance, changedFrom: null, changedOn: null },
        confidence,
        confidence_label,
        now,
        today,
        endDate,
        adjustmentMap.get(`${pattern.id}:${statement.dueDate}`),
        'statement'
      );
      if (occurrence) occurrences.push(occurrence);
      overdueExpectedDate = null;
    }

    if (overdueExpectedDate) {
      const expectedDate = format(overdueExpectedDate, 'yyyy-MM-dd');
      const occurrence = buildOccurrence(
        pattern,
        expectedDate,
        amount,
        confidence,
        confidence_label,
        now,
        today,
        endDate,
        adjustmentMap.get(`${pattern.id}:${expectedDate}`),
        basis
      );
      if (occurrence) occurrences.push(occurrence);
    }

    while (format(expected, 'yyyy-MM-dd') <= endDate && step < OCCURRENCE_LIMIT) {
      const expectedDate = format(expected, 'yyyy-MM-dd');
      const occurrence = replacedByStatement(expectedDate) ? null : buildOccurrence(
        pattern,
        expectedDate,
        amount,
        confidence,
        confidence_label,
        now,
        today,
        endDate,
        adjustmentMap.get(`${pattern.id}:${expectedDate}`),
        basis
      );
      if (occurrence) occurrences.push(occurrence);

      step++;
      expected = occurrenceDate(anchor, pattern.frequency, step);
    }
  }

  occurrences.sort((a, b) => a.expected_date.localeCompare(b.expected_date));

  const kept = occurrences.filter((occurrence) => occurrence.adjustment_action !== 'skip');
  const counted = kept.filter((occurrence) => occurrence.kind !== 'transfer');
  const transfers = kept.reduce((sum, occurrence) =>
    occurrence.kind === 'transfer' ? sum + Math.abs(occurrence.amount) : sum, 0);
  const income = counted.reduce((sum, occurrence) =>
    occurrence.amount > 0 ? sum + occurrence.amount : sum, 0);
  const bills = counted.reduce((sum, occurrence) =>
    occurrence.amount < 0 ? sum + Math.abs(occurrence.amount) : sum, 0);
  const bucketedTotals = {
    confirmed_income: 0,
    confirmed_bills: 0,
    likely_income: 0,
    likely_bills: 0,
    uncertain_income: 0,
    uncertain_bills: 0,
  };

  for (const occurrence of counted) {
    const bucket = forecastBucket(occurrence);
    const side = occurrence.amount > 0 ? 'income' : 'bills';
    const key = `${bucket}_${side}` as keyof typeof bucketedTotals;
    bucketedTotals[key] += Math.abs(occurrence.amount);
  }

  return {
    days,
    income,
    bills,
    net: income - bills,
    transfers,
    ...bucketedTotals,
    overdue_count: kept.filter((occurrence) => occurrence.status === 'overdue').length,
    review_count: kept.filter((occurrence) => occurrence.needs_review).length,
    occurrences,
  };
}
