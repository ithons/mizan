import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/index';
import { validate } from '../middleware/validate';
import {
  CreateManualAccountSchema,
  UpdateAccountSchema,
} from '../../../shared/schemas';

const router = Router();

// GET / — all accounts with current_balance, sorted by sort_order
router.get('/', (_req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const accounts = db.prepare(`
      SELECT
        a.*,
        pi.last_synced_at
      FROM accounts a
      LEFT JOIN plaid_items pi ON pi.id = a.connection_id AND a.connection_type = 'plaid'
      ORDER BY a.sort_order ASC, a.created_at ASC
    `).all();

    res.json({ data: accounts });
  } catch (err) {
    next(err);
  }
});

// POST /manual — create manual account
router.post(
  '/manual',
  validate(CreateManualAccountSchema),
  (req: Request, res: Response, next: NextFunction): void => {
    try {
      const db = getDb();
      const body = req.body as {
        account_name: string;
        type: string;
        institution_name: string;
        current_balance: number;
        currency: string;
        is_liability: boolean;
        color?: string;
      };

      const id = uuidv4();
      const now = new Date().toISOString();

      // Get next sort_order
      const maxOrder = db.prepare(
        'SELECT MAX(sort_order) as max_order FROM accounts'
      ).get() as { max_order: number | null };
      const sortOrder = (maxOrder.max_order ?? -1) + 1;

      db.prepare(`
        INSERT INTO accounts
          (id, connection_type, institution_name, account_name, type,
           current_balance, currency, is_manual, is_hidden, is_liability,
           color, sort_order, created_at, updated_at)
        VALUES (?, 'manual', ?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?, ?)
      `).run(
        id,
        body.institution_name,
        body.account_name,
        body.type,
        body.current_balance,
        body.currency,
        body.is_liability ? 1 : 0,
        body.color || null,
        sortOrder,
        now,
        now
      );

      const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
      res.status(201).json({ data: account });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /:id — update account
router.patch(
  '/:id',
  validate(UpdateAccountSchema),
  (req: Request, res: Response, next: NextFunction): void => {
    try {
      const db = getDb();
      const { id } = req.params;
      const body = req.body as {
        account_name?: string;
        color?: string | null;
        is_hidden?: boolean;
        sort_order?: number;
        current_balance?: number;
      };

      const existing = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
      if (!existing) {
        res.status(404).json({ error: 'Account not found' });
        return;
      }

      const updates: string[] = [];
      const values: unknown[] = [];

      if (body.account_name !== undefined) {
        updates.push('account_name = ?');
        values.push(body.account_name);
      }
      if (body.color !== undefined) {
        updates.push('color = ?');
        values.push(body.color);
      }
      if (body.is_hidden !== undefined) {
        updates.push('is_hidden = ?');
        values.push(body.is_hidden ? 1 : 0);
      }
      if (body.sort_order !== undefined) {
        updates.push('sort_order = ?');
        values.push(body.sort_order);
      }
      if (body.current_balance !== undefined) {
        updates.push('current_balance = ?');
        values.push(body.current_balance);
      }

      if (updates.length === 0) {
        res.json({ data: existing });
        return;
      }

      updates.push('updated_at = ?');
      values.push(new Date().toISOString());
      values.push(id);

      db.prepare(`UPDATE accounts SET ${updates.join(', ')} WHERE id = ?`).run(...values);

      const updated = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
      res.json({ data: updated });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /:id — hard delete if manual, else hide
router.delete('/:id', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const { id } = req.params;

    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as
      | { is_manual: number }
      | undefined;

    if (!account) {
      res.status(404).json({ error: 'Account not found' });
      return;
    }

    if (account.is_manual) {
      db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
    } else {
      db.prepare(
        'UPDATE accounts SET is_hidden = 1, updated_at = ? WHERE id = ?'
      ).run(new Date().toISOString(), id);
    }

    res.json({ data: { success: true } });
  } catch (err) {
    next(err);
  }
});

export default router;
