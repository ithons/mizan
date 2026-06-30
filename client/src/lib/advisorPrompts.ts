import type { AdvisorRoutePrompt } from './advisorRouteState';
import type { Budget } from '@shared/types';

function availableBudgetAmount(budget: Budget): number {
  return budget.amount + (budget.rollover ? budget.rollover_balance : 0);
}

function formatMoneyValue(value: number): string {
  return `$${value.toFixed(2)}`;
}

export function buildBudgetAdvisorPrompt(budget: Budget, month: string): AdvisorRoutePrompt {
  const spent = budget.spent ?? 0;
  const available = availableBudgetAmount(budget);
  const projectedSpend = budget.projected_spend ?? spent;
  const expectedRecurring = budget.expected_recurring ?? 0;
  const projectedRemaining = budget.projected_remaining ?? available - projectedSpend;
  const categoryName = budget.category_name ?? 'this category';
  const confidence = budget.forecast_confidence ?? 'none';

  return {
    source: 'budget',
    recordKind: 'budget_row',
    recordId: `${month}:${budget.category_id}`,
    params: {
      month,
      categoryId: budget.category_id,
      actualSpent: spent,
      projectedSpend,
      available,
      expectedRecurring,
      projectedRemaining,
      confidence,
    },
    prompt: [
      `Analyze my ${categoryName} budget for ${month}.`,
      `Actual spending is ${formatMoneyValue(spent)} against ${formatMoneyValue(available)} available.`,
      `Projected spending is ${formatMoneyValue(projectedSpend)}, including ${formatMoneyValue(expectedRecurring)} expected recurring activity.`,
      `Projected remaining is ${formatMoneyValue(projectedRemaining)} with ${confidence} forecast confidence.`,
      'Explain whether I am likely to stay under budget, what is driving the projection, and what I should review next.',
    ].join(' '),
  };
}
