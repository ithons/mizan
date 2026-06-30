import type { Response } from 'express';
import type { SyncEvent } from '../../../shared/types';
import { syncAllItems } from './plaid';
import { syncCoinbase } from './coinbase';
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
import { refreshTransactionIntegrity } from './transactionIntegrity';
import { describeBalanceChange } from './balanceChanges';

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

function formatIssueNames(
  issues: Array<{ institutionName: string; itemId: string }>
): string {
  return issues
    .map((issue) => issue.institutionName || issue.itemId)
    .join(', ');
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

async function _runFullSyncInternal(): Promise<void> {
  const db = getDb();
  const run = startSyncRun(db, 'full', 'Full sync started');
  let finished = false;
  let deferredError: Error | null = null;

  emitSyncEvent({ type: 'sync_start', message: 'Starting full sync...' });

  try {
    // Sync Plaid items
    emitSyncEvent({ type: 'sync_progress', message: 'Syncing bank accounts...', progress: 10 });
    const plaidSummary = await syncAllItems();
    for (const item of plaidSummary.items) {
      const runItem = recordSyncRunItem(db, run.id, {
        provider: 'plaid',
        connection_id: item.itemId,
        institution_name: item.institutionName,
        status: item.status === 'synced'
          ? 'succeeded'
          : item.status === 'reauth_required'
            ? 'reauth_required'
            : 'failed',
        accounts_seen: item.accountCount,
        transactions_added: item.added,
        transactions_modified: item.modified,
        transactions_removed: item.removed,
        transactions_skipped: item.skipped,
        error_message: item.errorMessage,
        recovery_action: item.recoveryAction,
      });

      for (const change of item.balanceChanges) {
        recordSyncChange(db, runItem.id, {
          entity_type: 'account',
          entity_id: change.accountId,
          change_type: 'updated',
          description: describeBalanceChange(change),
        });
      }
    }

    const plaidIssues = [...plaidSummary.failed, ...plaidSummary.reauthRequired];
    if (plaidIssues.length > 0) {
      const names = formatIssueNames(plaidIssues);
      deferredError = new Error(`Bank sync incomplete for ${names}. Check Accounts or Settings to reconnect or retry.`);
    }

    // Sync Coinbase if connected
    const creds = getCredentials();
    if (creds.coinbase) {
      emitSyncEvent({ type: 'sync_progress', message: 'Syncing Coinbase...', progress: 50 });
      try {
        const coinbaseResult = await syncCoinbase();
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

    // Detect recurring
    emitSyncEvent({ type: 'sync_progress', message: 'Detecting recurring transactions...', progress: 75 });
    detectRecurring();
    const integrity = refreshTransactionIntegrity(db);
    const integrityItem = recordSyncRunItem(db, run.id, {
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

    // Take snapshot
    emitSyncEvent({ type: 'sync_progress', message: 'Taking net worth snapshot...', progress: 90 });
    takeSnapshot();

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
