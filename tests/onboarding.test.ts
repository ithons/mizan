import test from 'node:test';
import assert from 'node:assert/strict';
import { getOnboardingPlan } from '../client/src/lib/onboarding';
import type { CredentialStatus, SyncHealth, TransactionReviewSummary } from '../shared/types';

function credentialStatus(overrides: Partial<CredentialStatus> = {}): CredentialStatus {
  return {
    simplefin: false,
    coinbase: false,
    coinbaseFromEnv: false,
    ...overrides,
  };
}

function syncHealth(overrides: Partial<SyncHealth> = {}): SyncHealth {
  return {
    status: 'empty',
    status_label: 'No connections',
    status_detail: 'No connected institutions',
    connection_count: 0,
    stale_count: 0,
    attention_count: 0,
    fresh_count: 0,
    never_synced_count: 0,
    // Nothing is connected in this fixture, so no run has ever finished.
    last_run: null,
    connections: [],
    ...overrides,
  };
}

function reviewSummary(totalOpen: number): TransactionReviewSummary {
  return {
    total_open: totalOpen,
    queues: [],
    rule_suggestions: [],
    recurring_candidates: [],
    duplicate_candidates: [],
    transfer_candidates: [],
    ai_drafts: [],
  };
}

test('onboarding starts with credentials when nothing is configured', () => {
  const plan = getOnboardingPlan({
    accountCount: 0,
    credentialStatus: credentialStatus(),
    syncHealth: syncHealth(),
    reviewSummary: reviewSummary(0),
  });

  assert.equal(plan.currentStep.id, 'credentials');
  assert.equal(plan.steps[0].status, 'active');
  assert.equal(plan.percentComplete, 0);
});

test('onboarding moves to source connection after SimpleFIN credentials exist', () => {
  const plan = getOnboardingPlan({
    accountCount: 0,
    credentialStatus: credentialStatus({ simplefin: true }),
    syncHealth: syncHealth(),
    reviewSummary: reviewSummary(0),
  });

  assert.equal(plan.currentStep.id, 'source');
  assert.equal(plan.steps.find((step) => step.id === 'credentials')?.status, 'complete');
});

test('manual or imported accounts do not block on provider sync', () => {
  const plan = getOnboardingPlan({
    accountCount: 1,
    credentialStatus: credentialStatus(),
    syncHealth: syncHealth({ status: 'empty' }),
    reviewSummary: reviewSummary(0),
  });

  assert.equal(plan.currentStep.id, 'dashboard');
  assert.equal(plan.steps.find((step) => step.id === 'sync')?.status, 'complete');
  assert.equal(plan.steps.find((step) => step.id === 'review')?.status, 'complete');
});

test('live accounts must clear sync attention before review', () => {
  const plan = getOnboardingPlan({
    accountCount: 2,
    credentialStatus: credentialStatus({ simplefin: true }),
    syncHealth: syncHealth({
      status: 'attention',
      status_label: 'Needs attention',
      status_detail: 'Reconnect this institution.',
      connection_count: 1,
      attention_count: 1,
    }),
    reviewSummary: reviewSummary(4),
  });

  assert.equal(plan.currentStep.id, 'sync');
  assert.equal(plan.currentStep.actionLabel, 'Repair sync');
  assert.equal(plan.steps.find((step) => step.id === 'review')?.status, 'pending');
});

test('healthy sync with review items routes to the Review Inbox', () => {
  const plan = getOnboardingPlan({
    accountCount: 3,
    credentialStatus: credentialStatus({ simplefin: true }),
    syncHealth: syncHealth({
      status: 'healthy',
      status_label: 'Healthy',
      status_detail: 'Fresh',
      connection_count: 1,
      fresh_count: 1,
      last_synced_at: '2026-06-30T12:00:00.000Z',
    }),
    reviewSummary: reviewSummary(2),
  });

  assert.equal(plan.currentStep.id, 'review');
  assert.equal(plan.steps.find((step) => step.id === 'sync')?.status, 'complete');
});
