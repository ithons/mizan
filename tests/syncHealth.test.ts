import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifySyncConnection,
  summarizeSyncHealth,
  type SyncHealthConnectionRow,
} from '../server/src/services/syncHealth';

const NOW = new Date('2026-06-30T12:00:00.000Z');

function row(overrides: Partial<SyncHealthConnectionRow>): SyncHealthConnectionRow {
  return {
    id: 'conn_1',
    provider: 'plaid',
    institution_name: 'Test Bank',
    status: 'active',
    last_synced_at: '2026-06-30T08:00:00.000Z',
    account_count: 2,
    ...overrides,
  };
}

test('classifies fresh active connections', () => {
  const connection = classifySyncConnection(row({}), NOW);

  assert.equal(connection.freshness, 'fresh');
  assert.equal(connection.is_stale, false);
  assert.equal(connection.needs_attention, false);
  assert.equal(connection.recommended_action, 'none');
  assert.equal(connection.status_label, 'Synced');
});

test('classifies active connections with old successful syncs as stale', () => {
  const connection = classifySyncConnection(
    row({ last_synced_at: '2026-06-25T08:00:00.000Z' }),
    NOW
  );

  assert.equal(connection.freshness, 'stale');
  assert.equal(connection.is_stale, true);
  assert.equal(connection.needs_attention, false);
  assert.equal(connection.recommended_action, 'sync');
  assert.equal(connection.status_label, '5d old');
});

test('classifies active connections with no successful sync as never synced', () => {
  const connection = classifySyncConnection(row({ last_synced_at: null }), NOW);

  assert.equal(connection.freshness, 'never');
  assert.equal(connection.is_stale, true);
  assert.equal(connection.recommended_action, 'sync');
  assert.equal(connection.last_success_at, null);
});

test('classifies reauth and sync failures as attention states', () => {
  const reauth = classifySyncConnection(row({ status: 'reauth_required' }), NOW);
  const failed = classifySyncConnection(row({ status: 'sync_error' }), NOW);

  assert.equal(reauth.freshness, 'attention');
  assert.equal(reauth.needs_attention, true);
  assert.equal(reauth.recommended_action, 'reconnect');
  assert.equal(reauth.failure_reason, 'Institution login expired');

  assert.equal(failed.freshness, 'attention');
  assert.equal(failed.needs_attention, true);
  assert.equal(failed.recommended_action, 'retry');
  assert.equal(failed.failure_reason, 'Last sync attempt failed');
});

test('summarizes global sync health by most urgent state', () => {
  const fresh = classifySyncConnection(row({ id: 'fresh' }), NOW);
  const stale = classifySyncConnection(row({ id: 'stale', last_synced_at: '2026-06-25T08:00:00.000Z' }), NOW);
  const attention = classifySyncConnection(row({ id: 'attention', status: 'sync_error' }), NOW);

  assert.deepEqual(summarizeSyncHealth([]), {
    status: 'empty',
    status_label: 'Not connected',
    status_detail: 'Connect an institution or add manual accounts to start tracking finances.',
    connection_count: 0,
    stale_count: 0,
    attention_count: 0,
    fresh_count: 0,
    never_synced_count: 0,
    last_synced_at: null,
    connections: [],
  });

  const staleSummary = summarizeSyncHealth([fresh, stale]);
  assert.equal(staleSummary.status, 'stale');
  assert.equal(staleSummary.stale_count, 1);
  assert.equal(staleSummary.fresh_count, 1);

  const attentionSummary = summarizeSyncHealth([fresh, stale, attention]);
  assert.equal(attentionSummary.status, 'attention');
  assert.equal(attentionSummary.attention_count, 1);
});
