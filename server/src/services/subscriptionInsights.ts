import type Database from 'better-sqlite3';
import { addDays, format } from 'date-fns';
import { buildRecurringForecast } from './recurringForecast';
import type {
  RecurringForecastOccurrence,
  RecurringPattern,
  SubscriptionInsightItem,
  SubscriptionInsights,
} from '../../../shared/types';

type Frequency = RecurringPattern['frequency'];

interface SubscriptionPatternRow {
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

interface TransactionAmountRow {
  date: string;
  amount: number;
}

interface IncreaseDetail {
  latest_amount: number;
  previous_amount: number;
  increase_amount: number;
  increase_percent: number;
}

function confidenceForPattern(pattern: SubscriptionPatternRow): number {
  if (pattern.is_confirmed) return 1;
  return Math.min(0.9, 0.45 + pattern.transaction_count * 0.1);
}

function confidenceLabel(confidence: number): RecurringForecastOccurrence['confidence_label'] {
  if (confidence >= 0.95) return 'confirmed';
  if (confidence >= 0.7) return 'likely';
  return 'uncertain';
}

function monthlyEquivalent(amount: number, frequency: Frequency): number {
  switch (frequency) {
    case 'weekly':
      return amount * 52 / 12;
    case 'biweekly':
      return amount * 26 / 12;
    case 'monthly':
      return amount;
    case 'quarterly':
      return amount / 3;
    case 'annual':
      return amount / 12;
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function priceIncreaseForPattern(db: Database.Database, patternId: string): IncreaseDetail | null {
  const rows = db.prepare(`
    SELECT date, amount
    FROM transactions
    WHERE recurring_id = ?
      AND pending = 0
    ORDER BY date DESC
    LIMIT 6
  `).all(patternId) as TransactionAmountRow[];

  if (rows.length < 3) return null;

  const latest = Math.abs(rows[0].amount);
  const previous = median(rows.slice(1).map((row) => Math.abs(row.amount)));
  if (previous <= 0) return null;

  const increaseAmount = latest - previous;
  const increasePercent = increaseAmount / previous;
  if (increaseAmount < 1 || increasePercent < 0.05) return null;

  return {
    latest_amount: latest,
    previous_amount: previous,
    increase_amount: increaseAmount,
    increase_percent: increasePercent,
  };
}

export function buildSubscriptionInsights(
  db: Database.Database,
  days: number
): SubscriptionInsights {
  const endDate = format(addDays(new Date(), days), 'yyyy-MM-dd');
  const forecast = buildRecurringForecast(db, days);
  const nextAmountByPattern = new Map<string, number>();

  for (const occurrence of forecast.occurrences) {
    if (occurrence.amount >= 0) continue;
    nextAmountByPattern.set(
      occurrence.pattern_id,
      (nextAmountByPattern.get(occurrence.pattern_id) ?? 0) + Math.abs(occurrence.amount)
    );
  }

  const rows = db.prepare(`
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
      AND (rp.is_confirmed = 1 OR rp.transaction_count >= 3)
    ORDER BY rp.next_expected ASC
  `).all() as SubscriptionPatternRow[];

  const subscriptions = rows
    .filter((row) => row.average_signed_amount < 0)
    .map((row): SubscriptionInsightItem => {
      const averageAmount = Math.abs(row.average_signed_amount);
      const confidence = confidenceForPattern(row);
      const increase = priceIncreaseForPattern(db, row.id);

      return {
        pattern_id: row.id,
        merchant_name: row.merchant_name,
        category_id: row.category_id,
        category_name: row.category_name,
        category_color: row.category_color,
        frequency: row.frequency,
        average_amount: averageAmount,
        monthly_amount: monthlyEquivalent(averageAmount, row.frequency),
        next_expected: row.next_expected,
        upcoming_amount: nextAmountByPattern.get(row.id) ?? 0,
        is_confirmed: Boolean(row.is_confirmed),
        confidence,
        confidence_label: confidenceLabel(confidence),
        transaction_count: row.transaction_count,
        latest_amount: increase?.latest_amount ?? null,
        previous_amount: increase?.previous_amount ?? null,
        increase_amount: increase?.increase_amount ?? null,
        increase_percent: increase?.increase_percent ?? null,
      };
    })
    .sort((a, b) => b.monthly_amount - a.monthly_amount);

  const increases = subscriptions
    .filter((subscription) => (subscription.increase_amount ?? 0) > 0)
    .sort((a, b) => (b.increase_amount ?? 0) - (a.increase_amount ?? 0));
  const unconfirmed = subscriptions
    .filter((subscription) => !subscription.is_confirmed || subscription.confidence_label === 'uncertain')
    .sort((a, b) => b.monthly_amount - a.monthly_amount);
  const upcoming = subscriptions
    .filter((subscription) => subscription.next_expected <= endDate)
    .sort((a, b) => a.next_expected.localeCompare(b.next_expected));

  return {
    days,
    subscription_count: subscriptions.length,
    total_monthly_amount: subscriptions.reduce((sum, subscription) => sum + subscription.monthly_amount, 0),
    total_upcoming_amount: subscriptions.reduce((sum, subscription) => sum + subscription.upcoming_amount, 0),
    confirmed_monthly_amount: subscriptions
      .filter((subscription) => subscription.is_confirmed)
      .reduce((sum, subscription) => sum + subscription.monthly_amount, 0),
    unconfirmed_monthly_amount: unconfirmed.reduce((sum, subscription) => sum + subscription.monthly_amount, 0),
    increase_count: increases.length,
    unconfirmed_count: unconfirmed.length,
    upcoming_renewal_count: upcoming.length,
    subscriptions,
    increases: increases.slice(0, 8),
    unconfirmed: unconfirmed.slice(0, 8),
    upcoming: upcoming.slice(0, 8),
  };
}
