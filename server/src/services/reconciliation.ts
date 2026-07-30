import type Database from 'better-sqlite3';
import { readSnapshots } from './netWorthHistory';

/**
 * Does the ledger explain the balance?
 *
 * Every other number in this app is downstream of one assumption nobody was checking: that the
 * transactions on an account account for how its balance moved. `personalFinanceInvariants.ts` runs
 * four checks and none of them touch that relationship, so a month with a gap in it looks exactly
 * like a month without one, and the app's silence reads as a claim of completeness.
 *
 * The check: between two MEASURED snapshots, an account's balance should have moved by the sum of
 * its transactions in that window. What is left over is unexplained.
 *
 * MEASURED ONLY, and this is the load-bearing detail. Estimated snapshots are produced by reverse-
 * replaying transactions off today's balances, so reconciling against one compares the ledger to a
 * number derived from the ledger. The residual would be zero by construction and the check would
 * report perfect health precisely where it has the least evidence.
 *
 * CUMULATIVE, not per-window, and this is the other one. Providers post on their own schedule: a
 * card charge made before a snapshot can land after it, so a single window's residual swings by the
 * size of whatever was in flight and then swings back. Judging health per window means an alarm on
 * every healthy account, which teaches the owner to ignore the alarm. The signal is the residual
 * that does NOT come back: a cumulative drift across the whole horizon.
 */

export interface AccountReconciliation {
  account_id: string;
  account_name: string | null;
  is_liability: boolean;
  /**
   * Whether the account's value is driven by the market rather than by its transactions.
   *
   * A brokerage or crypto wallet moves when prices move, and no transaction records that. Its
   * residual is therefore expected and is not evidence of a gap in the ledger. Flagging those
   * alongside a genuinely unexplained checking balance is how a useful check becomes an alarm
   * the owner learns to dismiss.
   */
  is_market_driven: boolean;
  /** Measured snapshots this account appears in, oldest to newest. */
  window_count: number;
  first_date: string | null;
  last_date: string | null;
  /** Observed balance movement across the full horizon, in cents, net-worth signed. */
  observed_delta: number;
  /** Movement the ledger explains, in cents, net-worth signed. */
  explained_delta: number;
  /** observed minus explained. Non-zero means the ledger does not fully account for the balance. */
  residual: number;
  /** The largest single-window residual, which is roughly the size of the posting lag. */
  largest_window_residual: number;
  /** Residual as a share of the transaction volume that moved through the account. */
  residual_ratio: number | null;
}

export interface ReconciliationReport {
  accounts: AccountReconciliation[];
  /** Accounts whose cumulative residual exceeds the tolerance below. */
  unreconciled: AccountReconciliation[];
  total_residual: number;
  measured_snapshot_count: number;
}

/**
 * A cumulative residual under this is treated as posting lag rather than a gap. Expressed as a
 * share of the volume that moved through the account, because a $50 drift means something very
 * different on a $200 wallet than on a card that turned over $40,000.
 */
export const RESIDUAL_TOLERANCE_RATIO = 0.02;

/** Below this, a residual is noise regardless of ratio: rounding, a stray fee, one pending row. */
export const RESIDUAL_TOLERANCE_CENTS = 500;

interface AccountRow {
  id: string;
  account_name: string | null;
  is_liability: number;
  type: string;
}

// Mirrors the set snapshot.ts uses for the same reason: reversing individual buys and sells off a
// market-driven balance cannot reconstruct a price move.
const MARKET_DRIVEN_TYPES = new Set(['brokerage', 'ira_traditional', 'ira_roth', 'crypto_wallet']);

export function reconcileAccounts(
  db: Database.Database,
  options: { since?: string } = {}
): ReconciliationReport {
  const snapshots = readSnapshots(db, { since: options.since, measuredOnly: true, order: 'asc' });
  const accounts = db.prepare(
    'SELECT id, account_name, is_liability, type FROM accounts WHERE is_hidden = 0'
  ).all() as AccountRow[];

  if (snapshots.length < 2) {
    return { accounts: [], unreconciled: [], total_residual: 0, measured_snapshot_count: snapshots.length };
  }

  const balancesByDate = snapshots.map((snapshot) => {
    let breakdown: Record<string, unknown>;
    try {
      breakdown = JSON.parse(snapshot.breakdown) as Record<string, unknown>;
    } catch {
      breakdown = {};
    }
    return { date: snapshot.date, breakdown };
  });

  const sumBetween = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total, COALESCE(SUM(ABS(amount)), 0) AS volume
    FROM transactions
    WHERE account_id = ? AND pending = 0 AND date > ? AND date <= ?
  `);

  const results: AccountReconciliation[] = [];

  for (const account of accounts) {
    const isLiability = account.is_liability === 1;
    const isMarketDriven = MARKET_DRIVEN_TYPES.has(account.type);
    let observedDelta = 0;
    let explainedDelta = 0;
    let volume = 0;
    let windows = 0;
    let largestWindowResidual = 0;
    let firstDate: string | null = null;
    let lastDate: string | null = null;

    for (let i = 1; i < balancesByDate.length; i += 1) {
      const previous = balancesByDate[i - 1];
      const current = balancesByDate[i];
      const previousBalance = previous.breakdown[account.id];
      const currentBalance = current.breakdown[account.id];

      // An account absent from either end of the window has no movement to reconcile there: it did
      // not exist yet, or the snapshot predates it. Skipping is not the same as reconciling to zero.
      if (typeof previousBalance !== 'number' || typeof currentBalance !== 'number') continue;

      const row = sumBetween.get(account.id, previous.date, current.date) as {
        total: number;
        volume: number;
      };

      // Both sides expressed as a movement in NET WORTH. A liability's balance is stored as a
      // positive amount owed and moves opposite the transaction sign: a $100 purchase (amount -100)
      // raises what is owed by 100 and lowers net worth by 100.
      const observed = isLiability ? -(currentBalance - previousBalance) : currentBalance - previousBalance;
      const explained = row.total;
      const windowResidual = observed - explained;

      observedDelta += observed;
      explainedDelta += explained;
      volume += row.volume;
      windows += 1;
      if (Math.abs(windowResidual) > Math.abs(largestWindowResidual)) {
        largestWindowResidual = windowResidual;
      }
      if (firstDate === null) firstDate = previous.date;
      lastDate = current.date;
    }

    if (windows === 0) continue;

    const residual = observedDelta - explainedDelta;
    results.push({
      account_id: account.id,
      account_name: account.account_name,
      is_liability: isLiability,
      is_market_driven: isMarketDriven,
      window_count: windows,
      first_date: firstDate,
      last_date: lastDate,
      observed_delta: observedDelta,
      explained_delta: explainedDelta,
      residual,
      largest_window_residual: largestWindowResidual,
      residual_ratio: volume > 0 ? residual / volume : null,
    });
  }

  results.sort((a, b) => Math.abs(b.residual) - Math.abs(a.residual));

  const unreconciled = results.filter((account) => {
    // A market-driven account's residual IS the market move. Reporting it as unexplained would
    // mean telling the owner their brokerage does not add up every time a price changes.
    if (account.is_market_driven) return false;
    if (Math.abs(account.residual) <= RESIDUAL_TOLERANCE_CENTS) return false;
    if (account.residual_ratio === null) return true;
    return Math.abs(account.residual_ratio) > RESIDUAL_TOLERANCE_RATIO;
  });

  return {
    accounts: results,
    unreconciled,
    total_residual: results.reduce((sum, account) => sum + account.residual, 0),
    measured_snapshot_count: snapshots.length,
  };
}
