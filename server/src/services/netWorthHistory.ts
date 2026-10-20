import type Database from 'better-sqlite3';
import { MARKET_DRIVEN_TYPES } from '../../../shared/accountTypes';

/**
 * The one place measured balance sheets are read. Rows marked `is_estimated` were written by a
 * monthly reconstruction that no longer exists; the net worth timeline replaced it, and no reader
 * here returns one.
 */
export interface NetWorthSnapshotRow {
  id: string;
  date: string;
  total_assets: number;
  total_liabilities: number;
  net_worth: number;
  liquid_assets: number | null;
  investment_assets: number | null;
  crypto_assets: number | null;
  breakdown: string;
  created_at: string;
  taken_at: string | null;
}

const COLUMNS = `
  id, date, total_assets, total_liabilities, net_worth,
  liquid_assets, investment_assets, crypto_assets,
  breakdown, created_at, taken_at
`;

export interface ReadSnapshotsOptions {
  /** Inclusive lower bound, `yyyy-MM-dd`. */
  since?: string;
  /** Inclusive upper bound, `yyyy-MM-dd`. */
  until?: string;
  /** Drop reconstructed rows. Use where a comparison must be measured-to-measured. */
  order?: 'asc' | 'desc';
  limit?: number;
}

export function readSnapshots(
  db: Database.Database,
  options: ReadSnapshotsOptions = {}
): NetWorthSnapshotRow[] {
  const conditions: string[] = ['is_estimated = 0'];
  const params: unknown[] = [];

  if (options.since) {
    conditions.push('date >= ?');
    params.push(options.since);
  }
  if (options.until) {
    conditions.push('date <= ?');
    params.push(options.until);
  }
  const where = `WHERE ${conditions.join(' AND ')}`;
  const order = options.order === 'desc' ? 'DESC' : 'ASC';
  const limit = options.limit ? `LIMIT ${Math.max(1, Math.floor(options.limit))}` : '';

  const rows = db.prepare(`
    SELECT ${COLUMNS}
    FROM net_worth_snapshots
    ${where}
    ORDER BY date ${order}
    ${limit}
  `).all(...params) as NetWorthSnapshotRow[];

  return rows;
}

export function readLatestSnapshot(db: Database.Database): NetWorthSnapshotRow | null {
  return readSnapshots(db, { order: 'desc', limit: 1 })[0] ?? null;
}

/** The newest measured sheet strictly before `date`. */
export function readSnapshotBefore(db: Database.Database, date: string): NetWorthSnapshotRow | null {
  const row = db.prepare(`
    SELECT ${COLUMNS}
    FROM net_worth_snapshots
    WHERE date < ? AND is_estimated = 0
    ORDER BY date DESC
    LIMIT 1
  `).get(date) as NetWorthSnapshotRow | undefined;
  return row ?? null;
}

/**
 * Accounts the Investments screen is about: anything holding a position now, or typed as one.
 *
 * Migration 056 pins the same list in SQL, deliberately, because a migration must reproduce on a
 * clone in a year regardless of where this constant has moved to by then.
 */
export const PORTFOLIO_ACCOUNT_TYPES: readonly string[] = [...MARKET_DRIVEN_TYPES];

export interface PortfolioAccountRow {
  id: string;
  type: string;
  current_balance: number;
  /** 1 when the account carries at least one position right now. */
  holds_position: number;
}

/**
 * The portfolio as it stands right now, in id order.
 *
 * `is_hidden = 0` is not decoration: it is the predicate `takeSnapshot` writes a breakdown entry
 * under, so an account outside it can never appear in a future point of the series. Without it,
 * disconnecting Coinbase (routes/coinbase.ts sets `is_hidden = 1` and leaves `current_balance`)
 * left $391.17 in the headline, out of the series, and standing in the delta as movement every day.
 *
 */
export function readPortfolioAccounts(db: Database.Database): PortfolioAccountRow[] {
  return db.prepare(`
    SELECT
      a.id,
      a.type,
      a.current_balance,
      EXISTS (SELECT 1 FROM holdings h WHERE h.account_id = a.id) AS holds_position
    FROM accounts a
    WHERE a.is_liability = 0
      AND a.is_hidden = 0
      AND (a.type IN (${PORTFOLIO_ACCOUNT_TYPES.map(() => '?').join(', ')})
           OR EXISTS (SELECT 1 FROM holdings h2 WHERE h2.account_id = a.id))
    ORDER BY a.id
  `).all(...PORTFOLIO_ACCOUNT_TYPES) as PortfolioAccountRow[];
}
