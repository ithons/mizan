import test from 'node:test';
import assert from 'node:assert/strict';
import { migratedTestDb } from './helpers/schema';
import { runNotificationStage } from '../server/src/services/syncManager';
import { finishSyncRun, startSyncRun } from '../server/src/services/syncHistory';

function finishedRun(status: 'succeeded' | 'failed') {
  const db = migratedTestDb();
  const run = startSyncRun(db, 'full');
  finishSyncRun(db, run.id, { status });
  return { db, runId: run.id };
}

function stageItems(db: ReturnType<typeof migratedTestDb>, runId: string) {
  return db.prepare("SELECT status, error_message FROM sync_run_items WHERE run_id = ? AND connection_id = 'notifications'")
    .all(runId) as Array<{ status: string; error_message: string }>;
}

test('a throwing evaluation is recorded on the run and leaves its outcome alone', () => {
  const { db, runId } = finishedRun('succeeded');
  const result = runNotificationStage(db, runId, () => { throw new Error('boom'); });
  assert.equal(result, null);
  assert.deepEqual(stageItems(db, runId), [{ status: 'failed', error_message: 'boom' }]);
  assert.equal((db.prepare('SELECT status FROM sync_runs WHERE id = ?').get(runId) as { status: string }).status, 'succeeded');
});

test('HEALTHY: a quiet evaluation records nothing on the run', () => {
  const { db, runId } = finishedRun('succeeded');
  const result = runNotificationStage(db, runId);
  assert.deepEqual(result?.created, []);
  assert.deepEqual(stageItems(db, runId), []);
});

test('the run that just failed is the one sync_failed reports', () => {
  const { db, runId } = finishedRun('failed');
  const result = runNotificationStage(db, runId);
  assert.deepEqual(result?.created.map((n) => n.dedupe_key), [`sync_failed:${runId}`]);
  assert.deepEqual(stageItems(db, runId), []);
});
