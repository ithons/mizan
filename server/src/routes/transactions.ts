import { Router, Request, Response, NextFunction } from 'express';
import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/index';
import { validate } from '../middleware/validate';
import { adjustManualAccountBalance } from '../services/manualAccountBalance';
import { takeSnapshot } from '../services/snapshot';
import { detectRecurring } from '../services/recurring';
import { applyMerchantRuleToMatchingTransactions, upsertMerchantRule } from '../services/rules';
import { getTransactionReviewSummary } from '../services/transactionReview';
import {
  confirmTransferPair,
  dismissDuplicateGroup,
  dismissTransferPair,
  refreshTransactionIntegrity,
} from '../services/transactionIntegrity';
import {
  CreateManualTransactionSchema,
  UpdateTransactionSchema,
  BulkCategorySchema,
  TransactionReviewStatusSchema,
} from '../../../shared/schemas';
import { toCents, dollarizeFields } from '../services/money';

const router = Router();

// transactions.amount is stored as integer cents; the API contract is dollars, so
// transaction rows are dollarized on the way out. No other numeric column here is money.
function transactionToDollars<T extends Record<string, unknown>>(row: T): T {
  return dollarizeFields(row, ['amount']);
}

function accountExists(db: Database.Database, accountId: string): boolean {
  return Boolean(db.prepare('SELECT id FROM accounts WHERE id = ?').get(accountId));
}

function categoryExists(db: Database.Database, categoryId: string): boolean {
  return Boolean(db.prepare('SELECT id FROM categories WHERE id = ?').get(categoryId));
}

function expandCategoryIds(db: Database.Database, categoryIds: string[]): string[] {
  const categories = db.prepare('SELECT id, parent_id FROM categories').all() as Array<{
    id: string;
    parent_id: string | null;
  }>;
  const childrenByParent = new Map<string, string[]>();

  for (const category of categories) {
    if (!category.parent_id) continue;
    const children = childrenByParent.get(category.parent_id) ?? [];
    children.push(category.id);
    childrenByParent.set(category.parent_id, children);
  }

  const expanded = new Set<string>();
  const addWithDescendants = (categoryId: string): void => {
    if (expanded.has(categoryId)) return;
    expanded.add(categoryId);

    for (const childId of childrenByParent.get(categoryId) ?? []) {
      addWithDescendants(childId);
    }
  };

  for (const categoryId of categoryIds) {
    addWithDescendants(categoryId);
  }

  return Array.from(expanded);
}

