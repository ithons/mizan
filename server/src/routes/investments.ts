import { Router, Request, Response, NextFunction } from 'express';
import { getDb } from '../db/index';

const router = Router();

// GET /holdings — all holdings JOIN securities
router.get('/holdings', (_req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const holdings = db.prepare(`
      SELECT
        h.*,
        s.ticker,
        s.name AS security_name,
        s.type AS security_type
      FROM holdings h
      JOIN securities s ON s.id = h.security_id
      ORDER BY h.institution_value DESC
    `).all();

    res.json({ data: holdings });
  } catch (err) {
    next(err);
  }
});

// GET /holdings/:accountId — holdings for specific account
router.get('/holdings/:accountId', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const holdings = db.prepare(`
      SELECT
        h.*,
        s.ticker,
        s.name AS security_name,
        s.type AS security_type
      FROM holdings h
      JOIN securities s ON s.id = h.security_id
      WHERE h.account_id = ?
      ORDER BY h.institution_value DESC
    `).all(req.params.accountId);

    res.json({ data: holdings });
  } catch (err) {
    next(err);
  }
});

// GET /transactions — investment transactions with filters
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
