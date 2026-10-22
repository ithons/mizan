import type Database from 'better-sqlite3';
import { endOfMonth, format, startOfMonth, subMonths } from 'date-fns';
import type { AdvisorDraftPayload, StarterBudgetReading } from '../../../shared/types';
import { excludedFromTotalsSql, reportDateSql, REPORT_SCOPE_ROOT_IDS } from './transactionFilters';
import { toDollars } from './money';

export const STARTER_WINDOW_MONTHS = 12;
/** Months in the window with any spending before a category counts as steady. */
export const STARTER_MIN_MONTHS_WITH_SPEND = 9;
const ROUND_TO_CENTS = 1000;

export interface StarterBudget {
  category_id: string;
  category_name: string;
  /** Signed spend per complete month, oldest first, in cents. A refund-heavy month can be negative. */
  months: Array<{ month: string; spent: number }>;
  median_cents: number;
  /** The median rounded to the nearest $10. */
  amount_cents: number;
  months_with_spend: number;
  months_at_or_under: number;
}

export type StarterBudgetPayload = Extract<AdvisorDraftPayload, { kind: 'update_budget' }>;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/** Top-level spending categories with no budget anywhere in their tree and no decline on record. */
function eligibleRoots(db: Database.Database): Array<{ id: string; name: string }> {
  return db.prepare(`
    WITH RECURSIVE tree(root_id, category_id) AS (
      SELECT id, id FROM categories WHERE parent_id IS NULL
      UNION ALL
      SELECT tree.root_id, c.id FROM categories c JOIN tree ON c.parent_id = tree.category_id
    )
    SELECT r.id, r.name FROM categories r
    WHERE r.parent_id IS NULL
      AND COALESCE(r.is_income, 0) = 0
      AND COALESCE(r.is_investment, 0) = 0
      AND r.id NOT IN (${REPORT_SCOPE_ROOT_IDS.map(() => '?').join(', ')})
      AND NOT EXISTS (SELECT 1 FROM tree JOIN budgets b ON b.category_id = tree.category_id WHERE tree.root_id = r.id)
      -- ai_feedback leaves proposed_category_id empty for a budget on purpose (proposedCategoryOf),
      -- so the category is read from the dismissed draft's own payload.
      AND NOT EXISTS (
        SELECT 1 FROM ai_feedback f JOIN advisor_drafts d ON d.id = f.draft_id
        WHERE f.signal = 'draft_dismissed' AND f.proposal_kind = 'update_budget'
          AND COALESCE(f.stale, 0) <> 1
          AND (CASE WHEN json_valid(d.payload) THEN json_extract(d.payload, '$.category_id') END) = r.id
      )
    ORDER BY r.name
  `).all(...REPORT_SCOPE_ROOT_IDS) as Array<{ id: string; name: string }>;
}

/** Spend per month over a category's tree, measured the way a budget on it would measure it. */
function monthlySpend(db: Database.Database, rootId: string, startDate: string, endDate: string): Map<string, number> {
  const rows = db.prepare(`
    WITH RECURSIVE tree(category_id) AS (
      SELECT ? UNION ALL SELECT c.id FROM categories c JOIN tree ON c.parent_id = tree.category_id
    )
    SELECT strftime('%Y-%m', ${reportDateSql('t')}) AS month, SUM(-t.amount) AS spent
    FROM transactions t JOIN tree ON tree.category_id = t.category_id
    WHERE t.pending = 0 AND ${excludedFromTotalsSql('t')}
      AND ${reportDateSql('t')} BETWEEN ? AND ?
    GROUP BY month
  `).all(rootId, startDate, endDate) as Array<{ month: string; spent: number }>;
  return new Map(rows.map((row) => [row.month, row.spent]));
}

/**
 * A budget to start from for each steady spending category that has none: the median of the last
 * twelve complete months, rounded to $10. Nothing is proposed until the ledger reaches back the
 * whole window, and a category with spending in fewer than nine of those months is left alone.
 */
export function detectStarterBudgets(db: Database.Database, today = new Date()): StarterBudget[] {
  const startDate = format(startOfMonth(subMonths(today, STARTER_WINDOW_MONTHS)), 'yyyy-MM-dd');
  const endDate = format(endOfMonth(subMonths(today, 1)), 'yyyy-MM-dd');
  const first = (db.prepare('SELECT MIN(date) AS d FROM transactions WHERE pending = 0').get() as { d: string | null }).d;
  if (first === null || first > startDate) return [];

  const monthKeys = Array.from({ length: STARTER_WINDOW_MONTHS }, (_, i) =>
    format(subMonths(today, STARTER_WINDOW_MONTHS - i), 'yyyy-MM'));
  return eligibleRoots(db).flatMap((root) => {
    const spend = monthlySpend(db, root.id, startDate, endDate);
    const months = monthKeys.map((month) => ({ month, spent: spend.get(month) ?? 0 }));
    const monthsWithSpend = months.filter((m) => m.spent > 0).length;
    if (monthsWithSpend < STARTER_MIN_MONTHS_WITH_SPEND) return [];
    const mid = median(months.map((m) => m.spent));
    const amount = Math.max(ROUND_TO_CENTS, Math.round(mid / ROUND_TO_CENTS) * ROUND_TO_CENTS);
    return [{
      category_id: root.id,
      category_name: root.name,
      months,
      median_cents: mid,
      amount_cents: amount,
      months_with_spend: monthsWithSpend,
      months_at_or_under: months.filter((m) => m.spent <= amount).length,
    }];
  });
}

export function starterBudgetPayload(starter: StarterBudget): StarterBudgetPayload {
  return { kind: 'update_budget', category_id: starter.category_id, amount: toDollars(starter.amount_cents), period: 'monthly', rollover: false };
}

export function starterBudgetSummary(starter: StarterBudget): string {
  return `$${toDollars(starter.amount_cents).toFixed(2)} a month: the median of ${starter.months.length} complete months, $${toDollars(starter.median_cents).toFixed(2)}, rounded to $10. `
    + `Spending was at or under it in ${starter.months_at_or_under} of ${starter.months.length}. No rollover.`;
}

export function starterBudgetToDollars(starter: StarterBudget): StarterBudgetReading {
  return {
    category_id: starter.category_id,
    category_name: starter.category_name,
    amount: toDollars(starter.amount_cents),
    median: toDollars(starter.median_cents),
    months: starter.months.map((m) => ({ month: m.month, spent: toDollars(m.spent) })),
    months_with_spend: starter.months_with_spend,
    months_at_or_under: starter.months_at_or_under,
  };
}
