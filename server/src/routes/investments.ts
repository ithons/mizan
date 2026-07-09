import { Router, Request, Response, NextFunction } from 'express';
import { getDb } from '../db/index';
import { validate } from '../middleware/validate';
import { UpdateHoldingCostBasisSchema, UpdateSecurityMetadataSchema } from '../../../shared/schemas';
import {
  getHoldingHistory,
  listHoldingsWithMetadata,
  setManualCostBasis,
  setSecurityMetadata,
} from '../services/investmentMetadata';

const router = Router();

function routeParam(value: string | string[] | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

// GET /holdings - all holdings JOIN securities
router.get('/holdings', (_req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    res.json({ data: listHoldingsWithMetadata(db) });
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

      res.json({ data: setManualCostBasis(db, id, req.body) });
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
    res.json({ data: getHoldingHistory(db, id, days) });
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

    res.json({ data: listHoldingsWithMetadata(db, accountId) });
  } catch (err) {
    next(err);
  }
});

// GET /transactions - investment transactions with filters
router.get('/transactions', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const query = req.query as Record<string, string>;

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (query.accountId) {
      conditions.push('it.account_id = ?');
      params.push(query.accountId);
    }
    if (query.startDate) {
      conditions.push('it.date >= ?');
      params.push(query.startDate);
    }
    if (query.endDate) {
      conditions.push('it.date <= ?');
      params.push(query.endDate);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const txns = db.prepare(`
      SELECT
        it.*,
        s.ticker,
        s.name AS security_name
      FROM investment_transactions it
      LEFT JOIN securities s ON s.id = it.security_id
      ${where}
      ORDER BY it.date DESC, it.created_at DESC
    `).all(...params);

    res.json({ data: txns });
  } catch (err) {
    next(err);
  }
});

// GET /transactions/:accountId
router.get('/transactions/:accountId', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const txns = db.prepare(`
      SELECT
        it.*,
        s.ticker,
        s.name AS security_name
      FROM investment_transactions it
      LEFT JOIN securities s ON s.id = it.security_id
      WHERE it.account_id = ?
      ORDER BY it.date DESC, it.created_at DESC
    `).all(req.params.accountId);

    res.json({ data: txns });
  } catch (err) {
    next(err);
  }
});

export default router;
