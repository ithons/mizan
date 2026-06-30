import type { Response } from 'express';
import type { SyncEvent } from '../../../shared/types';
import { syncAllItems } from './plaid';
import { syncCoinbase } from './coinbase';
import { syncTellerItem } from './teller';
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
import { refreshTransactionIntegrity } from './transactionIntegrity';
import { describeBalanceChange } from './balanceChanges';
import { runBackgroundAiReview } from './aiWorker';

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
    const creds = getCredentials();

    // Sync Teller items
    if (creds.tellerItems) {
      for (const [enrollmentId] of Object.entries(creds.tellerItems)) {
        emitSyncEvent({ type: 'sync_progress', message: `Syncing Teller: ${enrollmentId}...`, progress: 20 });
        try {
          const tellerResult = await syncTellerItem(enrollmentId);
          const runItem = recordSyncRunItem(db, run.id, {
            provider: 'teller',
            connection_id: enrollmentId,
            institution_name: tellerResult.institutionName || 'Teller',
            status: 'succeeded',
            accounts_seen: tellerResult.accountCount,
            transactions_added: tellerResult.added,
            transactions_modified: tellerResult.modified,
            transactions_removed: tellerResult.removed,
            transactions_skipped: tellerResult.skipped,
          });

          for (const change of tellerResult.balanceChanges) {
            recordSyncChange(db, runItem.id, {
              entity_type: 'account',
              entity_id: change.accountId,
              change_type: 'updated',
              description: describeBalanceChange(change),
            });
          }
        } catch (err) {
          const message = (err as Error).message || 'Teller sync failed';
          recordSyncRunItem(db, run.id, {
            provider: 'teller',
            connection_id: enrollmentId,
            institution_name: 'Teller',
            status: 'failed',
            error_message: message,
            recovery_action: 'Retry sync. If it continues failing, reconnect Teller.',
          });
          deferredError = deferredError ?? new Error(message);
        }
      }
    }

    // Sync SimpleFIN
    if (creds.simplefin?.accessUrl) {
      emitSyncEvent({ type: 'sync_progress', message: 'Syncing SimpleFIN...', progress: 30 });
      try {
        const simplefinResult = await syncSimplefin();
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
