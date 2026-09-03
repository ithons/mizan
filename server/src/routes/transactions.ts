import { Router, Request, Response, NextFunction } from 'express';
import { getDb } from '../db/index';
import { validate } from '../middleware/validate';
import { takeSnapshot } from '../services/snapshot';
import { detectRecurring } from '../services/recurring';
import { getTransactionReviewSummary } from '../services/transactionReview';
import {
  confirmTransferPair,
  confirmDuplicateGroup,
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
  releaseAmountToProvider,
  setTransactionReviewStatus,
  updateTransaction,
  type TransactionListFilters,
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
//
// `provider_amount` is the second one and travels with the first by necessity: it is what the
// institution still reports for an amount the owner corrected, decoded from the same integer cents
// in `transaction_field_revisions.to_value`. A screen that showed the corrected figure in dollars
// beside the provider's in cents would be off by a hundred on exactly the comparison the field
// exists to make. It is absent (NULL) on every row with no standing disagreement, and
// `dollarizeFields` leaves a non-number alone, so it survives the boundary as null.
function transactionToDollars<T extends Record<string, unknown>>(row: T): T {
  return dollarizeFields(row, ['amount', 'provider_amount']);
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

/**
 * Every value a repeated query param can arrive as.
 *
 * Express parses the query string with `qs`, and `qs` stops producing an ARRAY for a repeated key
 * once there are more than `arrayLimit` of them, which defaults to 20. Past that it produces an
 * index-keyed OBJECT: `{ '0': 'a', '1': 'b', … }`. The previous `Array.isArray(value) ? value :
 * [value]` therefore wrapped that whole object as a single element, which is a live defect at 21
 * repeats and not at 201: the ledger's "model suggests" filter sends one id per open proposal, so
 * a 21st proposal produced a one-element list holding an object, sailed past the id cap, and made
 * better-sqlite3 throw "Too few parameter values were provided" as a 500.
 *
 * Reproduced against the real router on a read-only copy of the live database before the fix.
 * `accountId` and `categoryId` come through the same function and had the same ceiling.
 */
function toStringArray(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (typeof value === 'object') return Object.values(value as Record<string, unknown>).map((v) => String(v));
  return [String(value)];
}

function routeId(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] : value ?? '';
}

/**
 * How many ids one request may name.
 *
 * The ledger's "model suggests" filter sends the exact rows the review summary judged still live.
 * Repeated query params are how they travel, and a URL is not an unbounded channel: Node's default
 * request-line and header ceiling is 16KB, and 200 uuids at 39 bytes each ("id=" plus 36) is about
 * 7.8KB, which leaves room for the rest of the query. Over the cap the request is refused rather
 * than truncated, because a silently shortened id list answers a question nobody asked.
 */
const MAX_ID_FILTER = 200;

const CATEGORY_SOURCE_VALUES = new Set(['human', 'ai', 'rule', 'heuristic', 'none']);
const DUPLICATE_STATUS_VALUES = new Set(['none', 'candidate', 'dismissed']);
const TRANSFER_STATUS_VALUES = new Set(['none', 'candidate', 'confirmed', 'dismissed']);

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
    const filters: TransactionListFilters = {
      page,
      limit,
      // Fixed, not read from the query. `sortBy`/`sortDir` were accepted here for the life of the
      // repo and no screen ever sent either: the only occurrences in `client/src` were the two
      // lines in `api.ts` that appended them. The ledger is a day-grouped list on a date spine
      // whose today rule separates what is expected from what has happened, and sorting it by
      // amount destroys that rule, so the parameter had no destination to be wired to. The
      // capability stays on the service, where `advisorChatTools` is a real caller.
      sortBy: 'date',
      sortDir: 'desc',
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
    if (query.id !== undefined) {
      const ids = toStringArray(query.id).filter((id) => id !== '');
      if (ids.length > MAX_ID_FILTER) {
        res.status(400).json({ error: `At most ${MAX_ID_FILTER} id filters` });
        return;
      }
      filters.ids = ids;
    }
    if (query.categorySource !== undefined) {
      const sources = toStringArray(query.categorySource).filter((s) => s !== '');
      if (sources.some((s) => !CATEGORY_SOURCE_VALUES.has(s))) {
        res.status(400).json({ error: 'Invalid categorySource filter' });
        return;
      }
      if (sources.length > 0) filters.categorySources = sources;
    }
    if (query.duplicateStatus !== undefined) {
      const status = routeId(query.duplicateStatus);
      if (!DUPLICATE_STATUS_VALUES.has(status)) {
        res.status(400).json({ error: 'Invalid duplicateStatus filter' });
        return;
      }
      filters.duplicateStatus = status;
    }
    if (query.transferStatus !== undefined) {
      const status = routeId(query.transferStatus);
      if (!TRANSFER_STATUS_VALUES.has(status)) {
        res.status(400).json({ error: 'Invalid transferStatus filter' });
        return;
      }
      filters.transferStatus = status;
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

// POST /:id/amount/release - hand a corrected amount back to the institution
//
// A POST rather than a PATCH with a magic body, because the value it writes is not in the request:
// the server reads what the provider last offered and adopts that. Letting the client name the
// number would let a stale screen re-assert a figure the institution has since moved off.
router.post('/:id/amount/release', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const result = releaseAmountToProvider(db, routeId(req.params.id));

    if (!result.ok) {
      if (result.reason === 'not_found') {
        res.status(404).json({ error: 'Transaction not found' });
      } else if (result.reason === 'not_corrected') {
        res.status(409).json({ error: 'This amount is already the one the institution reported' });
      } else {
        res.status(409).json({ error: 'This entry has no SimpleFIN amount to hand back to' });
      }
      return;
    }

    // Only when a figure actually moved. Releasing a field whose value the provider already agrees
    // with changes authorship and nothing else, and re-snapshotting on it would write a net-worth
    // row for an event with no money in it. Kept in step with the PATCH handler above, which takes
    // the same two follow-ups for the same reason.
    if (result.providerAmountAdopted !== null) {
      detectRecurring();
      refreshTransactionIntegrity(db);
    }

    res.json({ data: transactionToDollars(result.row) });
  } catch (err) {
    next(err);
  }
});

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

// POST /duplicates/:groupId/confirm - resolve a group as a REAL duplicate: keep one copy, exclude
// the rest from reports. Body: { keepId }.
router.post('/duplicates/:groupId/confirm', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const groupId = Array.isArray(req.params.groupId) ? req.params.groupId[0] : req.params.groupId;
    const keepId = typeof req.body?.keepId === 'string' ? req.body.keepId : '';
    if (!keepId) {
      res.status(400).json({ error: 'keepId (string) is required' });
      return;
    }

    const result = confirmDuplicateGroup(db, groupId, keepId);
    if (!result.ok) {
      res.status(result.reason === 'group_not_found' ? 404 : 400).json({
        error:
          result.reason === 'group_not_found'
            ? 'Duplicate group not found'
            : 'keepId must be one of the transactions in this group',
      });
      return;
    }

    // Recompute so the resolved group leaves the review queue immediately.
    refreshTransactionIntegrity(db);
    res.json({ data: { excluded: result.excluded } });
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
