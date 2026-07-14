import type Database from 'better-sqlite3';
import { addDays, addMonths, format, parseISO } from 'date-fns';
import type {
  RecurringForecast,
  RecurringForecastOccurrence,
  RecurringOccurrenceAdjustment,
  RecurringPattern,
} from '../../../shared/types';
import { getRecurringAdjustmentMap } from './recurringAdjustments';

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
  average_signed_amount: number;
}

function nextOccurrenceDate(date: Date, frequency: Frequency): Date {
  switch (frequency) {
    case 'weekly':
      return addDays(date, 7);
    case 'biweekly':
      return addDays(date, 14);
    case 'monthly':
      return addMonths(date, 1);
    case 'quarterly':
      return addMonths(date, 3);
    case 'annual':
      return addMonths(date, 12);
  }
}

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

function daysUntil(date: Date, now: Date): number {
  const diff = Math.round((date.getTime() - now.getTime()) / 86_400_000);
  return diff < 0 ? -1 * Math.max(1, Math.abs(diff)) : Math.max(0, diff);
}

function buildOccurrence(
  pattern: RecurringForecastRow,
  originalDate: string,
  baseAmount: number,
  confidence: number,
  confidenceLabelValue: RecurringForecastOccurrence['confidence_label'],
  now: Date,
  today: string,
  endDate: string,
  adjustment?: RecurringOccurrenceAdjustment
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
    : baseAmount;
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
    is_income: amount > 0,
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
      c.name AS category_name,
      c.color AS category_color,
      COALESCE(
        (
          SELECT AVG(t.amount)
          FROM transactions t
          WHERE t.recurring_id = rp.id
        ),
        CASE WHEN COALESCE(c.is_income, 0) = 1 THEN rp.average_amount ELSE -rp.average_amount END
      ) AS average_signed_amount
    FROM recurring_patterns rp
    LEFT JOIN categories c ON c.id = rp.category_id
    WHERE rp.is_active = 1
      AND rp.next_expected <= ?
      AND (rp.is_confirmed = 1 OR rp.transaction_count >= 3)
    ORDER BY rp.next_expected ASC
  `).all(endDate) as RecurringForecastRow[];

  const adjustmentMap = getRecurringAdjustmentMap(db, patterns.map((pattern) => pattern.id));
  const occurrences: RecurringForecastOccurrence[] = [];

  for (const pattern of patterns) {
    let expected = parseISO(pattern.next_expected);
    let guard = 0;
    const confidence = confidenceForPattern(pattern);
    const confidence_label = confidenceLabel(confidence);
    let overdueExpectedDate: Date | null = null;

    while (format(expected, 'yyyy-MM-dd') < today && guard < 500) {
      overdueExpectedDate = expected;
      expected = nextOccurrenceDate(expected, pattern.frequency);
      guard++;
    }

    if (overdueExpectedDate) {
      const expectedDate = format(overdueExpectedDate, 'yyyy-MM-dd');
      const amount = pattern.average_signed_amount;
      const occurrence = buildOccurrence(
        pattern,
        expectedDate,
        amount,
        confidence,
        confidence_label,
        now,
        today,
        endDate,
        adjustmentMap.get(`${pattern.id}:${expectedDate}`)
      );
      if (occurrence) occurrences.push(occurrence);
    }

    while (format(expected, 'yyyy-MM-dd') <= endDate && guard < 500) {
      const expectedDate = format(expected, 'yyyy-MM-dd');
      const amount = pattern.average_signed_amount;
      const occurrence = buildOccurrence(
        pattern,
        expectedDate,
        amount,
        confidence,
        confidence_label,
        now,
        today,
        endDate,
        adjustmentMap.get(`${pattern.id}:${expectedDate}`)
      );
      if (occurrence) occurrences.push(occurrence);

      expected = nextOccurrenceDate(expected, pattern.frequency);
      guard++;
    }
  }

  occurrences.sort((a, b) => a.expected_date.localeCompare(b.expected_date));

  const counted = occurrences.filter((occurrence) => occurrence.adjustment_action !== 'skip');
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
    ...bucketedTotals,
    overdue_count: counted.filter((occurrence) => occurrence.status === 'overdue').length,
    review_count: counted.filter((occurrence) => occurrence.needs_review).length,
    occurrences,
  };
}
