import { Router, Request, Response, NextFunction } from 'express';
import { getDb } from '../db/index';
import { validate } from '../middleware/validate';
import { UpdateHoldingCostBasisSchema, UpdateSecurityMetadataSchema } from '../../../shared/schemas';
import {
  getHoldingHistory,
  listHoldingsWithMetadata,
  setManualCostBasis,
  setSecurityMetadata,
  type HoldingHistoryPoint,
} from '../services/investmentMetadata';
import { dollarizeFields } from '../services/money';
import type { Holding } from '../../../shared/types';

const router = Router();

// The service returns money in integer cents; dollarize at the route boundary.
// institution_price (per-unit) and quantity (share count) are NOT money.
const HOLDING_MONEY_FIELDS = [
  'institution_value',
  'provider_cost_basis',
  'cost_basis',
  'effective_cost_basis',
  'manual_cost_basis',
] as const;
const HISTORY_MONEY_FIELDS = ['institution_value', 'cost_basis'] as const;

function holdingToDollars(holding: Holding): Holding {
  return dollarizeFields(holding as unknown as Record<string, unknown>, HOLDING_MONEY_FIELDS) as unknown as Holding;
}

function historyPointToDollars(point: HoldingHistoryPoint): HoldingHistoryPoint {
  return dollarizeFields(point as unknown as Record<string, unknown>, HISTORY_MONEY_FIELDS) as unknown as HoldingHistoryPoint;
}

function routeParam(value: string | string[] | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

// GET /holdings - all holdings JOIN securities
router.get('/holdings', (_req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    res.json({ data: listHoldingsWithMetadata(db).map(holdingToDollars) });
  } catch (err) {
    next(err);
  }
});

router.put(
  '/holdings/:id/cost-basis',
  validate(UpdateHoldingCostBasisSchema),
  (req: Request, res: Response, next: NextFunction): void => {
    try {
      const db = getDb();
      const id = routeParam(req.params.id);
      if (!id) {
        res.status(400).json({ error: 'Invalid holding id' });
        return;
      }

      res.json({ data: holdingToDollars(setManualCostBasis(db, id, req.body)) });
    } catch (err) {
      next(err);
    }
  }
);

router.put(
  '/securities/:id/metadata',
  validate(UpdateSecurityMetadataSchema),
  (req: Request, res: Response, next: NextFunction): void => {
    try {
      const db = getDb();
      const id = routeParam(req.params.id);
      if (!id) {
        res.status(400).json({ error: 'Invalid security id' });
        return;
      }

      res.json({ data: setSecurityMetadata(db, id, req.body) });
    } catch (err) {
      next(err);
    }
  }
);

// GET /holdings/:id/history - value-over-time series for a single holding
router.get('/holdings/:id/history', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const id = routeParam(req.params.id);
    if (!id) {
      res.status(400).json({ error: 'Invalid holding id' });
      return;
    }

    const days = req.query.days ? parseInt(req.query.days as string, 10) : undefined;
    res.json({ data: getHoldingHistory(db, id, days).map(historyPointToDollars) });
  } catch (err) {
    next(err);
  }
});

// GET /holdings/:accountId - holdings for specific account
router.get('/holdings/:accountId', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const accountId = routeParam(req.params.accountId);
    if (!accountId) {
      res.status(400).json({ error: 'Invalid account id' });
      return;
    }

    res.json({ data: listHoldingsWithMetadata(db, accountId).map(holdingToDollars) });
  } catch (err) {
    next(err);
  }
});
export default router;
