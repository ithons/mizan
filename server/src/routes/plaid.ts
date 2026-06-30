import { Router, Request, Response, NextFunction } from 'express';
import { getDb } from '../db/index';
import { validate } from '../middleware/validate';
import {
  PlaidExchangeTokenSchema,
} from '../../../shared/schemas';
import {
  createLinkToken,
  exchangeToken,
  syncItemDetailed,
  syncAllItems,
  createUpdateToken,
} from '../services/plaid';
import { removePlaidItemToken } from '../services/credentials';
import { takeSnapshot } from '../services/snapshot';
import {
  finishSyncRun,
  recordSyncRunItem,
  startSyncRun,
} from '../services/syncHistory';
import { refreshTransactionIntegrity } from '../services/transactionIntegrity';

const router = Router();

function defaultRedirectUri() {
  return `http://localhost:${process.env.PORT || '3001'}`;
}

function normalizeRedirectUri(uri?: string): string {
  const base = uri || defaultRedirectUri();
  try {
    const url = new URL(base);
    if (url.hostname === '127.0.0.1') {
      url.hostname = 'localhost';
      return url.toString().replace(/\/$/, '');
    }
    return base;
  } catch {
    return defaultRedirectUri();
  }
}


// POST /link-token
router.post('/link-token', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const redirectUri = normalizeRedirectUri((req.body as { redirectUri?: string }).redirectUri);
    const linkToken = await createLinkToken(redirectUri);
    res.json({ data: { link_token: linkToken, redirect_uri: redirectUri } });
  } catch (err) {
    next(err);
  }
});

// POST /exchange-token
router.post(
  '/exchange-token',
  validate(PlaidExchangeTokenSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { publicToken, metadata } = req.body as {
        publicToken: string;
        metadata: Record<string, unknown>;
      };

      const result = await exchangeToken(publicToken, metadata);
      takeSnapshot();
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  }
);

// POST /sync/all - must be registered before /sync/:itemId to avoid "all" matching as itemId
router.post('/sync/all', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  const db = getDb();
  const run = startSyncRun(db, 'plaid_all', 'Plaid sync started');
  try {
    const summary = await syncAllItems();
    for (const item of summary.items) {
      recordSyncRunItem(db, run.id, {
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
    }

    if (summary.synced > 0) takeSnapshot();
    const integrity = refreshTransactionIntegrity(db);
    const success = summary.failed.length === 0 && summary.reauthRequired.length === 0;
    finishSyncRun(db, run.id, {
      status: success ? 'succeeded' : 'partial',
      message: success ? 'Plaid sync complete' : 'Plaid sync finished with issues',
      error_message: success ? null : 'One or more Plaid institutions need attention',
      recovery_action: success ? null : 'Open Accounts to reconnect or retry affected institutions.',
      duplicate_candidates: integrity.duplicates.groupCount,
      transfer_candidates: integrity.transfers.pairCount,
    });

    res.json({
      data: {
        success,
        ...summary,
      },
    });
  } catch (err) {
    finishSyncRun(db, run.id, {
      status: 'failed',
      message: 'Plaid sync failed',
      error_message: (err as Error).message || 'Plaid sync failed',
      recovery_action: 'Retry sync. If it continues failing, check Plaid settings.',
    });
    next(err);
  }
});

// POST /sync/:itemId
router.post('/sync/:itemId', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const db = getDb();
  const run = startSyncRun(db, 'plaid_item', 'Plaid institution sync started');
  try {
    const result = await syncItemDetailed(req.params['itemId'] as string);
    recordSyncRunItem(db, run.id, {
      provider: 'plaid',
      connection_id: result.itemId,
      institution_name: result.institutionName,
      status: result.status === 'synced'
        ? 'succeeded'
        : result.status === 'reauth_required'
          ? 'reauth_required'
          : 'failed',
      accounts_seen: result.accountCount,
      transactions_added: result.added,
      transactions_modified: result.modified,
      transactions_removed: result.removed,
      transactions_skipped: result.skipped,
      error_message: result.errorMessage,
      recovery_action: result.recoveryAction,
    });

    if (result.status === 'synced') takeSnapshot();
    const integrity = refreshTransactionIntegrity(db);
    finishSyncRun(db, run.id, {
      status: result.status === 'synced' ? 'succeeded' : 'partial',
      message: result.status === 'synced' ? 'Plaid institution sync complete' : 'Plaid institution needs attention',
      error_message: result.errorMessage,
      recovery_action: result.recoveryAction,
      duplicate_candidates: integrity.duplicates.groupCount,
      transfer_candidates: integrity.transfers.pairCount,
    });

    const status = result.status;
    res.json({ data: { success: status === 'synced', status } });
  } catch (err) {
    finishSyncRun(db, run.id, {
      status: 'failed',
      message: 'Plaid institution sync failed',
      error_message: (err as Error).message || 'Plaid institution sync failed',
      recovery_action: 'Retry sync. If it continues failing, reconnect the institution.',
    });
    next(err);
  }
});

// GET /items - list plaid items
router.get('/items', (_req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const items = db.prepare(
      "SELECT * FROM plaid_items WHERE status != 'removed' ORDER BY created_at ASC"
    ).all();

    res.json({ data: items });
  } catch (err) {
    next(err);
  }
});

// DELETE /items/:id - remove plaid item
router.delete('/items/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const db = getDb();
    const { id } = req.params;

    const item = db.prepare('SELECT * FROM plaid_items WHERE id = ?').get(id) as
      | { id: string; item_id: string }
      | undefined;

    if (!item) {
      res.status(404).json({ error: 'Plaid item not found' });
      return;
    }

    const now = new Date().toISOString();

    // Hide linked accounts
    db.prepare(
      "UPDATE accounts SET is_hidden = 1, updated_at = ? WHERE connection_id = ? AND connection_type = 'plaid'"
    ).run(now, id);

    // Remove access token from credentials store
    removePlaidItemToken(item.item_id);

    // Mark item as removed
    db.prepare(
      "UPDATE plaid_items SET status = 'removed' WHERE id = ?"
    ).run(id);

    res.json({ data: { success: true } });
  } catch (err) {
    next(err);
  }
});

// POST /update-token/:id - get update mode link token
router.post('/update-token/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const redirectUri = normalizeRedirectUri((req.body as { redirectUri?: string }).redirectUri);
    const linkToken = await createUpdateToken(req.params['id'] as string, redirectUri);
    res.json({ data: { link_token: linkToken, redirect_uri: redirectUri } });
  } catch (err) {
    next(err);
  }
});

export default router;
