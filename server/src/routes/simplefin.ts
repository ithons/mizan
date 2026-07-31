import { Router, Request, Response, NextFunction } from 'express';
import { getDb } from '../db/index';
import { validate } from '../middleware/validate';
import { SimplefinCredentialsSchema } from '../../../shared/schemas';
import { updateSimplefin, removeSimplefin } from '../services/credentials';
import { runFullSync, isSyncActive } from '../services/syncManager';
import { listSyncRuns } from '../services/syncHistory';
import axios from 'axios';

const router = Router();

// POST /setup
router.post(
  '/setup',
  validate(SimplefinCredentialsSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { setupToken } = req.body as { setupToken: string };

      // Decode the base64 setup token to get the claim URL
      const decoded = Buffer.from(setupToken, 'base64').toString('utf-8');
      const accessUrl = await axios.post(decoded).then(r => r.data as string);

      // The access URL (which embeds basic-auth) is persisted only in the encrypted
      // credentials store, never in the DB. The connection row is a non-secret marker.
      updateSimplefin(accessUrl);

      const db = getDb();
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO simplefin_connections (id, status, created_at)
         VALUES ('simplefin_primary', 'active', ?)
         ON CONFLICT(id) DO UPDATE SET status = 'active'`
      ).run(now);

      res.json({ data: { success: true } });

      // Kick off a sync immediately so the user sees real data right after connecting,
      // instead of an empty app until they separately find and click "Sync now".
      // Fire-and-forget: the connection itself is already valid at this point, so a
      // transient sync failure shouldn't fail the setup response the client already got.
      runFullSync().catch((err) => {
        console.error('[simplefin] Post-setup sync failed:', (err as Error).message);
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /connection
router.get('/connection', (_req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const item = db.prepare(
      "SELECT id, status, last_synced_at, created_at FROM simplefin_connections WHERE status != 'removed' LIMIT 1"
    ).get();

    res.json({ data: item || null });
  } catch (err) {
    next(err);
  }
});

// POST /resync: force a fresh 730-day lookback by nulling last_synced_at, then sync.
router.post('/resync', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const db = getDb();
    const connection = db.prepare(
      "SELECT id FROM simplefin_connections WHERE status = 'active' LIMIT 1"
    ).get() as { id: string } | undefined;

    if (!connection) {
      res.status(404).json({ error: 'No active SimpleFIN connection to resync' });
      return;
    }

    if (isSyncActive()) {
      res.status(409).json({ error: 'A sync is already running. Try again in a moment.' });
      return;
    }

    db.prepare("UPDATE simplefin_connections SET last_synced_at = NULL WHERE status = 'active'").run();
    await runFullSync();

    // Read the SimpleFIN-specific item, not the run's overall totals. The run total
    // also sums in unrelated stages (auto-categorization, Coinbase) that would make the
    // "N new transactions" toast misleading about what the deep pull itself found.
    const [latestRun] = listSyncRuns(db, 1);
    const simplefinItem = latestRun
      ? (db.prepare(
          "SELECT transactions_added, transactions_modified FROM sync_run_items WHERE run_id = ? AND connection_id = 'simplefin_primary'"
        ).get(latestRun.id) as { transactions_added: number; transactions_modified: number } | undefined)
      : undefined;

    res.json({
      data: {
        success: true,
        transactionsAdded: simplefinItem?.transactions_added ?? 0,
        transactionsModified: simplefinItem?.transactions_modified ?? 0,
      },
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /connection
router.delete('/connection', (_req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const now = new Date().toISOString();

    db.prepare(
      "UPDATE accounts SET is_hidden = 1, updated_at = ? WHERE connection_type = 'simplefin'"
    ).run(now);

    removeSimplefin();

    db.prepare(
      "UPDATE simplefin_connections SET status = 'removed'"
    ).run();

    res.json({ data: { success: true } });
  } catch (err) {
    next(err);
  }
});

export default router;
