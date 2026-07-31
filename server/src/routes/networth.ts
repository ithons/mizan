import { Router, Request, Response, NextFunction } from 'express';
import { getDb } from '../db/index';
import { dollarizeFields, toDollars } from '../services/money';
import {
  readReconstructionFrontier,
  reconcileReconstructedHistory,
  reconstructionTrigger,
} from '../services/snapshot';

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

/**
 * GET /reconstruction - the state of the replayed half of the series.
 *
 * No money crosses this boundary, so nothing here goes through `dollarizeFields`: it is counts,
 * dates and one flag. The flag is the same `reconstructionTrigger` the sync stage consults, so the
 * screen cannot claim a rebuild is pending when the sync would decline to run one.
 */
router.get('/reconstruction', (_req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const frontier = readReconstructionFrontier(db);
    const counts = db.prepare(`
      SELECT SUM(CASE WHEN is_estimated = 1 THEN 1 ELSE 0 END) AS reconstructed,
             SUM(CASE WHEN is_estimated = 0 THEN 1 ELSE 0 END) AS measured,
             SUM(CASE WHEN is_estimated = 1 AND covered_accounts IS NULL THEN 1 ELSE 0 END) AS without_coverage
      FROM net_worth_snapshots
    `).get() as {
      reconstructed: number | null;
      measured: number | null;
      without_coverage: number | null;
    };

    res.json({
      data: {
        reconstructed: counts.reconstructed ?? 0,
        measured: counts.measured ?? 0,
        without_coverage: counts.without_coverage ?? 0,
        oldest_reconstructed: frontier.oldestEstimate,
        oldest_snapshot: frontier.oldestSnapshot,
        reconstructable_from: frontier.reconstructableFrom,
        // The mark, not MAX(created_at) over the rows: a run that justified no month writes no
        // row, and reporting "never replayed" for it would be false.
        last_run_at: frontier.mark?.derivedAt ?? null,
        pending: reconstructionTrigger(frontier),
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /reconstruction/rebuild - replay the ledger now, whatever the trigger says.
// The owner asking is its own justification: the frontier cannot see an import that landed inside
// the window already reconstructed. Measured snapshots are untouchable on both paths.
router.post('/reconstruction/rebuild', (_req: Request, res: Response, next: NextFunction): void => {
  try {
    res.json({ data: reconcileReconstructedHistory({ force: true }) });
  } catch (err) {
    next(err);
  }
});

export default router;
