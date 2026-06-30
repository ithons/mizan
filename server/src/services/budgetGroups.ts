import type Database from 'better-sqlite3';
import type {
  Budget,
  BudgetGroup,
  BudgetGroupMember,
  BudgetGroupTotals,
} from '../../../shared/types';
import { getMonthlyBudgetsWithProjection } from './budgetProjection';

interface BudgetGroupRow {
  id: string;
  name: string;
  color: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

function emptyTotals(): BudgetGroupTotals {
  return {
    budget_count: 0,
    budgeted: 0,
    spent: 0,
    rollover_balance: 0,
    expected_recurring: 0,
    projected_spend: 0,
    projected_remaining: 0,
    forecast_confidence: 'none',
  };
}

function combineConfidence(
  current: BudgetGroupTotals['forecast_confidence'],
  next: BudgetGroupTotals['forecast_confidence']
): BudgetGroupTotals['forecast_confidence'] {
  if (current === 'none') return next;
  if (next === 'none') return current;
  if (current === 'uncertain' || next === 'uncertain') return 'uncertain';
  if (current === 'likely' || next === 'likely') return 'likely';
  return 'confirmed';
}

function totalsForBudgets(budgets: Budget[]): BudgetGroupTotals {
  return budgets.reduce((totals, budget) => {
    const rolloverBalance = budget.rollover ? budget.rollover_balance : 0;
    const budgeted = budget.amount + rolloverBalance;
    const spent = budget.spent ?? 0;
    const expectedRecurring = budget.expected_recurring ?? 0;
    const projectedSpend = budget.projected_spend ?? spent;

    return {
      budget_count: totals.budget_count + 1,
      budgeted: totals.budgeted + budgeted,
      spent: totals.spent + spent,
      rollover_balance: totals.rollover_balance + rolloverBalance,
      expected_recurring: totals.expected_recurring + expectedRecurring,
      projected_spend: totals.projected_spend + projectedSpend,
      projected_remaining: totals.projected_remaining + (budgeted - projectedSpend),
      forecast_confidence: combineConfidence(totals.forecast_confidence, budget.forecast_confidence ?? 'none'),
    };
  }, emptyTotals());
}

function groupMembers(db: Database.Database): BudgetGroupMember[] {
  return db.prepare(`
    SELECT
      bgm.group_id,
      bgm.category_id,
      bgm.sort_order,
      bgm.created_at,
      c.name AS category_name,
      c.color AS category_color,
      c.icon AS category_icon
    FROM budget_group_members bgm
    JOIN categories c ON c.id = bgm.category_id
    ORDER BY bgm.sort_order ASC, c.name ASC
  `).all() as BudgetGroupMember[];
}

export function getBudgetGroupsWithTotals(
  db: Database.Database,
  year: number,
  month: number,
  now = new Date()
): BudgetGroup[] {
  const groups = db.prepare(`
    SELECT id, name, color, sort_order, created_at, updated_at
    FROM budget_groups
    ORDER BY sort_order ASC, name ASC
  `).all() as BudgetGroupRow[];
  const members = groupMembers(db);
  const membersByGroup = new Map<string, BudgetGroupMember[]>();
  const budgets = getMonthlyBudgetsWithProjection(db, year, month, now);
  const budgetByCategory = new Map(budgets.map((budget) => [budget.category_id, budget]));

  for (const member of members) {
    membersByGroup.set(member.group_id, [
      ...(membersByGroup.get(member.group_id) ?? []),
      member,
    ]);
  }

  return groups.map((group) => {
    const groupMemberRows = membersByGroup.get(group.id) ?? [];
    const memberBudgets = groupMemberRows
      .map((member) => budgetByCategory.get(member.category_id))
      .filter((budget): budget is Budget => Boolean(budget));

    return {
      ...group,
      members: groupMemberRows,
      totals: totalsForBudgets(memberBudgets),
    };
  });
}
