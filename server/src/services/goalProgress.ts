import type { GoalType } from '../../../shared/types';

export interface GoalProgressInput {
  type: GoalType;
  target_amount: number;
  current_amount: number;
  starting_amount?: number | null;
  account_balance?: number | null;
}

export interface GoalProgressResult {
  current_amount: number;
  progress_amount: number;
  remaining_amount: number;
  progress_percent: number;
}

export function calculateGoalProgress(row: GoalProgressInput): GoalProgressResult {
  let currentAmount = row.current_amount;

  if (row.account_balance !== null && row.account_balance !== undefined) {
    if (row.type === 'savings') {
      currentAmount = Math.max(row.account_balance, 0);
    } else {
      const startingAmount = row.starting_amount ?? row.target_amount;
      currentAmount = Math.max(startingAmount - row.account_balance, 0);
    }
  }

  const progressAmount = Math.min(currentAmount, row.target_amount);
  const remainingAmount = Math.max(row.target_amount - progressAmount, 0);
  const progressPercent = row.target_amount > 0
    ? Math.min((progressAmount / row.target_amount) * 100, 100)
    : 0;

  // All amounts stay in cents (percent is a ratio); consumers dollarize at their
  // own response/display boundary.
  return {
    current_amount: currentAmount,
    progress_amount: progressAmount,
    remaining_amount: remainingAmount,
    progress_percent: progressPercent,
  };
}
