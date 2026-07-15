import { Router, Request, Response, NextFunction } from 'express';
import { getDb } from '../db/index';
import { validate } from '../middleware/validate';
import { takeSnapshot } from '../services/snapshot';
import { detectRecurring } from '../services/recurring';
import { getTransactionReviewSummary } from '../services/transactionReview';
import {
  confirmTransferPair,
  dismissDuplicateGroup,
  dismissTransferPair,
  refreshTransactionIntegrity,
} from '../services/transactionIntegrity';
import {
  bulkCategorizeTransactions,
  createManualTransaction,
  deleteTransaction,
  getTransactionById,
  listTransactions,
  setTransactionReviewStatus,
  updateTransaction,
  type TransactionListFilters,
  type TransactionSortBy,
  type TransactionSortDir,
} from '../services/transactions';
import {
  CreateManualTransactionSchema,
  UpdateTransactionSchema,
  BulkCategorySchema,
  TransactionReviewStatusSchema,
} from '../../../shared/schemas';
import { dollarizeFields } from '../services/money';

const router = Router();

// transactions.amount is stored as integer cents; the API contract is dollars, so
// transaction rows are dollarized on the way out. No other numeric column here is money.
function transactionToDollars<T extends Record<string, unknown>>(row: T): T {
  return dollarizeFields(row, ['amount']);
}

// ─── query-string parsing (HTTP concern: returns null -> 400) ────────────────

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

function toStringArray(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function routeId(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] : value ?? '';
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

    const filters: TransactionListFilters = {
      page,
      limit,
      sortBy,
      sortDir,
      accountIds: toStringArray(query.accountId),
      categoryIds: toStringArray(query.categoryId),
    };

    if (query.startDate) filters.startDate = query.startDate as string;
    if (query.endDate) filters.endDate = query.endDate as string;
    if (query.search) filters.search = query.search as string;

    if (query.minAmount !== undefined) {
      const minAmount = parseQueryNumber(query.minAmount);
      if (minAmount === null) {
        res.status(400).json({ error: 'Invalid minAmount filter' });
        return;
      }
      filters.minAmount = minAmount;
    }
    if (query.maxAmount !== undefined) {
      const maxAmount = parseQueryNumber(query.maxAmount);
      if (maxAmount === null) {
        res.status(400).json({ error: 'Invalid maxAmount filter' });
        return;
      }
      filters.maxAmount = maxAmount;
    }
    if (query.pending !== undefined) {
      const pending = parseBooleanQuery(query.pending);
      if (pending === null) {
        res.status(400).json({ error: 'Invalid pending filter' });
        return;
      }
      filters.pending = pending;
    }
    if (query.recurring !== undefined) {
      const recurring = parseBooleanQuery(query.recurring);
      if (recurring === null) {
        res.status(400).json({ error: 'Invalid recurring filter' });
        return;
      }
      filters.recurring = recurring;
    }
    if (query.uncategorized !== undefined) {
      const uncategorized = parseBooleanQuery(query.uncategorized);
      if (uncategorized === null) {
        res.status(400).json({ error: 'Invalid uncategorized filter' });
        return;
      }
      filters.uncategorized = uncategorized;
    }
    if (query.reviewStatus !== undefined) {
      const reviewStatus = Array.isArray(query.reviewStatus) ? query.reviewStatus[0] : query.reviewStatus;
      if (!['open', 'reviewed', 'dismissed'].includes(reviewStatus)) {
        res.status(400).json({ error: 'Invalid reviewStatus filter' });
        return;
      }
      filters.reviewStatus = reviewStatus;
    }
    if (query.type !== undefined) {
      const type = Array.isArray(query.type) ? query.type[0] : query.type;
      if (type === 'income' || type === 'expense') {
        filters.type = type;
      } else if (type !== '') {
        res.status(400).json({ error: 'Invalid type filter' });
        return;
      }
    }

    const { rows, total } = listTransactions(db, filters);

    res.json({
      data: {
        data: rows.map(transactionToDollars),
        total,
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
    const txn = getTransactionById(db, routeId(req.params.id));
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
      const result = createManualTransaction(db, req.body);

      if (!result.ok) {
        const error = result.reason === 'account_not_found' ? 'Account not found' : 'Category not found';
        res.status(404).json({ error });
        return;
      }

      if (result.balanceChanged) {
        takeSnapshot();
      }
      detectRecurring();
      refreshTransactionIntegrity(db);

      res.status(201).json({ data: transactionToDollars(result.row) });
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
      const result = updateTransaction(db, routeId(req.params.id), req.body);

      if (!result.ok) {
        if (result.reason === 'not_found') {
          res.status(404).json({ error: 'Transaction not found' });
        } else {
          res.status(404).json({ error: 'Category not found' });
        }
        return;
      }

      if (result.balanceChanged) {
        takeSnapshot();
      }
      detectRecurring();
      refreshTransactionIntegrity(db);

      res.json({
        data: {
          transaction: transactionToDollars(result.row),
          categorization: result.categorization,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /:id - delete only if manual
router.delete('/:id', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const result = deleteTransaction(db, routeId(req.params.id));

    if (!result.ok) {
      if (result.reason === 'not_found') {
        res.status(404).json({ error: 'Transaction not found' });
      } else {
        res.status(403).json({ error: 'Cannot delete non-manual transactions' });
      }
      return;
    }

    if (result.balanceChanged) {
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
      const { status } = req.body as { status: 'open' | 'reviewed' | 'dismissed' };
      const reviewed = setTransactionReviewStatus(db, routeId(req.params.id), status);

      if (!reviewed) {
        res.status(404).json({ error: 'Transaction not found' });
        return;
      }

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
      const result = bulkCategorizeTransactions(db, body.ids, body.categoryId);

      if (!result.ok) {
        if (result.reason === 'category_not_found') {
          res.status(404).json({ error: 'Category not found' });
        } else {
          res.status(404).json({ error: 'One or more transactions were not found' });
        }
        return;
      }

      refreshTransactionIntegrity(db);
      res.json({ data: { updated: result.updated } });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
