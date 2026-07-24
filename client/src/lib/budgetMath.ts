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

export interface BudgetRowMeta {
  /**
   * Rollover carried into this month, when the category has rollover on and a non-zero balance.
   * Without this the row shows "/ $600" for a budget the user set to $500 and never says why.
   */
  carriedOver: number | null;
  /**
   * Forecast for the rest of the month, present only when scheduled recurring charges push the
   * projection past what has actually been spent. `null` means actual and projected agree, and
   * showing a "projected" line would be noise.
   */
  projection: {
    spend: number;
    remaining: number;
    over: boolean;
    confidence: NonNullable<Budget['forecast_confidence']>;
  } | null;
}

/**
 * What a budget row should say beyond "spent / available". The server already computes every one of
 * these fields; the Budget view rendered none of them, so a category heading for an overspend
 * looked identical to one comfortably under until the month ended.
 */
export function buildBudgetRowMeta(
  budget: BudgetProjectionInput & Pick<Budget, 'expected_recurring' | 'forecast_confidence'>
): BudgetRowMeta {
  const carried = budget.rollover ? budget.rollover_balance : 0;
  const expectedRecurring = budget.expected_recurring ?? 0;
  const projectedSpend = budgetProjectedSpend(budget);
  const actualSpend = budgetActualSpend(budget);

  // A projection that equals actual spend adds nothing. Comparing against expected_recurring too
  // keeps the line from appearing on a rounding difference alone.
  const hasProjection = expectedRecurring > 0 && projectedSpend > actualSpend;
  const remaining = budgetProjectedRemaining(budget);

  return {
    carriedOver: carried !== 0 ? carried : null,
    projection: hasProjection
      ? {
          spend: projectedSpend,
          remaining: Math.abs(remaining),
          over: remaining < 0,
          confidence: budget.forecast_confidence ?? 'none',
        }
      : null,
  };
}
