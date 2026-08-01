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

export interface AssetBuckets {
  liquid: number;
  investment: number;
  crypto: number;
  other: number;
  /** Net owed. Negative when the liabilities in the breakdown are collectively in credit. */
  liabilities: number;
}

const LIQUID_TYPES = new Set(['checking', 'savings', 'cash', 'closed']);
const INVESTMENT_TYPES = new Set(['brokerage', 'ira_traditional', 'ira_roth']);

/**
 * Asset-class buckets derived from a snapshot's per-account breakdown at READ time.
 *
 * `net_worth_snapshots.liquid_assets` / `investment_assets` / `crypto_assets` are computed when the
 * row is written, from `accounts.type` as it stood at that moment, and nothing ever recomputes them.
 * Account types are editable and are also auto-guessed on first sync, so correcting a type silently
 * rewrites what the historical series MEANS without changing a single stored number.
 *
 * On the live database both Fidelity accounts were first auto-typed `checking` and later retyped to
 * `brokerage` and `ira_roth`. The snapshots written on 2026-06-30 and 07-01 therefore still record
 * `investment_assets = 0` and `liquid_assets = 801953` for a portfolio that held $1,661.66, and the
 * Investments chart plots $2,441.93 -> $0.00 -> $0.00 -> $1,665.86: a portfolio that appears to
 * vanish for two days and come back.
 *
 * Deriving from the breakdown fixes the whole series at once and keeps fixing it, because the
 * breakdown records WHICH ACCOUNT held WHAT, which is a fact, while the bucket columns record an
 * interpretation of that fact which was frozen at write time.
 *
 * Accounts deleted since the snapshot was taken are counted in `other` rather than guessed at. The
 * previous behaviour of treating an unknown account as a non-liability asset is what made a removed
 * credit card read as money you had.
 *
 * IT HAS NO PRODUCTION CALLER RIGHT NOW. `/api/reports/investments` was the last one and resolves
 * its own portfolio set, because this INVESTMENT_TYPES bucketing puts `crypto_wallet` in a
 * separate bucket from the accounts that screen totals. Verified by
 * `grep -rn deriveAssetBuckets server client shared scripts tests` on 2026-07-31: the only hits
 * outside this file are two comments and `tests/creditPosition.test.ts`. So this is a definition
 * of "investment assets" that no surface reads, and nothing will fail if it drifts from the one
 * that is on screen. Re-home it or delete it; do not cite it as authoritative.
 */
export function deriveAssetBuckets(
  db: Database.Database,
  breakdownJson: string
): AssetBuckets {
  const buckets: AssetBuckets = { liquid: 0, investment: 0, crypto: 0, other: 0, liabilities: 0 };

  let breakdown: Record<string, unknown>;
  try {
    breakdown = JSON.parse(breakdownJson) as Record<string, unknown>;
  } catch {
    return buckets;
  }

  const accountRows = db.prepare('SELECT id, type, is_liability FROM accounts').all() as Array<{
    id: string;
    type: string;
    is_liability: number;
  }>;
  const accounts = new Map(accountRows.map((row) => [row.id, row]));

  for (const [accountId, rawValue] of Object.entries(breakdown)) {
    if (typeof rawValue !== 'number' || !Number.isFinite(rawValue)) continue;
    const account = accounts.get(accountId);
    if (!account) {
      buckets.other += rawValue;
      continue;
    }
    if (account.is_liability === 1) {
      // Signed. A card in credit is stored as a negative amount owed, and Math.abs() turned that
      // credit into debt of the same size, so the bucket overstated liabilities by twice the
      // credit and understated net worth by the same amount.
      buckets.liabilities += rawValue;
    } else if (LIQUID_TYPES.has(account.type)) {
      buckets.liquid += rawValue;
    } else if (INVESTMENT_TYPES.has(account.type)) {
      buckets.investment += rawValue;
    } else if (account.type === 'crypto_wallet') {
      buckets.crypto += rawValue;
    } else {
      buckets.other += rawValue;
    }
  }

  return buckets;
}

/** Render an estimate as an estimate wherever a snapshot is turned into text for the model. */
export function estimateNote(snapshot: { is_estimated: boolean }): string {
  return snapshot.is_estimated
    ? ' (estimated: reconstructed from later transactions, not a measured balance)'
    : '';
}
