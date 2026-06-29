import { Router, Request, Response, NextFunction } from 'express';
import { getDb } from '../db/index';
import { takeSnapshot } from '../services/snapshot';

const router = Router();

function parsePositiveIntegerQuery(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

// GET /snapshot - return the latest net worth snapshot
router.get('/snapshot', (_req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const snapshot = db.prepare(
      'SELECT * FROM net_worth_snapshots ORDER BY date DESC LIMIT 1'
    ).get();

    res.json({ data: snapshot ?? null });
  } catch (err) {
    next(err);
  }
});

// POST /snapshot - take net worth snapshot
router.post('/snapshot', (_req: Request, res: Response, next: NextFunction): void => {
  try {
    takeSnapshot();

    const db = getDb();
    const today = new Date().toISOString().split('T')[0];
    const snapshot = db.prepare(
      'SELECT * FROM net_worth_snapshots WHERE date = ?'
    ).get(today);

    res.json({ data: snapshot });
  } catch (err) {
    next(err);
  }
});

// GET /history?startDate&endDate&months
router.get('/history', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const { startDate, endDate } = req.query as Record<string, string>;
    const months = parsePositiveIntegerQuery(req.query.months);

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (months === null) {
      res.status(400).json({ error: 'Invalid months filter' });
      return;
    }

    if (months !== undefined) {
      const cutoff = new Date();
      cutoff.setMonth(cutoff.getMonth() - months);
      conditions.push('date >= ?');
      params.push(cutoff.toISOString().split('T')[0]);
    } else {
      if (startDate) {
        conditions.push('date >= ?');
        params.push(startDate);
      }
      if (endDate) {
        conditions.push('date <= ?');
        params.push(endDate);
      }
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const snapshots = db.prepare(`
      SELECT * FROM net_worth_snapshots
      ${where}
      ORDER BY date ASC
    `).all(...params);

    res.json({ data: snapshots });
  } catch (err) {
    next(err);
  }
});

export default router;
