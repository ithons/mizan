import test from 'node:test';
import assert from 'node:assert/strict';
import { migratedTestDb } from './helpers/schema';
import { listDataImportRuns, recordDataImportRun } from '../server/src/services/importRuns';

// `source` and `status` both carry CHECK constraints in the real schema that the hand-written
// one omitted, so a run recorded under an unknown source used to pass here and fail in production.
const setupDb = migratedTestDb;

test('import runs record audit summaries in newest-first order', (t) => {
  const db = setupDb();
  t.after(() => db.close());

  const first = recordDataImportRun(db, {
    source: 'csv',
    status: 'partial',
    rows_seen: 10,
    rows_imported: 8,
    rows_invalid: 2,
    duplicate_candidates: 1,
    transfer_candidates: 3,
    warnings_count: 4,
    errors_count: 2,
    summary: 'Imported 8 of 10 CSV rows.',
  }, '2026-06-30T12:00:00.000Z');
  const second = recordDataImportRun(db, {
    source: 'backup_restore',
    status: 'succeeded',
    rows_seen: 100,
    rows_imported: 100,
    summary: 'Restored 100 rows from local backup.',
  }, '2026-06-30T13:00:00.000Z');

  assert.equal(first.rows_invalid, 2);
  assert.equal(second.warnings_count, 0);
  assert.deepEqual(
    listDataImportRuns(db).map((run) => [run.source, run.status, run.rows_imported]),
    [
      ['backup_restore', 'succeeded', 100],
      ['csv', 'partial', 8],
    ]
  );
});
