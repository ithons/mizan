import { Router, Request, Response, NextFunction } from 'express';
import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/index';
import { validate } from '../middleware/validate';
import { adjustManualAccountBalance } from '../services/manualAccountBalance';
import { takeSnapshot } from '../services/snapshot';
import { detectRecurring } from '../services/recurring';
import {
  CreateManualTransactionSchema,
  UpdateTransactionSchema,
  BulkCategorySchema,
} from '../../../shared/schemas';

const router = Router();

function upsertMerchantRule(
  db: Database.Database,
  pattern: string | null | undefined,
  categoryId: string,
  createdAt: string
): void {
  if (!pattern) return;

  const existingRule = db.prepare(
    'SELECT id FROM merchant_rules WHERE pattern = ?'
  ).get(pattern) as { id: string } | undefined;

  if (existingRule) {
    db.prepare(
      'UPDATE merchant_rules SET category_id = ? WHERE id = ?'
    ).run(categoryId, existingRule.id);
    return;
  }

  db.prepare(
    'INSERT INTO merchant_rules (id, pattern, category_id, created_at) VALUES (?, ?, ?, ?)'
  ).run(uuidv4(), pattern, categoryId, createdAt);
}

function accountExists(db: Database.Database, accountId: string): boolean {
  return Boolean(db.prepare('SELECT id FROM accounts WHERE id = ?').get(accountId));
}

function categoryExists(db: Database.Database, categoryId: string): boolean {
  return Boolean(db.prepare('SELECT id FROM categories WHERE id = ?').get(categoryId));
}

function parseQueryNumber(value: string | string[] | undefined): number | null {
  if (value === undefined) return null;
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

// GET / - list transactions with filters
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
    if (query.minAmount !== undefined) {
      const minAmount = parseQueryNumber(query.minAmount);
      if (minAmount === null) {
        res.status(400).json({ error: 'Invalid minAmount filter' });
        return;
      }
      conditions.push('t.amount >= ?');
      params.push(minAmount);
    }
    if (query.maxAmount !== undefined) {
      const maxAmount = parseQueryNumber(query.maxAmount);
      if (maxAmount === null) {
        res.status(400).json({ error: 'Invalid maxAmount filter' });
        return;
      }
      conditions.push('t.amount <= ?');
      params.push(maxAmount);
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

    res.json({ data: { data, total: countRow.total, page, limit } });
  } catch (err) {
    next(err);
  }
});

// GET /:id - single transaction
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

// POST /manual - create manual transaction
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
      let balanceChanged = false;
      const categoryId = body.category_id || null;

      if (!accountExists(db, body.account_id)) {
        res.status(404).json({ error: 'Account not found' });
        return;
      }

      if (categoryId && !categoryExists(db, categoryId)) {
        res.status(404).json({ error: 'Category not found' });
        return;
      }

      const insertTransaction = db.transaction(() => {
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
          categoryId,
          body.notes || null,
          now,
          now
        );

        balanceChanged = adjustManualAccountBalance(db, body.account_id, body.amount, now);
      });

      insertTransaction();

      if (balanceChanged) {
        takeSnapshot();
      }
      detectRecurring();

      const txn = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
      res.status(201).json({ data: txn });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /:id - update transaction
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
        | {
            account_id: string;
            amount: number;
            category_id: string | null;
            is_manual: number;
            merchant_name: string | null;
            original_name: string;
          }
        | undefined;

      if (!existing) {
        res.status(404).json({ error: 'Transaction not found' });
        return;
      }

      const categoryId = body.category_id || null;
      if (body.category_id !== undefined && categoryId && !categoryExists(db, categoryId)) {
        res.status(404).json({ error: 'Category not found' });
        return;
      }

      const updates: string[] = [];
      const values: unknown[] = [];

      if (body.category_id !== undefined) {
        updates.push('category_id = ?');
        values.push(categoryId);
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

      let balanceChanged = false;
      if (updates.length > 1) {
        const updateTransaction = db.transaction(() => {
          db.prepare(`UPDATE transactions SET ${updates.join(', ')} WHERE id = ?`).run(...values);

          if (body.amount !== undefined && existing.is_manual) {
            balanceChanged = adjustManualAccountBalance(
              db,
              existing.account_id,
              body.amount - existing.amount,
              now
            );
          }
        });

        updateTransaction();
      }

      // If category changed, upsert merchant_rule
      if (body.category_id !== undefined && categoryId) {
        const merchantName = existing.merchant_name || existing.original_name;
        upsertMerchantRule(db, merchantName, categoryId, now);
      }

      if (balanceChanged) {
        takeSnapshot();
      }
      detectRecurring();

      const updated = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
      res.json({ data: updated });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /:id - delete only if manual
router.delete('/:id', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const { id } = req.params;

    const txn = db.prepare('SELECT account_id, amount, is_manual FROM transactions WHERE id = ?').get(id) as
      | { account_id: string; amount: number; is_manual: number }
      | undefined;

    if (!txn) {
      res.status(404).json({ error: 'Transaction not found' });
      return;
    }

    if (!txn.is_manual) {
      res.status(403).json({ error: 'Cannot delete non-manual transactions' });
      return;
    }

    let balanceChanged = false;
    const deleteTransaction = db.transaction(() => {
      db.prepare('DELETE FROM transactions WHERE id = ?').run(id);
      balanceChanged = adjustManualAccountBalance(db, txn.account_id, -txn.amount, new Date().toISOString());
    });

    deleteTransaction();

    if (balanceChanged) {
      takeSnapshot();
    }
    detectRecurring();

    res.json({ data: { success: true } });
  } catch (err) {
    next(err);
  }
});

// POST /bulk-category - bulk update categories
router.post(
  '/bulk-category',
  validate(BulkCategorySchema),
  (req: Request, res: Response, next: NextFunction): void => {
    try {
      const db = getDb();
      const body = req.body as { ids: string[]; categoryId: string };
      const transactionIds = Array.from(new Set(body.ids));

      if (!categoryExists(db, body.categoryId)) {
        res.status(404).json({ error: 'Category not found' });
        return;
      }

      const placeholders = transactionIds.map(() => '?').join(',');
      const now = new Date().toISOString();

      const updateCategories = db.transaction(() => {
        const selectedTransactions = db.prepare(`
          SELECT id, merchant_name, original_name
          FROM transactions
          WHERE id IN (${placeholders})
        `).all(...transactionIds) as Array<{
          id: string;
          merchant_name: string | null;
          original_name: string;
        }>;

        if (selectedTransactions.length !== transactionIds.length) {
          throw new Error('MISSING_TRANSACTIONS');
        }

        db.prepare(
          `UPDATE transactions SET category_id = ?, updated_at = ? WHERE id IN (${placeholders})`
        ).run(body.categoryId, now, ...transactionIds);

        const patterns = new Set(
          selectedTransactions
            .map((transaction) => transaction.merchant_name || transaction.original_name)
            .filter((pattern) => pattern.length > 0)
        );

        for (const pattern of patterns) {
          upsertMerchantRule(db, pattern, body.categoryId, now);
        }
      });

      try {
        updateCategories();
      } catch (err) {
        if ((err as Error).message === 'MISSING_TRANSACTIONS') {
          res.status(404).json({ error: 'One or more transactions were not found' });
          return;
        }
        throw err;
      }

      res.json({ data: { updated: transactionIds.length } });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
