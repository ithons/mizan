import type { Budget } from '@shared/types';

type BudgetProjectionInput = Pick<
  Budget,
  | 'amount'
  | 'rollover'
  | 'rollover_balance'
  | 'spent'
  | 'projected_spend'
  | 'projected_remaining'
  | 'projected_percent'
>;

export function availableBudgetAmount(
  budget: Pick<Budget, 'amount' | 'rollover' | 'rollover_balance'>
): number {
  return budget.amount + (budget.rollover ? budget.rollover_balance : 0);
}

export function budgetActualSpend(budget: Pick<Budget, 'spent'>): number {
  return budget.spent ?? 0;
}

export function budgetProjectedSpend(budget: Pick<Budget, 'spent' | 'projected_spend'>): number {
  return budget.projected_spend ?? budgetActualSpend(budget);
}

export function budgetProjectedRemaining(budget: BudgetProjectionInput): number {
  return budget.projected_remaining ?? availableBudgetAmount(budget) - budgetProjectedSpend(budget);
}

export function budgetProjectedPercent(budget: BudgetProjectionInput): number {
  const available = availableBudgetAmount(budget);
  return budget.projected_percent ?? (available > 0 ? (budgetProjectedSpend(budget) / available) * 100 : 0);
}