function parseQueryNumber(value: string | string[] | undefined): number | null {
  if (value === undefined) return null;
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function parsePositiveIntegerQuery(
  value: string | string[] | undefined,
  defaultValue: number,
  max?: number
): number | null {
  if (value === undefined) return defaultValue;

  const raw = Array.isArray(value) ? value[0] : value;
  if (!/^\d+$/.test(raw)) return null;

  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return null;

  return max === undefined ? parsed : Math.min(parsed, max);
}

function parseBooleanQuery(value: string | string[] | undefined): boolean | null | undefined {
  if (value === undefined) return undefined;

  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return null;
}

type TransactionSortBy = 'date' | 'amount' | 'merchant';
type TransactionSortDir = 'asc' | 'desc';

function parseSortBy(value: string | string[] | undefined): TransactionSortBy | null {
  if (value === undefined || value === '') return 'date';

  const raw = Array.isArray(value) ? value[0] : value;
  return raw === 'date' || raw === 'amount' || raw === 'merchant' ? raw : null;
}

function parseSortDir(value: string | string[] | undefined): TransactionSortDir | null {
  if (value === undefined || value === '') return 'desc';

  const raw = Array.isArray(value) ? value[0] : value;
  return raw === 'asc' || raw === 'desc' ? raw : null;
}

function transactionOrderBy(sortBy: TransactionSortBy, sortDir: TransactionSortDir): string {
  const direction = sortDir.toUpperCase();

  switch (sortBy) {
    case 'amount':
      return `t.amount ${direction}, t.date DESC, t.created_at DESC`;
    case 'merchant':
      return `lower(COALESCE(t.merchant_name, t.original_name, '')) ${direction}, t.date DESC, t.created_at DESC`;
    case 'date':
      return `t.date ${direction}, t.created_at ${direction}`;
  }
}

// GET / - list transactions with filters
router.get('/', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const query = req.query as Record<string, string | string[]>;

    const page = parsePositiveIntegerQuery(query.page, 1);
    const limit = parsePositiveIntegerQuery(query.limit, 50, 500);
    if (page === null) {
      res.status(400).json({ error: 'Invalid page filter' });
      return;
    }
    if (limit === null) {
      res.status(400).json({ error: 'Invalid limit filter' });
      return;
    }
    const sortBy = parseSortBy(query.sortBy);
    if (sortBy === null) {
      res.status(400).json({ error: 'Invalid sortBy filter' });
      return;
    }
    const sortDir = parseSortDir(query.sortDir);
    if (sortDir === null) {
      res.status(400).json({ error: 'Invalid sortDir filter' });
      return;
    }

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
      const expandedCategoryIds = expandCategoryIds(
        db,
        categoryIds.map((id) => id.trim()).filter(Boolean)
      );

      if (expandedCategoryIds.length > 0) {
        conditions.push(`t.category_id IN (${expandedCategoryIds.map(() => '?').join(',')})`);
        params.push(...expandedCategoryIds);
      }
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
      params.push(toCents(minAmount));
    }
    if (query.maxAmount !== undefined) {
      const maxAmount = parseQueryNumber(query.maxAmount);
      if (maxAmount === null) {
        res.status(400).json({ error: 'Invalid maxAmount filter' });
        return;
      }
      conditions.push('t.amount <= ?');
      params.push(toCents(maxAmount));
    }
    if (query.pending !== undefined) {
      const pending = parseBooleanQuery(query.pending);
      if (pending === null) {
        res.status(400).json({ error: 'Invalid pending filter' });
        return;
      }
      conditions.push('t.pending = ?');
      params.push(pending ? 1 : 0);
    }
    if (query.recurring !== undefined) {
      const recurring = parseBooleanQuery(query.recurring);
      if (recurring === null) {
        res.status(400).json({ error: 'Invalid recurring filter' });
        return;
      }
      conditions.push(recurring ? 't.recurring_id IS NOT NULL' : 't.recurring_id IS NULL');
    }
    if (query.uncategorized !== undefined) {
      const uncategorized = parseBooleanQuery(query.uncategorized);
      if (uncategorized === null) {
        res.status(400).json({ error: 'Invalid uncategorized filter' });
        return;
      }
      conditions.push(uncategorized ? 't.category_id IS NULL' : 't.category_id IS NOT NULL');
    }
    if (query.reviewStatus !== undefined) {
      const reviewStatus = Array.isArray(query.reviewStatus) ? query.reviewStatus[0] : query.reviewStatus;
      if (!['open', 'reviewed', 'dismissed'].includes(reviewStatus)) {
        res.status(400).json({ error: 'Invalid reviewStatus filter' });
        return;
      }
      conditions.push('t.review_status = ?');
      params.push(reviewStatus);
    }
    if (query.type !== undefined) {
      const type = Array.isArray(query.type) ? query.type[0] : query.type;
      if (type === 'income') {
        conditions.push('t.amount > 0');
      } else if (type === 'expense') {
        conditions.push('t.amount < 0');
      } else if (type !== '') {
        res.status(400).json({ error: 'Invalid type filter' });
        return;
      }
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
      ORDER BY ${transactionOrderBy(sortBy, sortDir)}
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as Record<string, unknown>[];

    res.json({
      data: {
        data: data.map(transactionToDollars),
        total: countRow.total,
        page,
        limit,
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /review - summary of transaction review queues
router.get('/review', (_req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    res.json({ data: getTransactionReviewSummary(db) });
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
    `).get(req.params.id) as Record<string, unknown> | undefined;

    if (!txn) {
      res.status(404).json({ error: 'Transaction not found' });
      return;
    }

    res.json({ data: transactionToDollars(txn) });
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
      const amountCents = toCents(body.amount);

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
             category_id, pending, notes, is_manual, source_type, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 1, 'manual', ?, ?)
        `).run(
          id,
          body.account_id,
          body.date,
          amountCents,
          body.merchant_name || null,
          body.original_name,
          categoryId,
          body.notes || null,
          now,
          now
        );

        balanceChanged = adjustManualAccountBalance(db, body.account_id, amountCents, now);
      });

      insertTransaction();

      if (balanceChanged) {
        takeSnapshot();
      }
      detectRecurring();
      refreshTransactionIntegrity(db);

      const txn = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id) as Record<string, unknown>;
      res.status(201).json({ data: transactionToDollars(txn) });
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

      // body.amount arrives in dollars; convert once and reuse for the column write and
      // the manual-account rebalance (existing.amount is already cents).
      const amountCents = body.amount !== undefined ? toCents(body.amount) : undefined;

      const updates: string[] = [];
      const values: unknown[] = [];

      if (body.category_id !== undefined) {
        updates.push('category_id = ?');
        values.push(categoryId);
        if (categoryId) {
          updates.push("review_status = 'reviewed'");
        }
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
        values.push(amountCents);
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

          if (amountCents !== undefined && existing.is_manual) {
            balanceChanged = adjustManualAccountBalance(
              db,
              existing.account_id,
              amountCents - existing.amount,
              now
            );
          }
        });

        updateTransaction();
      }

      // If category changed, upsert merchant_rule
      let categorization: {
        rule_id: string | null;
        pattern: string | null;
        applied: number;
      } = { rule_id: null, pattern: null, applied: 0 };

      if (body.category_id !== undefined && categoryId) {
        const merchantName = existing.merchant_name || existing.original_name;
        const ruleId = upsertMerchantRule(db, merchantName, categoryId, now);
        const result = applyMerchantRuleToMatchingTransactions(db, merchantName, categoryId, now);
        categorization = {
          rule_id: ruleId,
          pattern: merchantName,
          applied: result.updated,
        };
      }

      if (balanceChanged) {
        takeSnapshot();
      }
      detectRecurring();
      refreshTransactionIntegrity(db);

      const updated = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id) as Record<string, unknown>;
      res.json({ data: { transaction: transactionToDollars(updated), categorization } });
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
    refreshTransactionIntegrity(db);

    res.json({ data: { success: true } });
  } catch (err) {
    next(err);
  }
});

