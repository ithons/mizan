import type Database from 'better-sqlite3';
import { addDays, format, parseISO } from 'date-fns';
import type {
  AccountBalanceHistory,
  BalanceHistoryPoint,
  BalanceMeasurement,
  BalanceSeriesStart,
} from '../../../shared/types';

/**
 * An account's balance over time, derived from its own ledger.
 *
 * The previous series read the per-account `breakdown` out of `net_worth_snapshots`, so it described
 * when the app was running rather than when the money moved: every deposit and credit account got
 * exactly 19 points over 179 days, spaced 1 to 31 days apart, no matter how much ledger it had. It
 * also drew reconstructions as history: Wealthfront Cash read $1,517.30, then $0.00, then $1.70 on
 * consecutive points, an account-emptying event that never happened and that the account's own 12
 * transactions contradict.
 *
 * This walks `accounts.current_balance` backwards through `transactions` instead, one point per
 * calendar day. Values are NET-WORTH SIGNED, matching reconciliation.ts: an asset is its balance, a
 * liability is minus what it owes, and a card in credit is therefore positive. That signing is what
 * makes the walk uniform: in net-worth space the balance moves by the raw transaction amount for
 * both kinds of account, because a card purchase (amount -50) raises what is owed by 50 and lowers
 * net worth by 50.
 *
 * Every point is the ledger's. Measured snapshots are carried alongside as `measurements`, for the
 * chart to mark ON the line, and nothing here compares the two. Splicing a snapshot into the line
 * would draw a step the size of the disagreement and then step back, and judging the two against a
 * tolerance cannot work either: a snapshot is written at sync time, so it observed the balance at
 * some instant during that day, and no comparison built from day boundaries can contain a day's
 * intraday path. Four rounds of that produced findings on days where nothing was missing. Drawing
 * both leaves any real divergence visible without asserting a quantity nobody measured.
 */

interface AccountRow {
  id: string;
  current_balance: number;
  is_liability: number;
  backfill_floor_date: string | null;
}

export interface LedgerHistoryOptions {
  /** Clamp the series to start no earlier than this `yyyy-MM-dd`. */
  from?: string;
  /** Clamp the series to end no later than this `yyyy-MM-dd`. */
  to?: string;
  /** Injectable "today", so a test is not hostage to the clock. */
  today?: string;
}

function todayLocal(): string {
  return format(new Date(), 'yyyy-MM-dd');
}

function previousDay(date: string): string {
  return format(addDays(parseISO(date), -1), 'yyyy-MM-dd');
}

/** Net-worth signed: a liability's stored balance is what is OWED, which subtracts. */
function signed(cents: number, isLiability: boolean): number {
  if (!isLiability) return cents;
  // A paid-off card would otherwise carry -0 into the payload, where it prints as 0 but fails a
  // strict comparison against it.
  return cents === 0 ? 0 : -cents;
}

/** Daily net movement in cents, keyed by `yyyy-MM-dd`, pending rows excluded. */
function readDailyTotals(db: Database.Database, accountId: string, ceiling: string): Map<string, number> {
  // `pending = 0` matches reconciliation.ts, so the line and that screen are built off the same
  // rows. Transactions dated past `ceiling` are excluded rather than reversed out: they have not
  // reached `current_balance`, so subtracting them would walk the series away from the balance it
  // starts at.
  const rows = db.prepare(`
    SELECT date, SUM(amount) AS total
    FROM transactions
    WHERE account_id = ? AND pending = 0 AND date <= ?
    GROUP BY date
  `).all(accountId, ceiling) as Array<{ date: string; total: number }>;

  return new Map(rows.map((row) => [row.date, row.total]));
}

/**
 * Measured (never estimated) snapshot values for this account inside the drawn window, net-worth
 * signed. Restricted to the window because a mark the line does not reach cannot be drawn on it.
 */
