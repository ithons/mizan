import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/index';
import { validate } from '../middleware/validate';
import { CoinbaseCredentialsSchema } from '../../../shared/schemas';
import {
  updateCoinbaseCredentials,
  removeCoinbaseCredentials,
} from '../services/credentials';
import {
  testConnection,
  syncCoinbase,
} from '../services/coinbase';
import { takeSnapshot } from '../services/snapshot';
import {
  finishSyncRun,
  recordSyncRunItem,
  startSyncRun,
} from '../services/syncHistory';
import { refreshTransactionIntegrity } from '../services/transactionIntegrity';

const router = Router();

function syncChangedFinancialData(syncResult: {
  accountCount: number;
  transactionCount: number;
  staleAccountCount: number;
}): boolean {
  return (
    syncResult.accountCount > 0 ||
    syncResult.transactionCount > 0 ||
    syncResult.staleAccountCount > 0
  );
}

// POST /connect
router.post(
  '/connect',
  validate(CoinbaseCredentialsSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const db = getDb();
      const body = req.body as { keyName: string; privateKey: string };

      // Save credentials first
      updateCoinbaseCredentials(body);

      // Test connection (throws on failure)
      let connectionInfo: { userId: string; displayName: string };
      try {
        connectionInfo = await testConnection();
      } catch (err) {
        // Roll back credentials on failure
        removeCoinbaseCredentials();
        throw new Error(`Coinbase connection failed: ${(err as Error).message}`);
      }

      const now = new Date().toISOString();

      // Check if connection already exists
      const existing = db.prepare(
        "SELECT id FROM coinbase_connections WHERE status = 'active'"
      ).get() as { id: string } | undefined;

      let connectionId: string;
      if (existing) {
        connectionId = existing.id;
        db.prepare(`
          UPDATE coinbase_connections
          SET coinbase_user_id = ?, display_name = ?, status = 'active'
          WHERE id = ?
        `).run(connectionInfo.userId, connectionInfo.displayName, connectionId);
      } else {
        connectionId = uuidv4();
        db.prepare(`
          INSERT INTO coinbase_connections (id, coinbase_user_id, display_name, last_synced_at, status, created_at)
          VALUES (?, ?, ?, NULL, 'active', ?)
        `).run(connectionId, connectionInfo.userId, connectionInfo.displayName, now);
      }

      // Sync accounts
      const run = startSyncRun(db, 'coinbase', 'Coinbase connection sync started');
      let syncResult: Awaited<ReturnType<typeof syncCoinbase>>;
      try {
        syncResult = await syncCoinbase();
        recordSyncRunItem(db, run.id, {
          provider: 'coinbase',
          connection_id: connectionId,
          institution_name: 'Coinbase',
          status: 'succeeded',
          accounts_seen: syncResult.accountCount,
          transactions_added: syncResult.transactionCount,
          transactions_modified: syncResult.staleAccountCount,
        });
        if (syncChangedFinancialData(syncResult)) takeSnapshot();
        const integrity = refreshTransactionIntegrity(db);
        finishSyncRun(db, run.id, {
          status: 'succeeded',
          message: 'Coinbase sync complete',
          duplicate_candidates: integrity.duplicates.groupCount,
          transfer_candidates: integrity.transfers.pairCount,
        });
      } catch (err) {
        finishSyncRun(db, run.id, {
          status: 'failed',
          message: 'Coinbase initial sync failed',
          error_message: (err as Error).message || 'Coinbase sync failed',
          recovery_action: 'Retry sync. If it continues failing, check Coinbase credentials.',
        });
        throw err;
      }

      res.json({
        data: {
          ...syncResult,
          displayName: connectionInfo.displayName,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// POST /sync
router.post('/sync', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  const db = getDb();
  const run = startSyncRun(db, 'coinbase', 'Coinbase sync started');
  try {
    const syncResult = await syncCoinbase();
    const activeConnection = db.prepare(
      "SELECT id FROM coinbase_connections WHERE status = 'active'"
    ).get() as { id: string } | undefined;
    recordSyncRunItem(db, run.id, {
      provider: 'coinbase',
      connection_id: activeConnection?.id ?? 'coinbase',
      institution_name: 'Coinbase',
      status: 'succeeded',
      accounts_seen: syncResult.accountCount,
      transactions_added: syncResult.transactionCount,
      transactions_modified: syncResult.staleAccountCount,
    });
    if (syncChangedFinancialData(syncResult)) takeSnapshot();
    const integrity = refreshTransactionIntegrity(db);
    finishSyncRun(db, run.id, {
      status: 'succeeded',
      message: 'Coinbase sync complete',
      duplicate_candidates: integrity.duplicates.groupCount,
      transfer_candidates: integrity.transfers.pairCount,
    });
    res.json({ data: syncResult });
  } catch (err) {
    finishSyncRun(db, run.id, {
      status: 'failed',
      message: 'Coinbase sync failed',
      error_message: (err as Error).message || 'Coinbase sync failed',
      recovery_action: 'Retry sync. If it continues failing, check Coinbase credentials.',
    });
    next(err);
  }
});

// DELETE /disconnect
router.delete('/disconnect', (_req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const now = new Date().toISOString();

    // Hide coinbase accounts
    db.prepare(
      "UPDATE accounts SET is_hidden = 1, updated_at = ? WHERE connection_type = 'coinbase'"
    ).run(now);

    // Remove credentials
    removeCoinbaseCredentials();

    // Mark connection as removed
    db.prepare(
      "UPDATE coinbase_connections SET status = 'disconnected' WHERE status = 'active'"
    ).run();

    res.json({ data: { success: true } });
  } catch (err) {
    next(err);
  }
});

export default router;
