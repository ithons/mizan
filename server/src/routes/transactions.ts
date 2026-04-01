import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/index';
import { validate } from '../middleware/validate';
import {
  CreateManualTransactionSchema,
  UpdateTransactionSchema,
  BulkCategorySchema,
} from '../../../shared/schemas';

const router = Router();

// GET / — list transactions with filters
router.get('/', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const query = req.query as Record<string, string | string[]>;

    const page = Math.max(1, parseInt(query.page as string) || 1);
    const limit = Math.min(500, Math.max(1, parseInt(query.limit as string) || 50));
    const offset = (page - 1) * limit;

    const conditions: string[] = [];
    const params: unknown[] = [];

    // accountId filter
    const accountIds = query.accountId
      ? Array.isArray(query.accountId)
        ? query.accountId
        : [query.accountId]
      : [];
    if (accountIds.length > 0) {
      conditions.push(`t.account_id IN (${accountIds.map(() => '?').join(',')})`);
      params.push(...accountIds);
    }

    // categoryId filter
    const categoryIds = query.categoryId
      ? Array.isArray(query.categoryId)
        ? query.categoryId
        : [query.categoryId]
      : [];
    if (categoryIds.length > 0) {
      conditions.push(`t.category_id IN (${categoryIds.map(() => '?').join(',')})`);
      params.push(...categoryIds);
    }

    if (query.startDate) {
      conditions.push('t.date >= ?');
      params.push(query.startDate);
    }
    if (query.endDate) {
      conditions.push('t.date <= ?');
      params.push(query.endDate);
    }
    if (query.search) {
      conditions.push('(t.merchant_name LIKE ? OR t.original_name LIKE ? OR t.notes LIKE ?)');
      const like = `%${query.search}%`;
      params.push(like, like, like);
    }
    if (query.minAmount) {
      conditions.push('t.amount >= ?');
      params.push(parseFloat(query.minAmount as string));
    }
    if (query.maxAmount) {
      conditions.push('t.amount <= ?');
      params.push(parseFloat(query.maxAmount as string));
    }
    if (query.pending !== undefined) {
      conditions.push('t.pending = ?');
      params.push(query.pending === 'true' ? 1 : 0);
    }
    if (query.recurring === 'true') {
      conditions.push('t.recurring_id IS NOT NULL');
    } else if (query.recurring === 'false') {
      conditions.push('t.recurring_id IS NULL');
    }
    if (query.type === 'income') {
      conditions.push('t.amount > 0');
    } else if (query.type === 'expense') {
      conditions.push('t.amount < 0');
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRow = db.prepare(`
      SELECT COUNT(*) as total
      FROM transactions t
      ${where}
    `).get(...params) as { total: number };

    const data = db.prepare(`
      SELECT
        t.*,
        c.name AS category_name,
        c.color AS category_color,
        c.icon AS category_icon,
        a.account_name,
        a.institution_name
      FROM transactions t
      LEFT JOIN categories c ON c.id = t.category_id
      LEFT JOIN accounts a ON a.id = t.account_id
      ${where}
      ORDER BY t.date DESC, t.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    res.json({ data, total: countRow.total, page, limit });
  } catch (err) {
    next(err);
  }
});

// GET /:id — single transaction
router.get('/:id', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const txn = db.prepare(`
      SELECT
        t.*,
        c.name AS category_name,
        c.color AS category_color,
        c.icon AS category_icon,
        a.account_name,
        a.institution_name
      FROM transactions t
      LEFT JOIN categories c ON c.id = t.category_id
      LEFT JOIN accounts a ON a.id = t.account_id
      WHERE t.id = ?
    `).get(req.params.id);

    if (!txn) {
      res.status(404).json({ error: 'Transaction not found' });
      return;
    }

    res.json({ data: txn });
  } catch (err) {
    next(err);
  }
});

// POST /manual — create manual transaction
router.post(
  '/manual',
  validate(CreateManualTransactionSchema),
  (req: Request, res: Response, next: NextFunction): void => {
    try {
      const db = getDb();
      const body = req.body as {
        account_id: string;
        date: string;
        amount: number;
        merchant_name?: string;
        original_name: string;
        category_id?: string;
        notes?: string;
      };

      const id = uuidv4();
      const now = new Date().toISOString();

      db.prepare(`
        INSERT INTO transactions
          (id, account_id, date, amount, merchant_name, original_name,
           category_id, pending, notes, is_manual, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 1, ?, ?)
      `).run(
        id,
        body.account_id,
        body.date,
        body.amount,
        body.merchant_name || null,
        body.original_name,
        body.category_id || null,
        body.notes || null,
        now,
        now
      );

      const txn = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
      res.status(201).json({ data: txn });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /:id — update transaction
router.patch(
  '/:id',
  validate(UpdateTransactionSchema),
  (req: Request, res: Response, next: NextFunction): void => {
    try {
      const db = getDb();
      const { id } = req.params;
      const body = req.body as {
        category_id?: string | null;
        notes?: string | null;
        date?: string;
        amount?: number;
        merchant_name?: string | null;
      };

      const existing = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id) as
        | { category_id: string | null; merchant_name: string | null; original_name: string }
        | undefined;

      if (!existing) {
        res.status(404).json({ error: 'Transaction not found' });
        return;
      }

      const updates: string[] = [];
      const values: unknown[] = [];

      if (body.category_id !== undefined) {
        updates.push('category_id = ?');
        values.push(body.category_id);
      }
      if (body.notes !== undefined) {
        updates.push('notes = ?');
        values.push(body.notes);
      }
      if (body.date !== undefined) {
        updates.push('date = ?');
        values.push(body.date);
      }
      if (body.amount !== undefined) {
        updates.push('amount = ?');
        values.push(body.amount);
      }
      if (body.merchant_name !== undefined) {
        updates.push('merchant_name = ?');
        values.push(body.merchant_name);
      }

      const now = new Date().toISOString();
      updates.push('updated_at = ?');
      values.push(now);
      values.push(id);

      if (updates.length > 1) {
        db.prepare(`UPDATE transactions SET ${updates.join(', ')} WHERE id = ?`).run(...values);
      }

      // If category changed, upsert merchant_rule
      if (body.category_id !== undefined && body.category_id !== null) {
        const merchantName = existing.merchant_name || existing.original_name;
        if (merchantName) {
          const existingRule = db.prepare(
            'SELECT id FROM merchant_rules WHERE pattern = ?'
          ).get(merchantName) as { id: string } | undefined;

          if (existingRule) {
            db.prepare(
              'UPDATE merchant_rules SET category_id = ? WHERE id = ?'
            ).run(body.category_id, existingRule.id);
          } else {
            db.prepare(
              'INSERT INTO merchant_rules (id, pattern, category_id, created_at) VALUES (?, ?, ?, ?)'
            ).run(uuidv4(), merchantName, body.category_id, now);
          }
        }
      }

      const updated = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
      res.json({ data: updated });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /:id — delete only if manual
router.delete('/:id', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const { id } = req.params;

    const txn = db.prepare('SELECT is_manual FROM transactions WHERE id = ?').get(id) as
      | { is_manual: number }
      | undefined;

    if (!txn) {
      res.status(404).json({ error: 'Transaction not found' });
      return;
    }

    if (!txn.is_manual) {
      res.status(403).json({ error: 'Cannot delete non-manual transactions' });
      return;
    }

    db.prepare('DELETE FROM transactions WHERE id = ?').run(id);
    res.json({ data: { success: true } });
  } catch (err) {
    next(err);
  }
});

// POST /bulk/category — bulk update categories
router.post(
  '/bulk/category',
  validate(BulkCategorySchema),
  (req: Request, res: Response, next: NextFunction): void => {
    try {
      const db = getDb();
      const body = req.body as { ids: string[]; categoryId: string };

      const placeholders = body.ids.map(() => '?').join(',');
      const now = new Date().toISOString();

      db.prepare(
        `UPDATE transactions SET category_id = ?, updated_at = ? WHERE id IN (${placeholders})`
      ).run(body.categoryId, now, ...body.ids);

      res.json({ data: { updated: body.ids.length } });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
