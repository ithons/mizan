import { Router, Request, Response, NextFunction } from 'express';
import { getDb } from '../db/index';
import { validate } from '../middleware/validate';
import {
  CreateManualAccountSchema,
  UpdateAccountSchema,
  MergeAccountSchema,
} from '../../../shared/schemas';
import { takeSnapshot } from '../services/snapshot';
import { dollarizeFields } from '../services/money';
import {
  createManualAccount,
  deleteAccount,
  getAccountBalanceHistory,
  listAccounts,
  mergeAccounts,
  updateAccount,
} from '../services/accounts';

const router = Router();

// current_balance/available_balance/credit_limit are stored as integer cents; the
// API contract is dollars, so account rows are dollarized on the way out.
// native_balance (crypto quantity) is NOT money and is left untouched.
const ACCOUNT_MONEY_FIELDS = ['current_balance', 'available_balance', 'credit_limit'] as const;

function accountToDollars<T extends Record<string, unknown>>(row: T): T {
  return dollarizeFields(row, ACCOUNT_MONEY_FIELDS);
}

function routeId(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] : value ?? '';
}

// GET / - all accounts with current_balance, sorted by sort_order
router.get('/', (_req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    res.json({ data: listAccounts(db).map(accountToDollars) });
  } catch (err) {
    next(err);
  }
});

// GET /:id/history - this account's balance over time (from net-worth snapshot breakdowns)
router.get('/:id/history', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const history = getAccountBalanceHistory(db, routeId(req.params.id));
    res.json({ data: history.map((point) => dollarizeFields({ ...point }, ['balance'])) });
  } catch (err) {
    next(err);
  }
});

// POST /manual - create manual account
router.post(
  '/manual',
  validate(CreateManualAccountSchema),
  (req: Request, res: Response, next: NextFunction): void => {
    try {
      const db = getDb();
      const account = createManualAccount(db, req.body);

      // Take a fresh snapshot so net worth reflects the new account immediately.
      takeSnapshot();

      res.status(201).json({ data: accountToDollars(account) });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /:id - update account
router.patch(
  '/:id',
  validate(UpdateAccountSchema),
  (req: Request, res: Response, next: NextFunction): void => {
    try {
      const db = getDb();
      const result = updateAccount(db, routeId(req.params.id), req.body);

      if (!result.ok) {
        if (result.reason === 'not_found') {
          res.status(404).json({ error: 'Account not found' });
        } else {
          res.status(400).json({ error: 'Only manual accounts can be edited directly' });
        }
        return;
      }

      // If balance changed, refresh the net worth snapshot.
      if (result.balanceChanged) {
        takeSnapshot();
      }

      res.json({ data: accountToDollars(result.row) });
    } catch (err) {
      next(err);
    }
  }
);

// POST /merge - merge two accounts
router.post(
  '/merge',
  validate(MergeAccountSchema),
  (req: Request, res: Response, next: NextFunction): void => {
    try {
      const db = getDb();
      const { targetAccountId, sourceAccountId } = req.body as {
        targetAccountId: string;
        sourceAccountId: string;
      };

      const result = mergeAccounts(db, targetAccountId, sourceAccountId);
      if (!result.ok) {
        if (result.reason === 'same_account') {
          res.status(400).json({ error: 'Cannot merge an account into itself' });
        } else {
          res.status(404).json({ error: 'One or both accounts not found' });
        }
        return;
      }

      takeSnapshot();
      res.json({ data: { success: true } });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /:id - delete a manual account, or hide a synced one
router.delete('/:id', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const result = deleteAccount(db, routeId(req.params.id));

    if (!result.ok) {
      res.status(404).json({ error: 'Account not found' });
      return;
    }

    // Refresh net worth snapshot after account removal.
    takeSnapshot();
    res.json({ data: { success: true } });
  } catch (err) {
    next(err);
  }
});

export default router;
