import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAdvisorActions } from '../server/src/services/aiContext';
import type {
  RecurringForecast,
  ReportSummary,
  SyncHealth,
  TransactionReviewSummary,
} from '../shared/types';

function baseSyncHealth(overrides: Partial<SyncHealth> = {}): SyncHealth {
  return {
    status: 'healthy',
    status_label: 'Fresh',
    status_detail: 'All connected institutions are fresh enough for reports and advisor context.',
    connection_count: 1,
    stale_count: 0,
    attention_count: 0,
    fresh_count: 1,
    never_synced_count: 0,
    last_synced_at: '2026-06-30T12:00:00.000Z',
    connections: [],
    ...overrides,
  };
}

function baseReportSummary(overrides: Partial<ReportSummary> = {}): ReportSummary {
  return {
    start_date: '2026-06-01',
    end_date: '2026-06-30',
    previous_start_date: '2026-05-02',
    previous_end_date: '2026-05-31',
    income: { current: 5000, previous: 5000, delta: 0, delta_percent: 0 },
    expenses: { current: 3000, previous: 3000, delta: 0, delta_percent: 0 },
    net: { current: 2000, previous: 2000, delta: 0, delta_percent: 0 },
    savings_rate: { current: 40, previous: 40, delta: 0, delta_percent: 0 },
    top_spending: [],
    top_income: [],
    spending_movers: [],
    excluded_flows: [],
    ...overrides,
  };
}

function baseReviewSummary(overrides: Partial<TransactionReviewSummary> = {}): TransactionReviewSummary {
  return {
    total_open: 0,
    queues: [
      {
        id: 'uncategorized',
        label: 'Needs category',
        count: 0,
        action_label: 'Review',
        severity: 'attention',
      },
      {
        id: 'rule_suggestions',
        label: 'Rule suggestions',
        count: 0,
        action_label: 'Apply',
        severity: 'info',
      },
      {
        id: 'pending',
        label: 'Pending',
        count: 0,
        action_label: 'Review',
        severity: 'warning',
      },
      {
        id: 'recurring_candidates',
        label: 'Recurring candidates',
        count: 0,
        action_label: 'Confirm',
        severity: 'info',
      },
    ],
    rule_suggestions: [],
    recurring_candidates: [],
    ...overrides,
  };
}

function baseForecast(overrides: Partial<RecurringForecast> = {}): RecurringForecast {
  return {
    days: 60,
    income: 0,
    bills: 0,
    net: 0,
    confirmed_income: 0,
    confirmed_bills: 0,
    likely_income: 0,
    likely_bills: 0,
    uncertain_income: 0,
    uncertain_bills: 0,
    overdue_count: 0,
    review_count: 0,
    occurrences: [],
    ...overrides,
  };
}

test('advisor actions prioritize stale or broken sync health', () => {
  const actions = buildAdvisorActions({
    syncHealth: baseSyncHealth({
      status: 'attention',
      status_label: 'Needs attention',
      status_detail: '1 connection needs action.',
      attention_count: 1,
    }),
    reportSummary: baseReportSummary(),
    reviewSummary: baseReviewSummary(),
    forecast: baseForecast(),
  });

  assert.equal(actions[0].id, 'fix-sync');
  assert.equal(actions[0].route, '/accounts');
  assert.equal(actions[0].severity, 'critical');
});

test('advisor actions include review, cash flow, and report workflow prompts', () => {
  const review = baseReviewSummary();
  review.queues = review.queues.map((queue) =>
    queue.id === 'uncategorized'
      ? { ...queue, count: 12 }
      : queue.id === 'rule_suggestions'
        ? { ...queue, count: 2 }
        : queue
  );
  review.total_open = 14;

  const actions = buildAdvisorActions({
    syncHealth: baseSyncHealth(),
    reportSummary: baseReportSummary({
      expenses: { current: 4200, previous: 3000, delta: 1200, delta_percent: 40 },
      savings_rate: { current: 8, previous: 40, delta: -32, delta_percent: -80 },
    }),
    reviewSummary: review,
    forecast: baseForecast({ review_count: 2, overdue_count: 1 }),
  });

  const ids = actions.map((item) => item.id);
  assert.ok(ids.includes('review-transactions'));
  assert.ok(ids.includes('review-cash-flow'));
  assert.ok(ids.includes('explain-spending-change'));
  assert.ok(ids.includes('improve-savings-rate'));
});

test('advisor actions fall back to a health review when no workflow is urgent', () => {
  const actions = buildAdvisorActions({
    syncHealth: baseSyncHealth(),
    reportSummary: baseReportSummary(),
    reviewSummary: baseReviewSummary(),
    forecast: baseForecast(),
  });

  assert.deepEqual(actions.map((item) => item.id), ['financial-health-review']);
});