function readMeasurements(
  db: Database.Database,
  accountId: string,
  isLiability: boolean,
  from: string,
  to: string
): BalanceMeasurement[] {
  const rows = db.prepare(`
    SELECT date, breakdown FROM net_worth_snapshots
    WHERE is_estimated = 0 AND date >= ? AND date <= ?
    ORDER BY date ASC
  `).all(from, to) as Array<{ date: string; breakdown: string }>;

  const measurements: BalanceMeasurement[] = [];
  for (const row of rows) {
    let breakdown: Record<string, unknown>;
    try {
      breakdown = JSON.parse(row.breakdown) as Record<string, unknown>;
    } catch {
      // A breakdown that will not parse is not a measurement of anything. Skipping it drops a mark;
      // treating it as zero would invent a balance the snapshot never recorded.
      continue;
    }
    const cents = breakdown[accountId];
    if (typeof cents === 'number' && Number.isFinite(cents)) {
      measurements.push({ date: row.date, balance: signed(cents, isLiability) });
    }
  }
  return measurements;
}

interface SeriesStart {
  date: string | null;
  reason: BalanceSeriesStart;
}

/**
 * Where the ledger can honestly begin.
 *
 * `backfill_floor_date` (migration 030) is the line above which the provider owns the history and
 * below which only a manual import can supply it. Imported history is real history, so the floor
 * does not truncate it.
 *
 * What the floor does bind is a PROVIDER row below it, which is the state migration 030 exists to
 * prevent: a feed that reaches below its own floor served part of a period it does not cover, and a
 * walk through it would describe a stretch of time the provider never fully reported.
 *
 * THE FIGURE THAT USED TO BE HERE WAS WRONG BY THE TIME ANYONE READ IT AGAIN. It said "every one
 * of the 2,196 rows below a floor in the live database is `source_type = 'import'`", under a
 * "2026-04-27 floor" on BofA Cash Rewards. Re-derived 2026-09-01 against the live database:
 *
 *   SELECT t.source_type, COUNT(*) FROM transactions t JOIN accounts a ON a.id = t.account_id
 *    WHERE a.backfill_floor_date IS NOT NULL AND t.date < a.backfill_floor_date GROUP BY 1;
 *     -> import 2195, simplefin 384
 *   SELECT account_name, backfill_floor_date FROM accounts WHERE backfill_floor_date IS NOT NULL;
 *     -> all nine SimpleFIN accounts read 2026-07-31; Coinbase reads 2025-09-04
 *
 * So 384 provider rows now sit below their own floor, which is exactly the state described above
 * as the one migration 030 exists to prevent. The floors were rewritten out of band: the only
 * writer of this column anywhere in the tree is `scripts/backfill/floor-map.ts`, which is not in
 * any tsconfig and leaves no record of having run. Nothing in the app can distinguish a floor the
 * owner meant from one a script set, which is the real defect here and is not fixed by editing a
 * comment. The data is left alone deliberately: rewriting a floor to make the sentence true again
 * would be repairing the database instead of the write path, and the intended values are the
 * owner's to state.
 */
function resolveStart(
  db: Database.Database,
  account: AccountRow,
  firstTransaction: string | null,
  requestedFrom: string | undefined
): SeriesStart {
  if (firstTransaction === null) return { date: null, reason: 'no_ledger' };

  const floor = account.backfill_floor_date;
  const importedBelowFloor = floor
    ? (db.prepare(`
        SELECT 1 FROM transactions
        WHERE account_id = ? AND pending = 0 AND date < ? AND source_type = 'import'
        LIMIT 1
      `).get(account.id, floor) as unknown) !== undefined
    : false;

  let date = firstTransaction;
  let reason: BalanceSeriesStart = 'first_transaction';
  if (floor && !importedBelowFloor && floor > date) {
    date = floor;
    reason = 'backfill_floor';
  }
  if (requestedFrom && requestedFrom > date) {
    date = requestedFrom;
    reason = 'requested_window';
  }
  return { date, reason };
}

