import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeDataQuality } from '../server/src/services/dataQuality';
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
      {
        id: 'duplicate_candidates',
        label: 'Possible duplicates',
        count: 0,
        action_label: 'Review',
        severity: 'warning',
      },
      {
        id: 'transfer_candidates',
        label: 'Detected transfers',
        count: 0,
        action_label: 'Review',
        severity: 'info',
      },
    ],
    rule_suggestions: [],
    recurring_candidates: [],
    duplicate_candidates: [],
    transfer_candidates: [],
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

test('data quality is healthy when core trust inputs are clear', () => {
  const summary = summarizeDataQuality({
    syncHealth: baseSyncHealth(),
    reviewSummary: baseReviewSummary(),
    forecast: baseForecast(),
    reportSummary: baseReportSummary(),
  });

  assert.equal(summary.status, 'healthy');
  assert.equal(summary.score, 100);
  assert.deepEqual(summary.issues, []);
});

test('data quality treats broken sync as attention', () => {
  const summary = summarizeDataQuality({
    syncHealth: baseSyncHealth({
      status: 'attention',
      status_label: 'Needs attention',
      status_detail: '1 connection needs action.',
      attention_count: 1,
    }),
    reviewSummary: baseReviewSummary(),
    forecast: baseForecast(),
    reportSummary: baseReportSummary(),
  });

  assert.equal(summary.status, 'attention');
  assert.equal(summary.score, 65);
  assert.equal(summary.issues[0].id, 'sync-attention');
  assert.equal(summary.issues[0].severity, 'critical');
  assert.equal(summary.issues[0].route, '/accounts');
});

test('data quality combines transaction and cash flow review penalties', () => {
  const review = baseReviewSummary({
    total_open: 12,
    queues: [
      {
        id: 'uncategorized',
        label: 'Needs category',
        count: 8,
        action_label: 'Review',
        severity: 'attention',
      },
      {
        id: 'rule_suggestions',
        label: 'Rule suggestions',
        count: 2,
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
        count: 2,
        action_label: 'Confirm',
        severity: 'info',
      },
      {
        id: 'duplicate_candidates',
        label: 'Possible duplicates',
        count: 0,
        action_label: 'Review',
        severity: 'warning',
      },
      {
        id: 'transfer_candidates',
        label: 'Detected transfers',
        count: 0,
        action_label: 'Review',
        severity: 'info',
      },
    ],
  });

  const summary = summarizeDataQuality({
    syncHealth: baseSyncHealth(),
    reviewSummary: review,
    forecast: baseForecast({ review_count: 3, overdue_count: 1 }),
    reportSummary: baseReportSummary(),
  });

  assert.equal(summary.status, 'review');
  assert.equal(summary.score, 66);
  assert.deepEqual(summary.issues.map((issue) => issue.id), [
    'transaction-review',
    'cash-flow-review',
  ]);
  assert.deepEqual(summary.issues.map((issue) => issue.route), [
    '/review',
    '/bills',
  ]);
});

test('report exclusions are transparent without lowering the trust score', () => {
  const summary = summarizeDataQuality({
    syncHealth: baseSyncHealth(),
    reviewSummary: baseReviewSummary(),
    forecast: baseForecast(),
    reportSummary: baseReportSummary({
      excluded_flows: [
        {
          flow_type: 'transfers',
          count: 4,
          inflows: 1000,
          outflows: 1000,
          net: 0,
        },
      ],
    }),
  });

  assert.equal(summary.status, 'healthy');
  assert.equal(summary.score, 100);
  assert.deepEqual(summary.issues.map((issue) => issue.id), ['report-exclusions']);
});
