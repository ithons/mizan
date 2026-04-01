import { Router, Request, Response, NextFunction } from 'express';
import { getDb } from '../db/index';
import { takeSnapshot } from '../services/snapshot';

const router = Router();

// POST /snapshot — take net worth snapshot
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

// GET /history?startDate&endDate
router.get('/history', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const { startDate, endDate } = req.query as Record<string, string>;

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (startDate) {
      conditions.push('date >= ?');
      params.push(startDate);
    }
    if (endDate) {
      conditions.push('date <= ?');
      params.push(endDate);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const snapshots = db.prepare(`
      SELECT * FROM net_worth_snapshots
      ${where}
      ORDER BY date ASC
    `).all(...params);

    res.json({ data: { snapshots } });
  } catch (err) {
    next(err);
  }
});

export default router;
