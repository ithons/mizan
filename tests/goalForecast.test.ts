import test from 'node:test';
import assert from 'node:assert/strict';
import { addMonths, format } from 'date-fns';
import { buildGoalForecastSummary } from '../client/src/lib/goalForecast';
import type { Goal, RecurringForecast } from '../shared/types';

function goal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: overrides.id ?? 'goal_emergency',
    name: overrides.name ?? 'Emergency fund',
    type: overrides.type ?? 'savings',
    target_amount: overrides.target_amount ?? 1200,
    current_amount: overrides.current_amount ?? 0,
    account_id: overrides.account_id ?? null,
    target_date: overrides.target_date ?? null,
    color: overrides.color ?? '#32bfa3',
    is_archived: overrides.is_archived ?? false,
    created_at: overrides.created_at ?? '2026-01-01T00:00:00.000Z',
    updated_at: overrides.updated_at ?? '2026-01-01T00:00:00.000Z',
    progress_amount: overrides.progress_amount ?? 0,
    remaining_amount: overrides.remaining_amount ?? 1200,
    progress_percent: overrides.progress_percent ?? 0,
    account_name: overrides.account_name ?? null,
    institution_name: overrides.institution_name ?? null,
    account_balance: overrides.account_balance ?? null,
    account_is_liability: overrides.account_is_liability ?? null,
  };
}

function forecast(overrides: Partial<RecurringForecast> = {}): RecurringForecast {
  return {
    days: overrides.days ?? 30,
    income: overrides.income ?? 3000,
    bills: overrides.bills ?? 2400,
    net: overrides.net ?? 600,
    confirmed_income: overrides.confirmed_income ?? 3000,
    confirmed_bills: overrides.confirmed_bills ?? 2400,
    likely_income: overrides.likely_income ?? 0,
    likely_bills: overrides.likely_bills ?? 0,
    uncertain_income: overrides.uncertain_income ?? 0,
    uncertain_bills: overrides.uncertain_bills ?? 0,
    overdue_count: overrides.overdue_count ?? 0,
    review_count: overrides.review_count ?? 0,
    occurrences: overrides.occurrences ?? [],
  };
}

test('goal forecast marks dated goals feasible from recurring surplus', () => {
  const now = new Date('2026-06-30T12:00:00.000Z');
  const targetDate = format(addMonths(now, 6), 'yyyy-MM-dd');

  const summary = buildGoalForecastSummary({
    goals: [goal({ target_date: targetDate, remaining_amount: 1200 })],
    forecast: forecast({ net: 600 }),
    now,
  });

  assert.equal(summary.monthly_available_for_goals, 600);
  assert.equal(summary.expected_monthly_goal_progress, 600);
  assert.equal(summary.on_track_goal_count, 1);
  assert.equal(summary.insights[0].status, 'on_track');
  assert.equal(summary.insights[0].projected_monthly_contribution, 600);
  assert.ok((summary.insights[0].required_monthly_contribution ?? 0) < 220);
});

test('goal forecast blocks progress when recurring cash flow is negative', () => {
  const summary = buildGoalForecastSummary({
    goals: [goal({ target_date: '2026-12-31' })],
    forecast: forecast({ income: 2000, bills: 2400, net: -400 }),
    now: new Date('2026-06-30T12:00:00.000Z'),
  });

  assert.equal(summary.monthly_available_for_goals, -400);
  assert.equal(summary.expected_monthly_goal_progress, 0);
  assert.equal(summary.blocked_goal_count, 1);
  assert.equal(summary.insights[0].severity, 'attention');
});

test('goal forecast subtracts projected budget overages from available surplus', () => {
  const summary = buildGoalForecastSummary({
    goals: [goal({ target_date: '2026-12-31' })],
    forecast: forecast({ net: 500 }),
    budgetOverage: 650,
    now: new Date('2026-06-30T12:00:00.000Z'),
  });

  assert.equal(summary.budget_overage, 650);
  assert.equal(summary.monthly_available_for_goals, -150);
  assert.equal(summary.blocked_goal_count, 1);
  assert.match(summary.insights[0].message, /budget overages/);
});

test('goal forecast allows steady progress without a target date', () => {
  const summary = buildGoalForecastSummary({
    goals: [
      goal({ id: 'emergency', remaining_amount: 900 }),
      goal({ id: 'trip', remaining_amount: 300, target_date: null }),
    ],
    forecast: forecast({ net: 600 }),
    now: new Date('2026-06-30T12:00:00.000Z'),
  });

  const trip = summary.insights.find((insight) => insight.goal_id === 'trip');
  assert.equal(trip?.status, 'no_target');
  assert.equal(trip?.projected_monthly_contribution, 300);
  assert.equal(summary.incomplete_goal_count, 2);
});
