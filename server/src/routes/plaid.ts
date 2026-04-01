import { Router, Request, Response, NextFunction } from 'express';
import { getDb } from '../db/index';
import { validate } from '../middleware/validate';
import {
  PlaidExchangeTokenSchema,
} from '../../../shared/schemas';
import {
  createLinkToken,
  exchangeToken,
  syncItem,
  syncAllItems,
  createUpdateToken,
} from '../services/plaid';
import { removePlaidItemToken } from '../services/credentials';

const router = Router();

// POST /link-token
router.post('/link-token', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const linkToken = await createLinkToken();
    res.json({ data: { link_token: linkToken } });
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
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  }
);

// POST /sync/:itemId
router.post('/sync/:itemId', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await syncItem(req.params['itemId'] as string);
    res.json({ data: { success: true } });
  } catch (err) {
    next(err);
  }
});

// POST /sync/all
router.post('/sync/all', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await syncAllItems();
    res.json({ data: { success: true } });
  } catch (err) {
    next(err);
  }
});

// GET /items — list plaid items
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

// DELETE /items/:id — remove plaid item
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

// POST /update-token/:id — get update mode link token
router.post('/update-token/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const linkToken = await createUpdateToken(req.params['id'] as string);
    res.json({ data: { link_token: linkToken } });
  } catch (err) {
    next(err);
  }
});

export default router;
