import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import type { DataImportRun } from '../../../shared/types';

export interface RecordDataImportRunInput {
  source: DataImportRun['source'];
  status: DataImportRun['status'];
  rows_seen: number;
  rows_imported: number;
  rows_invalid?: number;
  duplicate_candidates?: number;
  transfer_candidates?: number;
  warnings_count?: number;
  errors_count?: number;
  summary: string;
}

export function recordDataImportRun(
  db: Database.Database,
  input: RecordDataImportRunInput,
  now = new Date().toISOString()
): DataImportRun {
  const id = uuidv4();
  db.prepare(`
    INSERT INTO data_import_runs (
      id, source, status, rows_seen, rows_imported, rows_invalid,
      duplicate_candidates, transfer_candidates, warnings_count, errors_count, summary, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.source,
    input.status,
    input.rows_seen,
    input.rows_imported,
    input.rows_invalid ?? 0,
    input.duplicate_candidates ?? 0,
    input.transfer_candidates ?? 0,
    input.warnings_count ?? 0,
    input.errors_count ?? 0,
    input.summary,
    now
  );

  return db.prepare('SELECT * FROM data_import_runs WHERE id = ?').get(id) as DataImportRun;
}

export function listDataImportRuns(
  db: Database.Database,
  limit = 20
): DataImportRun[] {
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
  return db.prepare(`
    SELECT *
    FROM data_import_runs
    ORDER BY created_at DESC
    LIMIT ?
  `).all(safeLimit) as DataImportRun[];
}