export function getLedgerBalanceHistory(
  db: Database.Database,
  accountId: string,
  options: LedgerHistoryOptions = {}
): AccountBalanceHistory {
  const empty = (reason: BalanceSeriesStart): AccountBalanceHistory => ({
    basis: 'ledger',
    points: [],
    start_date: null,
    start_reason: reason,
    measurements: [],
    drawn_transaction_count: 0,
  });

  const account = db.prepare(
    'SELECT id, current_balance, is_liability, backfill_floor_date FROM accounts WHERE id = ?'
  ).get(accountId) as AccountRow | undefined;
  if (!account) return empty('account_not_found');

  const today = options.today ?? todayLocal();
  const end = options.to && options.to < today ? options.to : today;

  const firstDate = (db.prepare(`
    SELECT MIN(date) AS first_date
    FROM transactions
    WHERE account_id = ? AND pending = 0 AND date <= ?
  `).get(accountId, today) as { first_date: string | null }).first_date;

  const start = resolveStart(db, account, firstDate, options.from);
  const startDate = start.date;
  if (startDate === null || startDate > end) return empty(start.reason);

  const isLiability = account.is_liability === 1;
  // Counted over the window the series actually draws, and named `drawn_` for it. The two are equal
  // whenever the window is the whole ledger, which is every request the app makes today, and that
  // coincidence is exactly what made "this account's N transactions" readable as a lifetime total. A
  // `to` earlier than today, or a `from` later than the first row, moves this number without moving
  // `start_reason`, so the field name is what stops a caption inheriting the wrong noun.
  const drawnCount = (db.prepare(`
    SELECT COUNT(*) AS n FROM transactions
    WHERE account_id = ? AND pending = 0 AND date >= ? AND date <= ?
  `).get(accountId, startDate, end) as { n: number }).n;
  const totals = readDailyTotals(db, accountId, today);

  // `current_balance` is today's balance, so the walk rewinds through anything dated after the
  // window before it starts emitting points.
  let closing = signed(account.current_balance, isLiability);
  for (const [date, total] of totals) {
    if (date > end) closing -= total;
  }

  const points: BalanceHistoryPoint[] = [];
  for (let date = end; date >= startDate; date = previousDay(date)) {
    points.push({ date, balance: closing, source: 'ledger' });
    closing -= totals.get(date) ?? 0;
  }
  points.reverse();

  return {
    basis: 'ledger',
    points,
    start_date: startDate,
    start_reason: start.reason,
    measurements: readMeasurements(db, accountId, isLiability, startDate, end),
    drawn_transaction_count: drawnCount,
  };
}

/**
 * The snapshot-derived series, for accounts whose balance is not a function of their ledger.
 *
 * A brokerage or crypto wallet moves when prices move and no transaction records it, so reversing
 * individual buys and sells off today's balance cannot reconstruct the balance it had. That is the
 * same reason snapshot.ts and reconciliation.ts both carry this set. Estimated snapshots stay marked
 * as estimated: they are reverse-replay reconstructions, not balances anyone observed.
 */
export const MARKET_DRIVEN_TYPES = new Set(['brokerage', 'ira_traditional', 'ira_roth', 'crypto_wallet']);

export function getSnapshotBalanceHistory(
  db: Database.Database,
  accountId: string
): AccountBalanceHistory {
  // Signed like the ledger series, so `balance` means one thing across both bases. No market-driven
  // type is a liability today; a series that silently changed sign with its basis would be a trap
  // for whoever makes one.
  const account = db.prepare('SELECT is_liability FROM accounts WHERE id = ?').get(accountId) as
    | { is_liability: number }
    | undefined;
  const isLiability = account?.is_liability === 1;

  const rows = db.prepare(
    'SELECT date, breakdown, is_estimated FROM net_worth_snapshots ORDER BY date ASC'
  ).all() as Array<{ date: string; breakdown: string; is_estimated: number }>;

  const points: BalanceHistoryPoint[] = [];
  for (const row of rows) {
    let breakdown: Record<string, unknown>;
    try {
      breakdown = JSON.parse(row.breakdown) as Record<string, unknown>;
    } catch {
      continue;
    }
    const cents = breakdown[accountId];
    if (typeof cents === 'number' && Number.isFinite(cents)) {
      points.push({
        date: row.date,
        balance: signed(cents, isLiability),
        source: row.is_estimated === 1 ? 'estimated' : 'measured',
      });
    }
  }

  return {
    basis: 'snapshot',
    points,
    start_date: points.length > 0 ? points[0].date : null,
    start_reason: points.length > 0 ? 'snapshot_series' : 'no_ledger',
    // The measurements ARE the line here, so marking them again would draw a dot on every point.
    measurements: [],
    // Zero because no transaction built this line, not because the account has none.
    drawn_transaction_count: 0,
  };
}
