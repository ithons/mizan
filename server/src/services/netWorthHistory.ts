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

/*
 * `deriveAssetBuckets` stood here and was deleted 2026-08-01, with its `AssetBuckets` type,
 * LIQUID_TYPES and INVESTMENT_TYPES.
 *
 * It bucketed a snapshot's per-account breakdown into liquid / investment / crypto / other /
 * liabilities at READ time, and its argument was sound: `liquid_assets` and `investment_assets` are
 * frozen at write time from `accounts.type` as it stood then, so retyping an account silently
 * changes what the stored series means. That argument is not lost. It is what the block below,
 * migration 056 and `parseSnapshotPortfolio` are for, and they answer it by recording the set at
 * write time and labelling a reconstruction as reconstructed, rather than by re-deriving at read
 * time from an accounts table that postdates the row.
 *
 * It had no production caller. `/api/reports/investments` was the last one and left, because this
 * function's INVESTMENT_TYPES bucketed `crypto_wallet` separately while the Investments screen
 * totals it with the rest of the portfolio, so the two definitions of "investment assets" disagreed
 * by exactly the Coinbase wallet. Re-confirmed before deleting, on 2026-08-01:
 *   grep -rn deriveAssetBuckets server client shared scripts tests
 * returned this file, `tests/creditPosition.test.ts`, and two comments in `routes/reports.ts` and
 * `tests/investmentsPortfolio.test.ts` that record the defect in the past tense. No surface read it.
 *
 * A shared definition backing no surface is worse than no definition: nothing fails when it drifts,
 * and a later change cites it as authoritative because it is the only one written down. The single
 * assertion resting on it, that a card in credit carries as a NEGATIVE liability and not as debt of
 * the same size, moved onto `takeSnapshot` in tests/creditPosition.test.ts, which is the live path
 * that writes `total_liabilities` and the breakdown those buckets were derived from.
 */

/* ── What the portfolio was, and when that was decided ─────────────────────── */

/**
 * Accounts the Investments screen is about: anything holding a position now, or typed as one.
 *
 * One definition, imported by the writer (`services/snapshot.ts`, which freezes it onto each row)
 * and by the reader (`routes/reports.ts`, which resolves today's set for the headline). Migration
 * 056 pins the same list in SQL, deliberately, because a migration must reproduce on a clone in a
 * year regardless of where this constant has moved to by then.
 */
export const PORTFOLIO_ACCOUNT_TYPES = ['brokerage', 'ira_traditional', 'ira_roth', 'crypto_wallet'];

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
 * The `EXISTS holdings` arm is why a type edit alone is not the reproduction of the freezing bug it
 * looks like: on the live ledger all three portfolio accounts hold positions, so retyping Fidelity
 * Individual to `savings` leaves it in the set and moves nothing. What moves history is an edit that
 * changes the set: retyping an account INTO a portfolio type, hiding one, or deleting one.
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

/**
 * Whether a point's account set was written with it, or worked out afterwards.
 *
 * `recorded` means the code that wrote the row's balances wrote the set in the same statement.
 * `reconstructed` means it was derived later from an accounts table that postdates the row, which
 * is what migration 056 did to every row that already existed, and what this module does at read
 * time for a row carrying no set at all. A reconstruction is not a measurement, and this is the
 * only thing that can tell the two apart afterwards.
 */
export type PortfolioMembershipSource = 'recorded' | 'reconstructed';

export interface SnapshotPortfolioMembership {
  accountIds: Set<string>;
  source: PortfolioMembershipSource;
}

export interface SnapshotPortfolioColumns {
  portfolio_accounts: string | null;
  portfolio_accounts_source: string | null;
}

/**
 * The account set a stored snapshot was made of, falling back to today's portfolio when it has none.
 *
 * The fallback is the pre-056 behaviour and is labelled as what it is rather than hidden: a row with
 * no stored set is one nothing recorded a set for, and today's accounts table is the only evidence
 * left. It is reachable for a row written before 056 whose breakdown was unreadable, and for a row a
 * future writer inserts without filling the column in. `tests/investmentHistoryMembership.test.ts`
 * asserts neither writer in this repo does the latter, so the fallback is a floor, not a path.
 *
 * An unrecognised `portfolio_accounts_source` reads as `reconstructed`, never as `recorded`: an
 * unknown provenance must not be upgraded into a claim that the row was written with its own set.
 */
export function parseSnapshotPortfolio(
  row: SnapshotPortfolioColumns,
  fallback: Set<string>
): SnapshotPortfolioMembership {
  if (row.portfolio_accounts === null) return { accountIds: fallback, source: 'reconstructed' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.portfolio_accounts);
  } catch {
    return { accountIds: fallback, source: 'reconstructed' };
  }
  if (!Array.isArray(parsed)) return { accountIds: fallback, source: 'reconstructed' };

  const accountIds = new Set(parsed.filter((id): id is string => typeof id === 'string'));
  return {
    accountIds,
    source: row.portfolio_accounts_source === 'recorded' ? 'recorded' : 'reconstructed',
  };
}

/** Render an estimate as an estimate wherever a snapshot is turned into text for the model. */
export function estimateNote(snapshot: { is_estimated: boolean }): string {
  return snapshot.is_estimated
    ? ' (estimated: reconstructed from later transactions, not a measured balance)'
    : '';
}
