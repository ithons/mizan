import type Database from 'better-sqlite3';
import { format, subDays } from 'date-fns';
import { toDollars } from './money';
import { excludedFromTotalsSql, expenseSideSql, incomeSideSql } from './transactionFilters';
import type { Insight } from '../../../shared/types';

export interface RankedInsight extends Insight {
  rank: number;
}

interface CategorySpendRow {
  category_name: string;
  current_spend: number;
  previous_spend: number;
}

interface IncomeRow {
  current_income: number;
  previous_income: number;
}

const EXCLUDED_REPORT_ROOT_CATEGORY_IDS = ['cat_xfer', 'cat_inv', 'cat_crypto'];

/** Spike thresholds, in cents. Tuned against a replay over the owner's real ledger; see pickCategorySpike. */
const MIN_CURRENT_CENTS = 30000;
const MIN_DELTA_CENTS = 20000;
const MIN_BASELINE_CENTS = 30000;
const SPIKE_RATIO = 2;
const EXCLUDED_ROOT_PLACEHOLDERS = EXCLUDED_REPORT_ROOT_CATEGORY_IDS.map(() => '?').join(',');

function money(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(amount);
}

function percent(value: number): string {
  return `${value.toFixed(0)}%`;
}


export interface CategorySpike {
  category_name: string;
  current_spend: number;
  baseline_spend: number;
}

/**
 * The one category whose last 30 days genuinely stands out, or nothing.
 *
 * WHY THIS IS NOT A `HAVING` CLAUSE ANY MORE. The old rule compared the current 30 days to the
 * single window before it: `current >= 30000 AND current - previous >= 20000 AND (previous = 0 OR
 * current >= previous * 1.75)`. One neighbouring window is not a baseline. A lumpy category clears
 * that most months, and when the neighbour happens to be near zero the ratio explodes.
 *
 * Replayed against the owner's real ledger, one call per day from 2025-09-01 to 2026-08-31, the old
 * rule fired on **303 of 365 days** across ten categories (Shopping 107, Home 40, Travel 34,
 * Food & Drink 26, Education 23, Transport 23, Pets 17, Entertainment 15, Taxes 13, Health 5), in
 * runs up to 94 days unbroken, printing 1000% or more on 41 of them and topping out at 25000%. A
 * warning that is on for 83% of the year is not a warning, and rule 3 of this codebase is that a
 * detector must be silent on an ordinary healthy event.
 *
 * THE RULE NOW: the last 30 days are the biggest of the last seven windows, by a real margin.
 * The baseline is the MAXIMUM of the six preceding windows, not the mean and not the median, so a
 * category has to beat its own worst month rather than its last one. Median was tried first and
 * still fired 126 days a year, because a lumpy category's median is low enough that any big month
 * clears it; the max is what a reader means by "a spike".
 *
 * Four gates:
 *  - the current window is at least `MIN_CURRENT_CENTS`, so small categories stay quiet;
 *  - the baseline is at least `MIN_BASELINE_CENTS`, so there is a habit to depart FROM. A ratio
 *    against near-zero is arithmetic, not a reading, and this is what used to print 25000%;
 *  - the current window beats the baseline by at least `MIN_DELTA_CENTS`;
 *  - and by at least `SPIKE_RATIO`x.
 *
 * The old "after no comparable spending in the prior 30 days" branch is deliberately gone. A
 * category with no history is a new category, which is not an anomaly worth a standing warning.
 *
 * MEASURED, same replay, same ledger, after the change: **4 distinct events in 365 days**, peaking
 * between +146% and +497%, each visible for 10 to 13 days because a 30-day rolling window carries
 * one real spike for about that long. September Shopping, September Travel, December Shopping and
 * a Home spike at the end of July. That is what this detector is for.
 */
export function pickCategorySpike(
  rows: Array<Record<string, number | string>>,
  baselineWindows: number
): CategorySpike | null {
  let best: CategorySpike | null = null;
  let bestDelta = 0;

  for (const row of rows) {
    const current = Number(row.w0 ?? 0);
    if (current < MIN_CURRENT_CENTS) continue;

    const priors: number[] = [];
    for (let i = 1; i <= baselineWindows; i++) priors.push(Number(row[`w${i}`] ?? 0));
    const baseline = Math.max(...priors);
    if (baseline < MIN_BASELINE_CENTS) continue;

    const delta = current - baseline;
    if (delta < MIN_DELTA_CENTS) continue;
    if (current < baseline * SPIKE_RATIO) continue;

    if (delta > bestDelta) {
      bestDelta = delta;
      best = { category_name: String(row.category_name), current_spend: current, baseline_spend: baseline };
    }
  }

  return best;
}

