import type Database from 'better-sqlite3';

/**
 * The one place net-worth snapshots are read.
 *
 * `is_estimated` distinguishes a measured balance sheet from one reconstructed by reverse-replaying
 * transactions off today's balances. That distinction is the difference between a fact and an
 * arithmetic guess, and the app had no mechanism for carrying it: it had a column that survived by
 * accident. `routes/networth.ts` happened to `SELECT *`, so Reports and Accounts got the flag; every
 * reader that wrote an explicit column list silently dropped it, which was four of the five
 * consumers, including both AI paths.
 *
 * What that cost, on the live database: five of nineteen snapshots are estimates. The advisor's
 * "Net Worth Trend" listed them beside measured rows with nothing to tell them apart, so asked how
 * net worth had moved the model asserted a +$5,549 April recovery and a $2,800 June collapse as
 * observed history. Both are artifacts of `backfillSnapshots` clamping an unpaid liability at zero.
 * The system prompt instructs the model to say plainly when data is only estimated; it was never
 * given the flag it was being asked to use.
 *
 * `is_estimated` is non-optional and already a boolean on the row type, so a consumer cannot drop it
 * by forgetting a column, and cannot render `0` as truthy by forgetting a cast.
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
  is_estimated: boolean;
  created_at: string;
}

const COLUMNS = `
  id, date, total_assets, total_liabilities, net_worth,
  liquid_assets, investment_assets, crypto_assets,
  breakdown, is_estimated, created_at
`;

interface RawRow extends Omit<NetWorthSnapshotRow, 'is_estimated'> {
  is_estimated: number;
}

function hydrate(row: RawRow): NetWorthSnapshotRow {
  return { ...row, is_estimated: row.is_estimated === 1 };
}

export interface ReadSnapshotsOptions {
  /** Inclusive lower bound, `yyyy-MM-dd`. */
  since?: string;
  /** Inclusive upper bound, `yyyy-MM-dd`. */
  until?: string;
  /** Drop reconstructed rows. Use where a comparison must be measured-to-measured. */
  measuredOnly?: boolean;
  order?: 'asc' | 'desc';
  limit?: number;
}

export function readSnapshots(
  db: Database.Database,
  options: ReadSnapshotsOptions = {}
): NetWorthSnapshotRow[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options.since) {
    conditions.push('date >= ?');
    params.push(options.since);
  }
  if (options.until) {
    conditions.push('date <= ?');
    params.push(options.until);
  }
  if (options.measuredOnly) {
    conditions.push('is_estimated = 0');
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const order = options.order === 'desc' ? 'DESC' : 'ASC';
  const limit = options.limit ? `LIMIT ${Math.max(1, Math.floor(options.limit))}` : '';

  const rows = db.prepare(`
    SELECT ${COLUMNS}
    FROM net_worth_snapshots
    ${where}
    ORDER BY date ${order}
    ${limit}
  `).all(...params) as RawRow[];

  return rows.map(hydrate);
}

export function readLatestSnapshot(db: Database.Database): NetWorthSnapshotRow | null {
  return readSnapshots(db, { order: 'desc', limit: 1 })[0] ?? null;
}

/**
 * The newest snapshot strictly before `date`.
 *
 * `measuredOnly` matters here: a "versus last month" delta computed against a reconstruction is a
 * comparison between a fact and a guess, presented as a fact.
 */
export function readSnapshotBefore(
  db: Database.Database,
  date: string,
  options: { measuredOnly?: boolean } = {}
): NetWorthSnapshotRow | null {
  const measured = options.measuredOnly ? 'AND is_estimated = 0' : '';
  const row = db.prepare(`
    SELECT ${COLUMNS}
    FROM net_worth_snapshots
    WHERE date < ? ${measured}
    ORDER BY date DESC
    LIMIT 1
  `).get(date) as RawRow | undefined;
  return row ? hydrate(row) : null;
}

/** Render an estimate as an estimate wherever a snapshot is turned into text for the model. */
export function estimateNote(snapshot: { is_estimated: boolean }): string {
  return snapshot.is_estimated
    ? ' (estimated: reconstructed from later transactions, not a measured balance)'
    : '';
}
