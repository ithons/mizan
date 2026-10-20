import test from 'node:test';
import assert from 'node:assert/strict';
import { migratedTestDb } from './helpers/schema';
import { runSupersedeStage } from '../server/src/services/syncManager';
import { startSyncRun } from '../server/src/services/syncHistory';

function stageItems(db: ReturnType<typeof migratedTestDb>, runId: string) {
  return db.prepare("SELECT status, error_message FROM sync_run_items WHERE run_id = ? AND connection_id = 'superseded-drafts'")
    .all(runId) as Array<{ status: string; error_message: string }>;
}

test('a throwing supersede pass is recorded on the run', () => {
  const db = migratedTestDb();
  const run = startSyncRun(db, 'full');
  runSupersedeStage(db, run.id, () => { throw new Error('boom'); });
  assert.deepEqual(stageItems(db, run.id), [{ status: 'failed', error_message: 'boom' }]);
});

test('HEALTHY: a supersede pass over no drafts records nothing on the run', () => {
  const db = migratedTestDb();
  const run = startSyncRun(db, 'full');
  runSupersedeStage(db, run.id);
  assert.deepEqual(stageItems(db, run.id), []);
});
