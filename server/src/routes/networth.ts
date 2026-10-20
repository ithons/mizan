import { format, subMonths } from 'date-fns';
import { Router, Request, Response, NextFunction } from 'express';
import { getDb } from '../db/index';
import { dollarizeFields, toDollars } from '../services/money';
import type Database from 'better-sqlite3';
import { parseBreakdown, transfersInTransit } from '../services/inTransit';
import { netWorthNow, netWorthTimeline, type TimelineStep } from '../services/netWorthTimeline';

const router = Router();

const SNAPSHOT_MONEY_FIELDS = [
  'total_assets',
  'total_liabilities',
  'net_worth',
  'liquid_assets',
  'investment_assets',
  'crypto_assets',
  'in_transit',
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

/** A measured sheet carries what was in flight between the owner's accounts when it was read. */
function withInTransit(db: Database.Database, row: Record<string, unknown>): Record<string, unknown> {
  const transit = transfersInTransit(db, {
    date: String(row.date),
    taken_at: (row.taken_at as string | null) ?? null,
    created_at: String(row.created_at),
    breakdown: parseBreakdown(typeof row.breakdown === 'string' ? row.breakdown : null),
  });
  return { ...row, in_transit: transit.total };
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
      'SELECT * FROM net_worth_snapshots WHERE is_estimated = 0 ORDER BY date DESC LIMIT 1'
    ).get();

    res.json({
      data: snapshot ? dollarizeSnapshotRow(withInTransit(db, snapshot as Record<string, unknown>)) : null,
    });
  } catch (err) {
    next(err);
  }
});

// GET /current - net worth now, the figure Accounts and the advisor headline print
router.get('/current', (_req: Request, res: Response, next: NextFunction): void => {
  try {
    const now = netWorthNow(getDb());
    res.json({ data: { ...dollarizeFields(now, ['net_worth', 'assets', 'liabilities'] as const) } });
  } catch (err) {
    next(err);
  }
});

// GET /history?startDate&endDate&months
const TIMELINE_MONEY_FIELDS = ['net_worth', 'assets', 'liabilities', 'liquid', 'invested', 'crypto'] as const;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const STEPS: readonly TimelineStep[] = ['day', 'week', 'month'];

router.get('/timeline', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const { from, to, step, accounts } = req.query as Record<string, string | undefined>;
    if ((from && !ISO_DATE.test(from)) || (to && !ISO_DATE.test(to))) {
      res.status(400).json({ error: 'from and to must be yyyy-MM-dd' });
      return;
    }
    if (step && !STEPS.includes(step as TimelineStep)) {
      res.status(400).json({ error: `step must be one of ${STEPS.join(', ')}` });
      return;
    }
    const accountIds = accounts ? accounts.split(',').filter(Boolean) : undefined;
    const timeline = netWorthTimeline(getDb(), { from, to, step: step as TimelineStep | undefined, accountIds });
    res.json({
      data: {
        ...timeline,
        accounts: timeline.accounts.map((a) => ({ ...a, opening_balance: a.opening_balance === null ? null : toDollars(a.opening_balance) })),
        points: timeline.points.map((p) => ({
          ...dollarizeFields(p, TIMELINE_MONEY_FIELDS),
          by_account: Object.fromEntries(Object.entries(p.by_account).map(([id, cents]) => [id, toDollars(cents)])),
        })),
      },
    });
  } catch (err) {
    next(err);
  }
});

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
      // `subMonths` + local `format`, not `setMonth` + `toISOString`.
      //
      // `net_worth_snapshots.date` is a LOCAL 'yyyy-MM-dd' (`snapshot.ts` writes
      // `format(new Date(), 'yyyy-MM-dd')`), so a cutoff built in UTC compares two different
      // calendars. On this machine (America/New_York, UTC-4) `toISOString()` after 20:00 local
      // already reads tomorrow, so the oldest sheet in a 12-month window silently dropped out
      // every evening and came back every morning.
      //
      // `setMonth` also overflows rather than clamping: on 2026-08-31, `setMonth(getMonth() - 6)`
      // asks for 31 February and lands on 3 March, losing three days; on 2026-07-31 a one-month
      // window asks for 31 June and lands on 1 July, which is zero months of history.
      // `subMonths` clamps to the last valid day of the target month, which is what a
      // "months back" window means.
      conditions.push('date >= ?');
      params.push(format(subMonths(new Date(), months), 'yyyy-MM-dd'));
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

    conditions.push('is_estimated = 0');
    const where = `WHERE ${conditions.join(' AND ')}`;

    const snapshots = db.prepare(`
      SELECT * FROM net_worth_snapshots
      ${where}
      ORDER BY date ASC
    `).all(...params);

    res.json({
      data: snapshots.map((row) => dollarizeSnapshotRow(withInTransit(db, row as Record<string, unknown>))),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
