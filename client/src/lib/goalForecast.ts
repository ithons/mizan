import { differenceInCalendarDays, isValid, parseISO } from 'date-fns';
import type { Goal, RecurringForecast } from '@shared/types';

const MONTH_DAYS = 30.4375;

export type GoalForecastStatus = 'complete' | 'on_track' | 'behind' | 'blocked' | 'no_target';
export type GoalForecastSeverity = 'positive' | 'warning' | 'attention' | 'info';

export interface GoalForecastInsight {
  goal_id: string;
  status: GoalForecastStatus;
  severity: GoalForecastSeverity;
  expected_monthly_progress: number;
  projected_monthly_contribution: number;
  required_monthly_contribution: number | null;
  monthly_shortfall: number;
  months_until_target: number | null;
  message: string;
}

export interface GoalForecastSummary {
  forecast_days: number;
  monthly_recurring_surplus: number;
  budget_overage: number;
  monthly_available_for_goals: number;
  expected_monthly_goal_progress: number;
  incomplete_goal_count: number;
  on_track_goal_count: number;
  at_risk_goal_count: number;
  blocked_goal_count: number;
  insights: GoalForecastInsight[];
}

export interface GoalForecastInput {
  goals: Goal[];
  forecast?: RecurringForecast;
  budgetOverage?: number;
  now?: Date;
}

function monthlyRecurringSurplus(forecast?: RecurringForecast): number {
  if (!forecast || forecast.days <= 0) return 0;
  return forecast.net * (30 / forecast.days);
}

function targetMonths(targetDate: string | null | undefined, now: Date): number | null {
  if (!targetDate) return null;
  const parsed = parseISO(targetDate);
  if (!isValid(parsed)) return null;
  const days = differenceInCalendarDays(parsed, now);
  return Math.max(days / MONTH_DAYS, 0);
}

function goalMessage(
  goal: Goal,
  status: GoalForecastStatus,
  expectedMonthlyProgress: number,
  requiredMonthlyContribution: number | null,
  budgetOverage: number
): string {
  if (status === 'complete') return 'Goal is already complete.';
  if (status === 'blocked') {
    return budgetOverage > 0
      ? 'Current recurring cash flow and projected budget overages leave no monthly surplus for this goal.'
      : 'Current recurring cash flow leaves no projected monthly surplus for this goal.';
  }
  if (status === 'no_target') {
    return expectedMonthlyProgress > 0
      ? 'No target date is set, but recurring cash flow can still fund steady progress.'
      : 'No target date is set and recurring cash flow does not show surplus for progress yet.';
  }
  if (status === 'behind') {
    return `Needs about ${Math.ceil(requiredMonthlyContribution ?? 0)} per month, more than projected recurring surplus can cover.`;
  }
  return `${goal.name} is feasible from projected recurring surplus if this allocation holds.`;
}

export function buildGoalForecastSummary({
  goals,
  forecast,
  budgetOverage = 0,
  now = new Date(),
}: GoalForecastInput): GoalForecastSummary {
  const incompleteGoals = goals.filter((goal) => goal.remaining_amount > 0);
  const monthlySurplus = monthlyRecurringSurplus(forecast);
  const normalizedBudgetOverage = Math.max(0, budgetOverage);
  const monthlyAvailable = monthlySurplus - normalizedBudgetOverage;
  const positiveAvailable = Math.max(0, monthlyAvailable);
  const projectedPerGoal = incompleteGoals.length > 0 ? positiveAvailable / incompleteGoals.length : 0;

  const insights = goals.map((goal): GoalForecastInsight => {
    if (goal.remaining_amount <= 0) {
      return {
        goal_id: goal.id,
        status: 'complete',
        severity: 'positive',
        expected_monthly_progress: 0,
        projected_monthly_contribution: 0,
        required_monthly_contribution: 0,
        monthly_shortfall: 0,
        months_until_target: 0,
        message: goalMessage(goal, 'complete', 0, 0, normalizedBudgetOverage),
      };
    }

    const expectedMonthlyProgress = Math.min(goal.remaining_amount, projectedPerGoal);
    const monthsUntilTarget = targetMonths(goal.target_date, now);

    if (positiveAvailable <= 0) {
      return {
        goal_id: goal.id,
        status: 'blocked',
        severity: 'attention',
        expected_monthly_progress: 0,
        projected_monthly_contribution: 0,
        required_monthly_contribution: monthsUntilTarget && monthsUntilTarget > 0
          ? goal.remaining_amount / monthsUntilTarget
          : null,
        monthly_shortfall: monthsUntilTarget && monthsUntilTarget > 0
          ? goal.remaining_amount / monthsUntilTarget
          : goal.remaining_amount,
        months_until_target: monthsUntilTarget,
        message: goalMessage(goal, 'blocked', 0, null, normalizedBudgetOverage),
      };
    }

    if (monthsUntilTarget === null) {
      return {
        goal_id: goal.id,
        status: 'no_target',
        severity: 'info',
        expected_monthly_progress: expectedMonthlyProgress,
        projected_monthly_contribution: projectedPerGoal,
        required_monthly_contribution: null,
        monthly_shortfall: 0,
        months_until_target: null,
        message: goalMessage(goal, 'no_target', expectedMonthlyProgress, null, normalizedBudgetOverage),
      };
    }

    const requiredMonthlyContribution = monthsUntilTarget > 0
      ? goal.remaining_amount / monthsUntilTarget
      : goal.remaining_amount;
    const monthlyShortfall = Math.max(0, requiredMonthlyContribution - projectedPerGoal);
    const status: GoalForecastStatus = monthlyShortfall > 0.01 ? 'behind' : 'on_track';

    return {
      goal_id: goal.id,
      status,
      severity: status === 'on_track' ? 'positive' : 'warning',
      expected_monthly_progress: expectedMonthlyProgress,
      projected_monthly_contribution: projectedPerGoal,
      required_monthly_contribution: requiredMonthlyContribution,
      monthly_shortfall: monthlyShortfall,
      months_until_target: monthsUntilTarget,
      message: goalMessage(goal, status, expectedMonthlyProgress, requiredMonthlyContribution, normalizedBudgetOverage),
    };
  });

  return {
    forecast_days: forecast?.days ?? 0,
    monthly_recurring_surplus: monthlySurplus,
    budget_overage: normalizedBudgetOverage,
    monthly_available_for_goals: monthlyAvailable,
    expected_monthly_goal_progress: Math.min(
      incompleteGoals.reduce((sum, goal) => sum + goal.remaining_amount, 0),
      positiveAvailable
    ),
    incomplete_goal_count: incompleteGoals.length,
    on_track_goal_count: insights.filter((insight) => insight.status === 'on_track').length,
    at_risk_goal_count: insights.filter((insight) => insight.status === 'behind').length,
    blocked_goal_count: insights.filter((insight) => insight.status === 'blocked').length,
    insights,
  };
}
