import { Router, Request, Response, NextFunction } from 'express';
import { getDb, DB_PATH } from '../db/index';
import { getCredentials } from '../services/credentials';

const router = Router();

// GET / — health check
router.get('/', (_req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const creds = getCredentials();

    const accountRow = db.prepare(
      "SELECT COUNT(*) as count FROM accounts WHERE is_hidden = 0"
    ).get() as { count: number };

    const plaidItemRow = db.prepare(
      "SELECT COUNT(*) as count FROM plaid_items WHERE status != 'removed'"
    ).get() as { count: number };

    const coinbaseRow = db.prepare(
      "SELECT COUNT(*) as count FROM coinbase_connections WHERE status = 'active'"
    ).get() as { count: number };

    res.json({
      data: {
        status: 'ok',
        version: '0.1.0',
        dbPath: DB_PATH,
        connectedAccounts: accountRow.count,
        plaidEnvironment: creds.plaid?.environment ?? null,
        plaidItemCount: plaidItemRow.count,
        coinbaseConnected: coinbaseRow.count > 0,
        error: null,
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
