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

const router = Router();

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
      const accountCount = await syncCoinbase();

      res.json({
        data: {
          accountCount,
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
  try {
    const count = await syncCoinbase();
    res.json({ data: { accountCount: count } });
  } catch (err) {
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
