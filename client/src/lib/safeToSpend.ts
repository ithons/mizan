import type { Budget, Goal, NetWorthSnapshot, RecurringForecast } from '@shared/types';

/**
 * Liquid cash minus upcoming bills, unspent budget allocations, and money
 * already earmarked for savings goals. Mirrors the metric the advisor context
 * and AI worker call "Safe to Spend".
 */
export function computeSafeToSpend(inputs: {
  snapshot?: NetWorthSnapshot | null;
  forecast?: RecurringForecast | null;
  budgets?: Budget[] | null;
  goals?: Goal[] | null;
}): number {
  const liquid = inputs.snapshot?.liquid_assets ?? 0;
  const upcomingBills = Math.abs(inputs.forecast?.bills ?? 0);
  const allocatedBudgets = (inputs.budgets ?? []).reduce(
    (sum, b) => sum + Math.max(0, b.projected_remaining ?? 0),
    0
  );
  const allocatedGoals = (inputs.goals ?? []).reduce(
    (sum, g) => (g.type === 'savings' ? sum + g.current_amount : sum),
    0
  );
  return Math.max(0, liquid - upcomingBills - allocatedBudgets - allocatedGoals);
}