export function getAnomalyInsights(db: Database.Database, now = new Date()): RankedInsight[] {
  const currentEnd = format(now, 'yyyy-MM-dd');
  const currentStartDate = subDays(now, 29);
  const currentStart = format(currentStartDate, 'yyyy-MM-dd');
  const previousEnd = format(subDays(currentStartDate, 1), 'yyyy-MM-dd');
  const previousStart = format(subDays(currentStartDate, 30), 'yyyy-MM-dd');

  // Six prior windows plus the current one. Each is 30 days, contiguous, ending the day before
  // the next begins, so window 1 is the immediate predecessor and window 6 is ~7 months back.
  const BASELINE_WINDOWS = 6;
  const windowBounds: Array<{ start: string; end: string }> = [];
  for (let i = 0; i <= BASELINE_WINDOWS; i++) {
    // Window 0 is [now-29, now], the same 30 days `currentStart`/`currentEnd` describe. Each later
    // window steps back a full 30 days, so they tile without overlapping or leaving a gap.
    const end = subDays(now, i * 30);
    const start = subDays(end, 29);
    windowBounds.push({ start: format(start, 'yyyy-MM-dd'), end: format(end, 'yyyy-MM-dd') });
  }
  const oldestStart = windowBounds[windowBounds.length - 1].start;

  const windowSums = windowBounds
    .map((_, i) => `SUM(CASE WHEN t.date BETWEEN ? AND ? THEN -t.amount ELSE 0 END) AS w${i}`)
    .join(',\n      ');
  const windowParams = windowBounds.flatMap((w) => [w.start, w.end]);

  const categoryWindows = db.prepare(`
    WITH RECURSIVE excluded_report_categories(id) AS (
      SELECT id FROM categories WHERE id IN (${EXCLUDED_ROOT_PLACEHOLDERS})
      UNION ALL
      SELECT c.id
      FROM categories c
      JOIN excluded_report_categories excluded ON c.parent_id = excluded.id
    )
    SELECT
      COALESCE(parent.name, c.name, 'Uncategorized') AS category_name,
      ${windowSums}
    FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    LEFT JOIN categories parent ON parent.id = c.parent_id
    WHERE t.pending = 0
      AND t.date BETWEEN ? AND ?
      AND (t.category_id IS NULL OR t.category_id NOT IN (SELECT id FROM excluded_report_categories))
      AND ${excludedFromTotalsSql('t')}
      AND ${expenseSideSql('t', 'c')}
    GROUP BY category_name
  `).all(
    ...EXCLUDED_REPORT_ROOT_CATEGORY_IDS,
    ...windowParams,
    oldestStart,
    currentEnd
  ) as Array<Record<string, number | string>>;

  const topCategorySpike = pickCategorySpike(categoryWindows, BASELINE_WINDOWS);

  const income = db.prepare(`
    WITH RECURSIVE excluded_report_categories(id) AS (
      SELECT id FROM categories WHERE id IN (${EXCLUDED_ROOT_PLACEHOLDERS})
      UNION ALL
      SELECT c.id
      FROM categories c
      JOIN excluded_report_categories excluded ON c.parent_id = excluded.id
    )
    SELECT
      COALESCE(SUM(CASE WHEN t.date BETWEEN ? AND ? THEN t.amount ELSE 0 END), 0) AS current_income,
      COALESCE(SUM(CASE WHEN t.date BETWEEN ? AND ? THEN t.amount ELSE 0 END), 0) AS previous_income
    FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.pending = 0
      AND t.date BETWEEN ? AND ?
      AND (t.category_id IS NULL OR t.category_id NOT IN (SELECT id FROM excluded_report_categories))
      AND ${excludedFromTotalsSql('t')}
      AND ${incomeSideSql('t', 'c')}
  `).get(
    ...EXCLUDED_REPORT_ROOT_CATEGORY_IDS,
    currentStart,
    currentEnd,
    previousStart,
    previousEnd,
    previousStart,
    currentEnd
  ) as IncomeRow;

  const insights: RankedInsight[] = [];

  if (topCategorySpike) {
    const delta = topCategorySpike.current_spend - topCategorySpike.baseline_spend;
    const increase = ((topCategorySpike.current_spend / topCategorySpike.baseline_spend) - 1) * 100;

    insights.push({
      id: 'spending-category-spike',
      severity: 'warning',
      rank: 28,
      title: 'Spending spike detected',
      // Says what it is measured against. "versus the prior 30 days" named a single neighbouring
      // window, which is what made the reading unstable enough to print 25000%.
      message: `${topCategorySpike.category_name} spending is ${money(toDollars(topCategorySpike.current_spend))} in the last 30 days, up ${percent(increase)} on its usual ${money(toDollars(topCategorySpike.baseline_spend))} over the last ${BASELINE_WINDOWS} months.`,
      metric: money(toDollars(delta)),
      action_label: 'Open reports',
      // `/reports` is a LEGACY_TARGETS entry that redirects to `/?window=this-month`. Emitted
      // canonically so the served payload names a screen that exists; see routes/insights.ts.
      action_route: '/?window=this-month',
    });
  }

  if (income.previous_income >= 50000 && income.current_income < income.previous_income * 0.6) {
    const gap = income.previous_income - income.current_income;
    insights.push({
      id: 'income-gap',
      severity: 'warning',
      rank: 29,
      title: 'Income gap detected',
      message: `Income in the last 30 days is ${money(toDollars(income.current_income))}, down from ${money(toDollars(income.previous_income))} in the prior 30 days.`,
      metric: money(toDollars(gap)),
      action_label: 'Open reports',
      // `/reports` is a LEGACY_TARGETS entry that redirects to `/?window=this-month`. Emitted
      // canonically so the served payload names a screen that exists; see routes/insights.ts.
      action_route: '/?window=this-month',
    });
  }

  return insights;
}
