import test from 'node:test';
import assert from 'node:assert/strict';
import { getDashboardMode } from '../client/src/lib/dashboardState';
import type {
  DataQualitySummary,
  RecurringForecast,
  SyncHealth,
  TransactionReviewSummary,
} from '../shared/types';

function syncHealth(status: SyncHealth['status']): SyncHealth {
  return {
    status,
    status_label: status,
    status_detail: status,
    connection_count: status === 'empty' ? 0 : 1,
    stale_count: status === 'stale' ? 1 : 0,
    attention_count: status === 'attention' ? 1 : 0,
    fresh_count: status === 'healthy' ? 1 : 0,
    never_synced_count: 0,
    last_synced_at: null,
    connections: [],
  };
}

function review(totalOpen: number): TransactionReviewSummary {
  return {
    total_open: totalOpen,
    queues: [],
    rule_suggestions: [],
    recurring_candidates: [],
    duplicate_candidates: [],
    transfer_candidates: [],
  };
}

function forecast(net: number): RecurringForecast {
  return {
    days: 30,
    income: 0,
    bills: Math.abs(Math.min(net, 0)),
    net,
    confirmed_income: 0,
    confirmed_bills: 0,
    likely_income: 0,
    likely_bills: 0,
    uncertain_income: 0,
    uncertain_bills: 0,
    overdue_count: 0,
    review_count: 0,
    occurrences: [],
  };
}

function quality(status: DataQualitySummary['status']): DataQualitySummary {
  return {
    status,
    status_label: status,
    status_detail: status,
    score: 100,
    issues: [],
  };
}

test('dashboard mode starts with first run when no accounts are connected', () => {
  assert.equal(getDashboardMode({
    accountCount: 0,
    syncHealth: syncHealth('empty'),
  }), 'first_run');
});

test('dashboard mode prioritizes sync repair over review and forecast warnings', () => {
  assert.equal(getDashboardMode({
    accountCount: 2,
    syncHealth: syncHealth('stale'),
    reviewSummary: review(4),
    forecast: forecast(-100),
  }), 'sync_repair');

  assert.equal(getDashboardMode({
    accountCount: 2,
    syncHealth: syncHealth('healthy'),
    dataQuality: quality('attention'),
    reviewSummary: review(4),
  }), 'sync_repair');
});

test('dashboard mode selects review backlog before forecast warnings', () => {
  assert.equal(getDashboardMode({
    accountCount: 2,
    syncHealth: syncHealth('healthy'),
    reviewSummary: review(3),
    forecast: forecast(-100),
  }), 'review_backlog');
});

test('dashboard mode falls through to forecast warning or clean overview', () => {
  assert.equal(getDashboardMode({
    accountCount: 2,
    syncHealth: syncHealth('healthy'),
    reviewSummary: review(0),
    forecast: forecast(-100),
  }), 'forecast_warning');

  assert.equal(getDashboardMode({
    accountCount: 2,
    syncHealth: syncHealth('healthy'),
    reviewSummary: review(0),
    forecast: forecast(100),
  }), 'clean_overview');
});
