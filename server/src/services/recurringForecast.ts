import type Database from 'better-sqlite3';
import { addDays, addMonths, format, parseISO } from 'date-fns';
import type {
  RecurringForecast,
  RecurringForecastOccurrence,
  RecurringPattern,
} from '../../../shared/types';

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
      const daysUntil = -1 * Math.max(
        1,
        Math.round((now.getTime() - overdueExpectedDate.getTime()) / 86_400_000)
      );

      occurrences.push({
        id: `${pattern.id}:${expectedDate}`,
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
        confidence_label,
        status: 'overdue',
        days_until: daysUntil,
        needs_review: true,
      });
    }

    while (format(expected, 'yyyy-MM-dd') <= endDate && guard < 500) {
      const expectedDate = format(expected, 'yyyy-MM-dd');
      const amount = pattern.average_signed_amount;
      const daysUntil = Math.max(0, Math.round((expected.getTime() - now.getTime()) / 86_400_000));

      occurrences.push({
        id: `${pattern.id}:${expectedDate}`,
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
        confidence_label,
        status: 'upcoming',
        days_until: daysUntil,
        needs_review: !pattern.is_confirmed && confidence_label !== 'likely',
      });

      expected = nextOccurrenceDate(expected, pattern.frequency);
      guard++;
    }
  }

  occurrences.sort((a, b) => a.expected_date.localeCompare(b.expected_date));

  const income = occurrences.reduce((sum, occurrence) =>
    occurrence.amount > 0 ? sum + occurrence.amount : sum, 0);
  const bills = occurrences.reduce((sum, occurrence) =>
    occurrence.amount < 0 ? sum + Math.abs(occurrence.amount) : sum, 0);
  const bucketedTotals = {
    confirmed_income: 0,
    confirmed_bills: 0,
    likely_income: 0,
    likely_bills: 0,
    uncertain_income: 0,
    uncertain_bills: 0,
  };

  for (const occurrence of occurrences) {
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
    overdue_count: occurrences.filter((occurrence) => occurrence.status === 'overdue').length,
    review_count: occurrences.filter((occurrence) => occurrence.needs_review).length,
    occurrences,
  };
}
