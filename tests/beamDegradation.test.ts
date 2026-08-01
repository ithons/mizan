import test from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import {
  SYNC_HEALTH_PARTIAL,
  render,
  text,
} from './helpers/instrumentHarness';
import { migratedTestDb, TEST_NOW } from './helpers/schema';
import { readLastSyncRun } from '../server/src/services/syncHealth';

/**
 * The beam has to say when it cannot vouch for its reading, and it could not say it.
 *
 * `readCalibration` is a pure function with five faults and `accountBalanceView.test.ts` exercises
 * every one of them by passing the fault in. What nothing exercised was the FEED: whether
 * `syncIncomplete` is ever true for a sheet a partial run wrote. It came from
 * `useAppStore.syncStatus === 'error'`, which the SSE `sync_complete` handler sets and which is
 * initialised to 'idle' on every mount, so it described the current page session and nothing else.
 *
 * Measured 2026-07-31 against a copy of `.mizan/mizan.db` at migration 054:
 *
 *   SELECT status, completed_at, message FROM sync_runs ORDER BY started_at DESC LIMIT 1;
 *   -- partial | 2026-07-31T18:48:51.403Z | Sync finished with issues   (error_code 402)
 *   SELECT date, is_estimated, covered_accounts, total_accounts
 *   FROM net_worth_snapshots ORDER BY date DESC LIMIT 1;
 *   -- 2026-07-31 | 0 | 14 | 14
 *
 * A partial run had written the newest sheet, and on a reloaded page the beam read fully
 * calibrated: `estimated` is false, `stale` is 0 days, `coverage` is 14 of 14, and `sync_incomplete`
 * was false because the event had happened in a session that no longer existed.
 */

function insertRun(
  db: Database.Database,
  overrides: { id: string; status: string; started_at: string; completed_at?: string | null; message?: string }
): void {
  db.prepare(`
    INSERT INTO sync_runs
      (id, scope, status, started_at, completed_at, message, accounts_seen, transactions_added,
       transactions_modified, transactions_removed, transactions_skipped, duplicate_candidates,
       transfer_candidates)
    VALUES (?, 'full', ?, ?, ?, ?, 0, 0, 0, 0, 0, 0, 0)
  `).run(
    overrides.id,
    overrides.status,
    overrides.started_at,
    overrides.completed_at ?? null,
    overrides.message ?? null
  );
}

// ─── The durable half: sync_runs is where "did it finish" lives ───────────────

test('no run yet reads as no claim, not as a finished one', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());
  assert.equal(readLastSyncRun(db), null);
});

test('HEALTHY: the newest run succeeded, so nothing is degraded', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  insertRun(db, { id: 'r1', status: 'partial', started_at: '2026-07-30T00:00:00.000Z', completed_at: '2026-07-30T00:00:05.000Z' });
  insertRun(db, { id: 'r2', status: 'succeeded', started_at: '2026-07-31T00:00:00.000Z', completed_at: '2026-07-31T00:00:05.000Z', message: 'Sync complete' });

  const run = readLastSyncRun(db);
  assert.equal(run?.id, 'r2');
  assert.equal(run?.incomplete, false, 'a clean run must clear the earlier partial one');
});

test('a partial run is durable: it is still readable in a session that never saw it', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  insertRun(db, { id: 'r1', status: 'succeeded', started_at: '2026-07-30T00:00:00.000Z', completed_at: '2026-07-30T00:00:05.000Z' });
  insertRun(db, {
    id: 'r2',
    status: 'partial',
    started_at: '2026-07-31T18:48:47.269Z',
    completed_at: '2026-07-31T18:48:51.403Z',
    message: 'Sync finished with issues',
  });

  const run = readLastSyncRun(db);
  assert.equal(run?.id, 'r2');
  assert.equal(run?.status, 'partial');
  assert.equal(run?.incomplete, true);
  assert.equal(run?.message, 'Sync finished with issues');
});

test('a failed run is incomplete too', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());
  insertRun(db, { id: 'r1', status: 'failed', started_at: TEST_NOW, completed_at: TEST_NOW });
  assert.equal(readLastSyncRun(db)?.incomplete, true);
});

test('a run still in flight makes no claim either way', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  insertRun(db, { id: 'r1', status: 'succeeded', started_at: '2026-07-31T00:00:00.000Z', completed_at: '2026-07-31T00:00:05.000Z' });
  insertRun(db, { id: 'r2', status: 'running', started_at: '2026-07-31T01:00:00.000Z', completed_at: null });

  // The four seconds a sync takes must not put the whole instrument into a degraded state, and a
  // run that has not finished has not said anything about whether it will.
  const run = readLastSyncRun(db);
  assert.equal(run?.id, 'r1');
  assert.equal(run?.incomplete, false);
});

// ─── The rendered half: the beam says it ──────────────────────────────────────

test('HEALTHY: a run that finished raises no sync fault on the beam', () => {
  // The harness sheet is 2026-07-30 against whatever day this runs on, so a `stale` fault is
  // expected here and is not what this asserts. The claim is narrower and exact: the run finished,
  // so the run says nothing.
  const body = text(render('this-month'));
  assert.doesNotMatch(body, /The last sync did not finish every stage/);
});

test('a sheet written by a partial run reads uncalibrated on a page that never saw the run', () => {
  const body = text(render('this-month', { syncHealth: SYNC_HEALTH_PARTIAL }));
  assert.match(body, /Uncalibrated/);
  assert.match(body, /The last sync did not finish every stage\./);
});
