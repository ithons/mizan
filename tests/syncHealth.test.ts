import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifySyncConnection,
  getSyncHealth,
  summarizeSyncHealth,
  type SyncHealthConnectionRow,
} from '../server/src/services/syncHealth';
import { classifySimplefinFailure } from '../server/src/services/simplefin';
import { migratedTestDb } from './helpers/schema';

const NOW = new Date('2026-06-30T12:00:00.000Z');

// The two `getSyncHealth` tests below seed rows dated 2026-08-01 and must judge them against a
// clock anchored to those rows. Passing nothing reads the wall clock, which is how the healthy
// case asserted `fresh` on the day it was written and `stale` every day after.
const SYNC_RUN_CLOCK = new Date('2026-08-01T17:00:00.000Z');

function row(overrides: Partial<SyncHealthConnectionRow>): SyncHealthConnectionRow {
  return {
    id: 'conn_1',
    provider: 'simplefin',
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
    last_run: null,
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

/**
 * A transport failure says what it means, and the surfaces read it rather than guessing.
 *
 * The defect this pins: SimpleFIN answered 402, and every surface told the owner to retry the sync
 * and re-check the setup token. SimpleFIN Bridge is a paid service and 402 is how it reports a
 * lapsed subscription, so neither action could ever have cleared it. The advice was invented from
 * the coarse connection status while the specific cause sat unread in the same database.
 */
test('a 402 is a lapsed subscription, and it is never reported as something retrying can fix', () => {
  const failure = classifySimplefinFailure({ response: { status: 402 } });
  assert.equal(failure.kind, 'payment_required');
  assert.equal(failure.statusCode, 402);
  assert.equal(failure.retryable, false);
  assert.equal(failure.ownerActsOutsideApp, true);
  assert.match(failure.recoveryAction, /402 Payment Required/);
  assert.match(failure.recoveryAction, /bridge\.simplefin\.org/);
  // The two things the old sentence told the owner to do, neither of which moves a 402.
  assert.doesNotMatch(failure.recoveryAction, /check SimpleFIN setup token/i);
  assert.ok(
    !/^retry/i.test(failure.recoveryAction),
    `advice for a payment failure may not open by telling the owner to retry: ${failure.recoveryAction}`
  );
});

test('every transport failure kind declares advice, and only the retryable ones invite a retry', () => {
  const cases: Array<[unknown, string, boolean]> = [
    [{ response: { status: 402 } }, 'payment_required', false],
    [{ response: { status: 401 } }, 'unauthorized', false],
    [{ response: { status: 403 } }, 'unauthorized', false],
    [{ response: { status: 404 } }, 'not_found', false],
    [{ response: { status: 429 } }, 'rate_limited', true],
    [{ response: { status: 503 } }, 'provider_down', true],
    [{ response: { status: 418 } }, 'unknown', true],
    [new Error('socket hang up'), 'unreachable', true],
  ];
  for (const [err, kind, retryable] of cases) {
    const failure = classifySimplefinFailure(err);
    assert.equal(failure.kind, kind, `${JSON.stringify(err)} should classify as ${kind}`);
    assert.equal(failure.retryable, retryable, `${kind} retryable`);
    assert.ok(failure.recoveryAction.length > 20, `${kind} has no real advice`);
    // A failure the owner has to resolve at the provider must not be described as self-clearing.
    if (failure.ownerActsOutsideApp) {
      assert.doesNotMatch(failure.recoveryAction, /next scheduled sync will try again/);
    }
  }
});

test('the connection surface states the recorded reason, not a generic one', () => {
  const db = migratedTestDb();
  db.prepare(`INSERT INTO simplefin_connections (id, status, created_at) VALUES ('simplefin_primary', 'sync_error', '2026-08-01T16:00:00.000Z')`).run();
  db.prepare(`INSERT INTO sync_runs (id, scope, status, started_at, completed_at) VALUES ('run_1', 'full', 'partial', '2026-08-01T16:04:00.000Z', '2026-08-01T16:04:25.000Z')`).run();
  db.prepare(`
    INSERT INTO sync_run_items (id, run_id, provider, connection_id, institution_name, status, error_message, recovery_action, started_at, completed_at)
    VALUES ('item_1', 'run_1', 'simplefin', 'simplefin_primary', 'SimpleFIN', 'failed',
            'Request failed with status code 402 (HTTP 402)',
            'SimpleFIN returned 402 Payment Required, which is how SimpleFIN Bridge reports a lapsed subscription. Renew it at bridge.simplefin.org; retrying and re-pasting the setup token cannot clear this.',
            '2026-08-01T16:04:20.000Z', '2026-08-01T16:04:22.940Z')
  `).run();

  const health = getSyncHealth(db, SYNC_RUN_CLOCK);
  const conn = health.connections.find((c) => c.id === 'simplefin_primary');
  assert.ok(conn, 'the connection is missing from sync health');
  assert.match(conn.status_detail, /402 Payment Required/);
  assert.doesNotMatch(conn.status_detail, /reconnect the institution/i);
  db.close();
});

test('HEALTHY: a connection that has never failed carries no failure advice at all', () => {
  const db = migratedTestDb();
  db.prepare(`INSERT INTO simplefin_connections (id, status, last_synced_at, created_at) VALUES ('simplefin_primary', 'active', '2026-08-01T16:04:25.000Z', '2026-07-01T00:00:00.000Z')`).run();
  db.prepare(`INSERT INTO sync_runs (id, scope, status, started_at, completed_at) VALUES ('run_ok', 'full', 'succeeded', '2026-08-01T16:04:00.000Z', '2026-08-01T16:04:25.000Z')`).run();
  db.prepare(`
    INSERT INTO sync_run_items (id, run_id, provider, connection_id, institution_name, status, started_at, completed_at)
    VALUES ('item_ok', 'run_ok', 'simplefin', 'simplefin_primary', 'SimpleFIN', 'succeeded',
            '2026-08-01T16:04:20.000Z', '2026-08-01T16:04:22.000Z')
  `).run();

  const health = getSyncHealth(db, SYNC_RUN_CLOCK);
  const conn = health.connections.find((c) => c.id === 'simplefin_primary');
  assert.ok(conn, 'the connection is missing from sync health');
  assert.equal(conn.needs_attention, false);
  assert.equal(conn.freshness, 'fresh');
  assert.doesNotMatch(conn.status_detail, /402|retry|reconnect/i);
  db.close();
});

test('getSyncHealth judges freshness against the clock it is handed, not the wall clock', () => {
  const db = migratedTestDb();
  db.prepare(`INSERT INTO simplefin_connections (id, status, last_synced_at, created_at) VALUES ('simplefin_primary', 'active', '2026-08-01T16:04:25.000Z', '2026-07-01T00:00:00.000Z')`).run();

  // One hour after the recorded sync: fresh, and it stays fresh however long ago that was in
  // real time. This is the assertion that rotted, and the parameter is what stops it rotting.
  const justAfter = getSyncHealth(db, new Date('2026-08-01T17:04:25.000Z'));
  assert.equal(justAfter.connections[0].freshness, 'fresh');
  assert.equal(justAfter.status, 'healthy');

  // Four days after: stale. Without a threaded clock this direction is the only one the wall
  // clock can ever produce, so asserting it alone would prove nothing about the parameter.
  const fourDaysLater = getSyncHealth(db, new Date('2026-08-05T17:04:25.000Z'));
  assert.equal(fourDaysLater.connections[0].freshness, 'stale');
  assert.equal(fourDaysLater.status, 'stale');
  assert.equal(fourDaysLater.connections[0].age_days, 4);

  db.close();
});