// PATCH /:id/review - mark a transaction review state without changing money data
router.patch(
  '/:id/review',
  validate(TransactionReviewStatusSchema),
  (req: Request, res: Response, next: NextFunction): void => {
    try {
      const db = getDb();
      const { id } = req.params;
      const { status } = req.body as { status: 'open' | 'reviewed' | 'dismissed' };
      const now = new Date().toISOString();

      const result = db.prepare(`
        UPDATE transactions
        SET review_status = ?,
            updated_at = ?
        WHERE id = ?
      `).run(status, now, id);

      if (result.changes === 0) {
        res.status(404).json({ error: 'Transaction not found' });
        return;
      }

      const reviewed = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id) as Record<string, unknown>;
      res.json({ data: transactionToDollars(reviewed) });
    } catch (err) {
      next(err);
    }
  }
);

// POST /duplicates/:groupId/dismiss - dismiss a duplicate candidate group
router.post('/duplicates/:groupId/dismiss', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const groupId = Array.isArray(req.params.groupId) ? req.params.groupId[0] : req.params.groupId;
    const changed = dismissDuplicateGroup(db, groupId);
    refreshTransactionIntegrity(db);
    res.json({ data: { updated: changed } });
  } catch (err) {
    next(err);
  }
});

// POST /transfers/:pairId/confirm - confirm an automatically detected transfer pair
router.post('/transfers/:pairId/confirm', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const pairId = Array.isArray(req.params.pairId) ? req.params.pairId[0] : req.params.pairId;
    const changed = confirmTransferPair(db, pairId);
    res.json({ data: { updated: changed } });
  } catch (err) {
    next(err);
  }
});

// POST /transfers/:pairId/dismiss - dismiss an automatically detected transfer pair
router.post('/transfers/:pairId/dismiss', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const pairId = Array.isArray(req.params.pairId) ? req.params.pairId[0] : req.params.pairId;
    const changed = dismissTransferPair(db, pairId);
    refreshTransactionIntegrity(db);
    res.json({ data: { updated: changed } });
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
          `UPDATE transactions SET category_id = ?, review_status = 'reviewed', updated_at = ? WHERE id IN (${placeholders})`
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

      refreshTransactionIntegrity(db);
      res.json({ data: { updated: transactionIds.length } });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
