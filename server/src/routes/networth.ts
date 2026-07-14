import { Router, Request, Response, NextFunction } from 'express';
import { getDb } from '../db/index';
import { takeSnapshot } from '../services/snapshot';
import { dollarizeFields, toDollars } from '../services/money';

const router = Router();

const SNAPSHOT_MONEY_FIELDS = [
  'total_assets',
  'total_liabilities',
  'net_worth',
  'liquid_assets',
  'investment_assets',
  'crypto_assets',
] as const;

// net_worth_snapshots stores totals and the per-account `breakdown` JSON in cents.
// The API contract is dollars, so convert the numeric columns and restringify the
// breakdown values on the way out.
function dollarizeBreakdownString(value: string): string {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return value;
    const out: Record<string, unknown> = {};
    for (const [id, v] of Object.entries(parsed)) {
      out[id] = typeof v === 'number' ? toDollars(v) : v;
    }
    return JSON.stringify(out);
  } catch {
    return value;
  }
}

function dollarizeSnapshotRow(row: unknown): unknown {
  if (row == null || typeof row !== 'object') return row;
  const converted = dollarizeFields(row as Record<string, unknown>, SNAPSHOT_MONEY_FIELDS);
  if (typeof converted.breakdown === 'string') {
    converted.breakdown = dollarizeBreakdownString(converted.breakdown);
  }
  return converted;
}

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

    res.json({ data: snapshot ? dollarizeSnapshotRow(snapshot) : null });
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

    res.json({ data: snapshot ? dollarizeSnapshotRow(snapshot) : null });
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

    res.json({ data: snapshots.map(dollarizeSnapshotRow) });
  } catch (err) {
    next(err);
  }
});

export default router;
