import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import type {
  SyncChange,
  SyncRun,
  SyncRunDetail,
  SyncRunItem,
  SyncRunItemProvider,
  SyncRunItemStatus,
  SyncRunScope,
  SyncRunStatus,
} from '../../../shared/types';

export interface SyncRunCounts {
  accounts_seen?: number;
  transactions_added?: number;
  transactions_modified?: number;
  transactions_removed?: number;
  transactions_skipped?: number;
  duplicate_candidates?: number;
  transfer_candidates?: number;
}

interface FinishSyncRunOptions extends SyncRunCounts {
  status: SyncRunStatus;
  message?: string | null;
  error_code?: string | null;
  error_message?: string | null;
  recovery_action?: string | null;
}

interface FinishSyncRunItemOptions extends SyncRunCounts {
  status: SyncRunItemStatus;
  error_code?: string | null;
  error_message?: string | null;
  recovery_action?: string | null;
}

export interface SyncRunItemInput extends FinishSyncRunItemOptions {
  provider: SyncRunItemProvider;
  connection_id?: string | null;
  institution_name?: string | null;
  started_at?: string;
  completed_at?: string;
}

export function startSyncRun(
  db: Database.Database,
  scope: SyncRunScope,
  message?: string
): SyncRun {
  const now = new Date().toISOString();
  const id = uuidv4();

  db.prepare(`
    INSERT INTO sync_runs (id, scope, status, started_at, message)
    VALUES (?, ?, 'running', ?, ?)
  `).run(id, scope, now, message ?? null);

  return getSyncRun(db, id);
}

export function recordSyncRunItem(
  db: Database.Database,
  runId: string,
  input: SyncRunItemInput
): SyncRunItem {
  const startedAt = input.started_at ?? new Date().toISOString();
  const completedAt = input.completed_at ?? new Date().toISOString();
  const id = uuidv4();

  db.prepare(`
    INSERT INTO sync_run_items (
      id,
      run_id,
      provider,
      connection_id,
      institution_name,
      status,
      started_at,
      completed_at,
      accounts_seen,
      transactions_added,
      transactions_modified,
      transactions_removed,
      transactions_skipped,
      error_code,
      error_message,
      recovery_action
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    runId,
    input.provider,
    input.connection_id ?? null,
    input.institution_name ?? '',
    input.status,
    startedAt,
    completedAt,
    input.accounts_seen ?? 0,
    input.transactions_added ?? 0,
    input.transactions_modified ?? 0,
    input.transactions_removed ?? 0,
    input.transactions_skipped ?? 0,
    input.error_code ?? null,
    input.error_message ?? null,
    input.recovery_action ?? null
  );

  return getSyncRunItem(db, id);
}

export function recordSyncChange(
  db: Database.Database,
  runItemId: string,
  input: Omit<SyncChange, 'id' | 'run_item_id' | 'created_at'>
): SyncChange {
  const id = uuidv4();
  const createdAt = new Date().toISOString();

  db.prepare(`
    INSERT INTO sync_changes (
      id,
      run_item_id,
      entity_type,
      entity_id,
      change_type,
      description,
      created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    runItemId,
    input.entity_type,
    input.entity_id ?? null,
    input.change_type,
    input.description,
    createdAt
  );

  return db.prepare('SELECT * FROM sync_changes WHERE id = ?').get(id) as SyncChange;
}

export function finishSyncRun(
  db: Database.Database,
  runId: string,
  options: FinishSyncRunOptions
): SyncRun {
  const totals = db.prepare(`
    SELECT
      COALESCE(SUM(accounts_seen), 0) AS accounts_seen,
      COALESCE(SUM(transactions_added), 0) AS transactions_added,
      COALESCE(SUM(transactions_modified), 0) AS transactions_modified,
      COALESCE(SUM(transactions_removed), 0) AS transactions_removed,
      COALESCE(SUM(transactions_skipped), 0) AS transactions_skipped
    FROM sync_run_items
    WHERE run_id = ?
  `).get(runId) as Required<Omit<SyncRunCounts, 'duplicate_candidates' | 'transfer_candidates'>>;

  db.prepare(`
    UPDATE sync_runs
    SET status = ?,
        completed_at = ?,
        message = ?,
        error_code = ?,
        error_message = ?,
        recovery_action = ?,
        accounts_seen = ?,
        transactions_added = ?,
        transactions_modified = ?,
        transactions_removed = ?,
        transactions_skipped = ?,
        duplicate_candidates = ?,
        transfer_candidates = ?
    WHERE id = ?
  `).run(
    options.status,
    new Date().toISOString(),
    options.message ?? null,
    options.error_code ?? null,
    options.error_message ?? null,
    options.recovery_action ?? null,
    options.accounts_seen ?? totals.accounts_seen,
    options.transactions_added ?? totals.transactions_added,
    options.transactions_modified ?? totals.transactions_modified,
    options.transactions_removed ?? totals.transactions_removed,
    options.transactions_skipped ?? totals.transactions_skipped,
    options.duplicate_candidates ?? 0,
    options.transfer_candidates ?? 0,
    runId
  );

  return getSyncRun(db, runId);
}

export function getSyncRun(db: Database.Database, runId: string): SyncRun {
  const run = db.prepare('SELECT * FROM sync_runs WHERE id = ?').get(runId) as SyncRun | undefined;
  if (!run) throw new Error(`Sync run not found: ${runId}`);
  return run;
}

export function getSyncRunItem(db: Database.Database, itemId: string): SyncRunItem {
  const item = db.prepare('SELECT * FROM sync_run_items WHERE id = ?').get(itemId) as SyncRunItem | undefined;
  if (!item) throw new Error(`Sync run item not found: ${itemId}`);
  return item;
}

export function listSyncRuns(db: Database.Database, limit = 20): SyncRun[] {
  return db.prepare(`
    SELECT *
    FROM sync_runs
    ORDER BY started_at DESC
    LIMIT ?
  `).all(limit) as SyncRun[];
}

export function getSyncRunDetail(db: Database.Database, runId: string): SyncRunDetail {
  const run = getSyncRun(db, runId);
  const items = db.prepare(`
    SELECT *
    FROM sync_run_items
    WHERE run_id = ?
    ORDER BY started_at ASC
  `).all(runId) as SyncRunItem[];
  const changes = db.prepare(`
    SELECT sc.*
    FROM sync_changes sc
    JOIN sync_run_items sri ON sri.id = sc.run_item_id
    WHERE sri.run_id = ?
    ORDER BY sc.created_at ASC
  `).all(runId) as SyncChange[];

  return {
    ...run,
    items,
    changes,
  };
}
