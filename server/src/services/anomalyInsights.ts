import type Database from 'better-sqlite3';
import { format, subDays } from 'date-fns';
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

export function getAnomalyInsights(db: Database.Database, now = new Date()): RankedInsight[] {
  const currentEnd = format(now, 'yyyy-MM-dd');
  const currentStartDate = subDays(now, 29);
  const currentStart = format(currentStartDate, 'yyyy-MM-dd');
  const previousEnd = format(subDays(currentStartDate, 1), 'yyyy-MM-dd');
  const previousStart = format(subDays(currentStartDate, 30), 'yyyy-MM-dd');

  const topCategorySpike = db.prepare(`
    WITH RECURSIVE excluded_report_categories(id) AS (
      SELECT id FROM categories WHERE id IN (${EXCLUDED_ROOT_PLACEHOLDERS})
      UNION ALL
      SELECT c.id
      FROM categories c
      JOIN excluded_report_categories excluded ON c.parent_id = excluded.id
    ),
    expense_rows AS (
      SELECT
        COALESCE(parent.name, c.name, 'Uncategorized') AS category_name,
        CASE WHEN t.date BETWEEN ? AND ? THEN ABS(t.amount) ELSE 0 END AS current_amount,
        CASE WHEN t.date BETWEEN ? AND ? THEN ABS(t.amount) ELSE 0 END AS previous_amount
      FROM transactions t
      LEFT JOIN categories c ON c.id = t.category_id
      LEFT JOIN categories parent ON parent.id = c.parent_id
      WHERE t.pending = 0
        AND t.amount < 0
        AND t.date BETWEEN ? AND ?
        AND (t.category_id IS NULL OR t.category_id NOT IN (SELECT id FROM excluded_report_categories))
        AND COALESCE(t.transfer_status, 'none') NOT IN ('candidate', 'confirmed')
        AND (t.category_id IS NULL OR COALESCE(c.is_income, 0) = 0)
        AND COALESCE(c.is_investment, 0) = 0
    )
    SELECT
      category_name,
      SUM(current_amount) AS current_spend,
      SUM(previous_amount) AS previous_spend
    FROM expense_rows
    GROUP BY category_name
    HAVING current_spend >= 300
       AND current_spend - previous_spend >= 200
       AND (previous_spend = 0 OR current_spend >= previous_spend * 1.75)
    ORDER BY current_spend - previous_spend DESC
    LIMIT 1
  `).get(
    ...EXCLUDED_REPORT_ROOT_CATEGORY_IDS,
    currentStart,
    currentEnd,
    previousStart,
    previousEnd,
    previousStart,
    currentEnd
  ) as CategorySpendRow | undefined;

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
      AND t.amount > 0
      AND t.date BETWEEN ? AND ?
      AND (t.category_id IS NULL OR t.category_id NOT IN (SELECT id FROM excluded_report_categories))
      AND COALESCE(t.transfer_status, 'none') NOT IN ('candidate', 'confirmed')
      AND (t.category_id IS NULL OR COALESCE(c.is_income, 0) = 1)
      AND COALESCE(c.is_investment, 0) = 0
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
    const delta = topCategorySpike.current_spend - topCategorySpike.previous_spend;
    const increase = topCategorySpike.previous_spend > 0
      ? ((topCategorySpike.current_spend / topCategorySpike.previous_spend) - 1) * 100
      : null;

    insights.push({
      id: 'spending-category-spike',
      severity: 'warning',
      rank: 28,
      title: 'Spending spike detected',
      message: increase === null
        ? `${topCategorySpike.category_name} spending is ${money(topCategorySpike.current_spend)} in the last 30 days after no comparable spending in the prior 30 days.`
        : `${topCategorySpike.category_name} spending is up ${percent(increase)} versus the prior 30 days.`,
      metric: money(delta),
      action_label: 'Open reports',
      action_route: '/reports',
    });
  }

  if (income.previous_income >= 500 && income.current_income < income.previous_income * 0.6) {
    const gap = income.previous_income - income.current_income;
    insights.push({
      id: 'income-gap',
      severity: 'warning',
      rank: 29,
      title: 'Income gap detected',
      message: `Income in the last 30 days is ${money(income.current_income)}, down from ${money(income.previous_income)} in the prior 30 days.`,
      metric: money(gap),
      action_label: 'Open reports',
      action_route: '/reports',
    });
  }

  return insights;
}
