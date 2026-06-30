import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { listDataImportRuns, recordDataImportRun } from '../server/src/services/importRuns';

function setupDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE data_import_runs (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      rows_seen INTEGER NOT NULL DEFAULT 0,
      rows_imported INTEGER NOT NULL DEFAULT 0,
      rows_invalid INTEGER NOT NULL DEFAULT 0,
      duplicate_candidates INTEGER NOT NULL DEFAULT 0,
      transfer_candidates INTEGER NOT NULL DEFAULT 0,
      warnings_count INTEGER NOT NULL DEFAULT 0,
      errors_count INTEGER NOT NULL DEFAULT 0,
      summary TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

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
