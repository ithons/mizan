import type { Response } from 'express';
import type Database from 'better-sqlite3';
import type { SyncEvent } from '../../../shared/types';
import { syncCoinbase } from './coinbase';
import { syncSimplefin } from './simplefin';
import { detectRecurring } from './recurring';
import { takeSnapshot } from './snapshot';
import { getCredentials } from './credentials';
import { getDb } from '../db/index';
import {
  finishSyncRun,
  recordSyncChange,
  recordSyncRunItem,
  startSyncRun,
} from './syncHistory';
import { refreshTransactionIntegrity, type TransactionIntegrityResult } from './transactionIntegrity';
import { describeBalanceChange } from './balanceChanges';
import { runBackgroundAiReview } from './aiWorker';
import { withRetry } from './retry';

// SSE clients registry
const sseClients = new Set<Response>();
let _activeSyncPromise: Promise<void> | null = null;
let _lastSyncEvent: SyncEvent | null = null;

export function addSseClient(res: Response): void {
  sseClients.add(res);
  if (_activeSyncPromise && _lastSyncEvent) {
    try {
      res.write(`data: ${JSON.stringify(_lastSyncEvent)}\n\n`);
    } catch {
      sseClients.delete(res);
    }
  }
}

export function removeSseClient(res: Response): void {
  sseClients.delete(res);
}

export function emitSyncEvent(event: SyncEvent): void {
  _lastSyncEvent = event;
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      // Client disconnected
      sseClients.delete(client);
    }
  }
}



export interface PostSyncStageFns {
  detectRecurring: () => void;
  refreshTransactionIntegrity: (db: Database.Database) => TransactionIntegrityResult;
  takeSnapshot: () => void;
}

const defaultPostSyncStages: PostSyncStageFns = {
  detectRecurring,
  refreshTransactionIntegrity,
  takeSnapshot,
};

export interface PostSyncStagesResult {
  integrity: TransactionIntegrityResult;
  deferredError: Error | null;
}

// Each stage (recurring detection, integrity refresh, snapshot) gets its own try/catch
// so a failure in one doesn't skip the others or mask an otherwise-successful provider sync.
export function runPostSyncStages(
  db: Database.Database,
  runId: string,
  deferredError: Error | null,
  stages: PostSyncStageFns = defaultPostSyncStages
): PostSyncStagesResult {
  let nextDeferredError = deferredError;

  emitSyncEvent({ type: 'sync_progress', message: 'Detecting recurring transactions...', progress: 75 });
  try {
    stages.detectRecurring();
  } catch (err) {
    const message = (err as Error).message || 'Recurring detection failed';
    recordSyncRunItem(db, runId, {
      provider: 'system',
      connection_id: 'recurring-detection',
      institution_name: 'Recurring detection',
      status: 'failed',
      error_message: message,
      recovery_action: 'Retry sync. Recurring pattern detection will run again next sync.',
    });
    nextDeferredError = nextDeferredError ?? new Error(message);
  }

  let integrity: TransactionIntegrityResult = {
    duplicates: { groupCount: 0, transactionCount: 0 },
    transfers: { pairCount: 0, transactionCount: 0 },
  };
  try {
    integrity = stages.refreshTransactionIntegrity(db);
    const integrityItem = recordSyncRunItem(db, runId, {
      provider: 'system',
      connection_id: 'transaction-integrity',
      institution_name: 'Transaction integrity',
      status: 'succeeded',
    });
    if (integrity.duplicates.groupCount > 0) {
      recordSyncChange(db, integrityItem.id, {
        entity_type: 'integrity',
        entity_id: null,
        change_type: 'detected',
        description: `${integrity.duplicates.groupCount} duplicate group(s) need review`,
      });
    }
    if (integrity.transfers.pairCount > 0) {
      recordSyncChange(db, integrityItem.id, {
        entity_type: 'integrity',
        entity_id: null,
        change_type: 'detected',
        description: `${integrity.transfers.pairCount} transfer pair(s) need review`,
      });
    }
  } catch (err) {
    const message = (err as Error).message || 'Transaction integrity check failed';
    recordSyncRunItem(db, runId, {
      provider: 'system',
      connection_id: 'transaction-integrity',
      institution_name: 'Transaction integrity',
      status: 'failed',
      error_message: message,
      recovery_action: 'Retry sync. Duplicate/transfer detection will run again next sync.',
    });
    nextDeferredError = nextDeferredError ?? new Error(message);
  }

  emitSyncEvent({ type: 'sync_progress', message: 'Taking net worth snapshot...', progress: 90 });
  try {
    stages.takeSnapshot();
  } catch (err) {
    const message = (err as Error).message || 'Snapshot failed';
    recordSyncRunItem(db, runId, {
      provider: 'system',
      connection_id: 'net-worth-snapshot',
      institution_name: 'Net worth snapshot',
      status: 'failed',
      error_message: message,
      recovery_action: 'Retry sync. A snapshot will be taken again next sync.',
    });
    nextDeferredError = nextDeferredError ?? new Error(message);
  }

  return { integrity, deferredError: nextDeferredError };
}

export async function runFullSync(): Promise<void> {
  if (_activeSyncPromise) {
    console.log('[sync] Full sync already in progress, returning existing promise');
    return _activeSyncPromise;
  }

  _activeSyncPromise = _runFullSyncInternal().finally(() => {
    _activeSyncPromise = null;
    _lastSyncEvent = null;
  });

  return _activeSyncPromise;
}

