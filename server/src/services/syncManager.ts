import type { Response } from 'express';
import type { SyncEvent } from '../../../shared/types';
import { syncAllItems } from './plaid';
import { syncCoinbase } from './coinbase';
import { detectRecurring } from './recurring';
import { takeSnapshot } from './snapshot';
import { getCredentials } from './credentials';

// SSE clients registry
const sseClients = new Set<Response>();

export function addSseClient(res: Response): void {
  sseClients.add(res);
}

export function removeSseClient(res: Response): void {
  sseClients.delete(res);
}

export function emitSyncEvent(event: SyncEvent): void {
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
  emitSyncEvent({ type: 'sync_start', message: 'Starting full sync...' });

  try {
    // Sync Plaid items
    emitSyncEvent({ type: 'sync_progress', message: 'Syncing bank accounts...', progress: 10 });
    const plaidSummary = await syncAllItems();
    const plaidIssues = [...plaidSummary.failed, ...plaidSummary.reauthRequired];
    if (plaidIssues.length > 0) {
      const names = formatIssueNames(plaidIssues);
      throw new Error(`Bank sync incomplete for ${names}. Check Accounts or Settings to reconnect or retry.`);
    }

    // Sync Coinbase if connected
    const creds = getCredentials();
    if (creds.coinbase) {
      emitSyncEvent({ type: 'sync_progress', message: 'Syncing Coinbase...', progress: 50 });
      try {
        await syncCoinbase();
      } catch (err) {
        console.error('[syncManager] Coinbase sync failed:', (err as Error).message);
      }
    }

    // Detect recurring
    emitSyncEvent({ type: 'sync_progress', message: 'Detecting recurring transactions...', progress: 75 });
    detectRecurring();

    // Take snapshot
    emitSyncEvent({ type: 'sync_progress', message: 'Taking net worth snapshot...', progress: 90 });
    takeSnapshot();

    emitSyncEvent({ type: 'sync_complete', message: 'Sync complete', progress: 100, completedAt: new Date().toISOString() });
  } catch (err) {
    const message = (err as Error).message || 'Sync failed';
    emitSyncEvent({ type: 'sync_error', message });
    throw err;
  }
}