let _schedulerHandle: NodeJS.Timeout | null = null;

// Overlapping ticks are safe: runFullSync() already guards against concurrent
// runs via _activeSyncPromise, so a tick firing mid-sync just no-ops.
export function startSyncScheduler(intervalMinutes: number): void {
  if (_schedulerHandle) return;
  _schedulerHandle = setInterval(() => {
    runFullSync().catch((err) => {
      console.error('[scheduler] Sync failed:', (err as Error).message);
    });
  }, intervalMinutes * 60_000);
}

export function stopSyncScheduler(): void {
  if (_schedulerHandle) clearInterval(_schedulerHandle);
  _schedulerHandle = null;
}

async function _runFullSyncInternal(): Promise<void> {
  const db = getDb();
  const run = startSyncRun(db, 'full', 'Full sync started');
  let finished = false;
  let deferredError: Error | null = null;

  emitSyncEvent({ type: 'sync_start', message: 'Starting full sync...' });

  try {
    const creds = getCredentials();



    // Sync SimpleFIN
    if (creds.simplefin?.accessUrl) {
      emitSyncEvent({ type: 'sync_progress', message: 'Syncing SimpleFIN...', progress: 30 });
      try {
        const simplefinResult = await withRetry(() => syncSimplefin());
        const runItem = recordSyncRunItem(db, run.id, {
          provider: 'simplefin',
          connection_id: 'simplefin_primary',
          institution_name: 'SimpleFIN',
          status: 'succeeded',
          accounts_seen: simplefinResult.accountCount,
          transactions_added: simplefinResult.added,
          transactions_modified: simplefinResult.modified,
          transactions_removed: simplefinResult.removed,
          transactions_skipped: simplefinResult.skipped,
        });

        for (const change of simplefinResult.balanceChanges) {
          recordSyncChange(db, runItem.id, {
            entity_type: 'account',
            entity_id: change.accountId,
            change_type: 'updated',
            description: describeBalanceChange(change),
          });
        }
      } catch (err) {
        const message = (err as Error).message || 'SimpleFIN sync failed';
        recordSyncRunItem(db, run.id, {
          provider: 'simplefin',
          connection_id: 'simplefin_primary',
          institution_name: 'SimpleFIN',
          status: 'failed',
          error_message: message,
          recovery_action: 'Retry sync. If it continues failing, check SimpleFIN setup token.',
        });
        deferredError = deferredError ?? new Error(message);
      }
    }



    // Sync Coinbase if connected
    if (creds.coinbase) {
      emitSyncEvent({ type: 'sync_progress', message: 'Syncing Coinbase...', progress: 50 });
      try {
        const coinbaseResult = await withRetry(() => syncCoinbase());
        const runItem = recordSyncRunItem(db, run.id, {
          provider: 'coinbase',
          connection_id: 'coinbase',
          institution_name: 'Coinbase',
          status: 'succeeded',
          accounts_seen: coinbaseResult.accountCount,
          transactions_added: coinbaseResult.transactionCount,
          transactions_modified: coinbaseResult.staleAccountCount,
        });

        for (const change of coinbaseResult.balanceChanges) {
          recordSyncChange(db, runItem.id, {
            entity_type: 'account',
            entity_id: change.accountId,
            change_type: 'updated',
            description: describeBalanceChange(change),
          });
        }
      } catch (err) {
        const message = (err as Error).message || 'Coinbase sync failed';
        recordSyncRunItem(db, run.id, {
          provider: 'coinbase',
          connection_id: 'coinbase',
          institution_name: 'Coinbase',
          status: 'failed',
          error_message: message,
          recovery_action: 'Retry sync. If it continues failing, check Coinbase credentials in Settings.',
        });
        deferredError = deferredError ?? new Error(message);
      }
    }

    const postSync = runPostSyncStages(db, run.id, deferredError);
    const integrity = postSync.integrity;
    deferredError = postSync.deferredError;

    finishSyncRun(db, run.id, {
      status: deferredError ? 'partial' : 'succeeded',
      message: deferredError ? 'Sync finished with issues' : 'Sync complete',
      error_message: deferredError?.message,
      recovery_action: deferredError ? 'Open Accounts to reconnect or retry affected institutions.' : null,
      duplicate_candidates: integrity.duplicates.groupCount,
      transfer_candidates: integrity.transfers.pairCount,
    });
    finished = true;

    if (deferredError) {
      throw deferredError;
    }

    emitSyncEvent({ type: 'sync_complete', message: 'Sync complete', progress: 100, completedAt: new Date().toISOString() });
    
    // Proactive background AI worker
    setTimeout(() => {
      runBackgroundAiReview().catch(err => {
        console.error('[sync] Background AI review failed:', err);
      });
    }, 100);
  } catch (err) {
    const message = (err as Error).message || 'Sync failed';
    if (!finished) {
      finishSyncRun(db, run.id, {
        status: 'failed',
        message: 'Sync failed',
        error_message: message,
        recovery_action: 'Retry sync. If it continues failing, check provider settings.',
      });
    }
    emitSyncEvent({ type: 'sync_error', message });
    throw err;
  }
}
