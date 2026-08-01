import { v4 as uuidv4 } from 'uuid';
import { format, subMonths, startOfMonth, differenceInCalendarMonths } from 'date-fns';
import type Database from 'better-sqlite3';
import { getDb } from '../db/index';
import { getPreference, setPreference } from './preferences';
import { readPortfolioAccounts } from './netWorthHistory';

// Upper bound on reverse-replay estimation: a 50-year backstop so a stray ancient
// transaction can't spin the loop for an absurd number of months. There is deliberately no
// MINIMUM. There used to be one (12 months, "keep the chart at least a year even with little
// data"), and it manufactured exactly the kind of number this app should never show: see
// accountFloorMonths and monthIsInformative below.
const MAX_BACKFILL_MONTHS = 600;

/**
 * The earliest month reverse-replay can say anything real about, one floor per account.
 *
 * Estimation works by taking today's balance and undoing every transaction since. That only
 * carries information for as far back as the ledger actually reaches. Past that point the
 * arithmetic still runs and still produces a number, but the number is just today's balance
 * again: not an estimate of the past, an assertion that nothing ever changed.
 *
 * On real data that produced 20 consecutive months with byte-identical breakdowns, drawn on
 * the same chart line as measured snapshots with nothing to distinguish them.
 *
 * This used to collapse into ONE floor for the whole portfolio, the LATEST of these dates, and
 * `backfillSnapshots` ended the backward walk there. A single recently-opened account therefore
 * erased every other account's history: Chase Freedom Flex opened 2026-03-10 holding $283.81 and
 * capped a 35-month ledger at five estimated months, discarding almost all of the 2,198
 * transactions imported specifically to have long history. A floor is a claim about ONE account's
 * history, so it belongs to that account. A month below an account's own floor now leaves that
 * account out instead of ending the walk for everyone.
 *
 * An account is exempt and gets no floor at all when it has no transactions (a manual cash
 * account, say): its balance is static as far as the ledger knows, so carrying it back adds no
 * false movement. An account sitting at zero today is exempt too, since there is no value to
 * reconstruct. Everything else has to have history reaching back to a month, or it is omitted
 * from that month and the month records the omission in `covered_accounts`.
 */
export function accountFloorMonths(
  accounts: Array<{ id: string; current_balance: number }>,
  firstTransactionByAccount: Map<string, string>
): Map<string, string> {
  const floors = new Map<string, string>();

  for (const account of accounts) {
    if (account.current_balance === 0) continue;
    const firstSeen = firstTransactionByAccount.get(account.id);
    if (!firstSeen) continue;
    floors.set(account.id, format(startOfMonth(new Date(`${firstSeen}T00:00:00`)), 'yyyy-MM-dd'));
  }

  return floors;
}

/**
 * The oldest month any single account can speak to, which is where the backward walk stops.
 *
 * Null means nothing holding value today has any ledger history, so every month would be a copy
 * of today's balances wearing a past date and the honest output is no rows at all.
 */
export function earliestCoveredMonth(floors: Map<string, string>): string | null {
  let earliest: string | null = null;
  for (const month of floors.values()) {
    if (!earliest || month < earliest) earliest = month;
  }
  return earliest;
}

/**
 * Whether a reconstructed month is worth emitting at all.
 *
 * Coverage says which accounts a month can include. It does not say whether including them taught
 * anyone anything, and that gap reintroduced the failure the floor was built to end. On the live
 * ledger, per-account floors reached back to 2023-09 and then drew ten consecutive months at
 * exactly $380.00: the covered set there is a manual cash account with no transactions (static by
 * definition), three closed accounts at $0, and a credit card whose 1,671 purchases sum to
 * -$31,156.60 against a $5.82 balance today, so reverse-replay drives "owed" far negative and the
 * clamp pins it at zero every single month. Five accounts covered, one number, none of it
 * observed. A flat line is a claim, and 5-of-14 coverage in a column does not stop a reader
 * believing it.
 *
 * A month earns a point when at least one account it covers actually moved the reconstruction:
 *
 *   - the account is in the covered set, so its own ledger reaches the month;
 *   - the ledger records activity dated inside that month, which is precisely what separates this
 *     month's estimate from the following month's, since the walk differs by those rows alone;
 *   - the account is not sitting on the clamp, because a clamped balance is the arithmetic
 *     refusing to answer, not an answer.
 *
 * A static exempt account can never satisfy this: it has no transactions to date inside any month.
 * That is the correct outcome. Carrying it flat is a reasonable way to include a balance in a month
 * that other evidence justifies, and no justification at all for a month of its own.
 */
function monthIsInformative(
  activeAccountIds: Set<string> | undefined,
  coveredBalances: Record<string, number>,
  clampedAccountIds: Set<string>
): boolean {
  if (!activeAccountIds) return false;
  for (const accountId of activeAccountIds) {
    if (coveredBalances[accountId] === undefined) continue;
    if (clampedAccountIds.has(accountId)) continue;
    return true;
  }
  return false;
}

/**
 * Remove estimated snapshots that today's data would refuse to create.
 *
 * The floor moves, because it is a function of today's balances: paying a card to zero makes that
 * card exempt and drops the floor, opening an account or spending on a dormant one raises it.
 * Estimated months were only ever written when absent and never re-examined, so a row written
 * under an older floor survived forever. Migration 040 deleted exactly this class of row by hand
 * and `scripts/backfill/rebuild.ts` recreated five of them two days later, including one at
 * 2026-02-01 that the very code which wrote it would have refused to write the following day. A
 * repair that is not also a guard decays, so the invariant runs on every backfill instead of
 * living in another one-off migration.
 *
 * This handles months the walk never visits. A month inside the walk that no longer earns a point
 * is cleared where that is decided, in the loop.
 *
 * Only `is_estimated = 1` rows are eligible. A measured snapshot records real balances at a point
 * in time and is never deleted or rewritten here.
 *
 * The second clause covers a row the walk can never revisit. Every month the walk visits is
 * `startOfMonth(...)`, so an estimated row dated anywhere but the first of a month is one this
 * function can neither refresh nor delete in the loop below, and it keeps whatever it was written
 * with forever, including the NULL coverage every estimated row carried before migration 044.
 */
function purgeUnjustifiedEstimates(db: Database.Database, earliestMonth: string | null): number {
  if (!earliestMonth) {
    return db.prepare('DELETE FROM net_worth_snapshots WHERE is_estimated = 1').run().changes;
  }
  return db
    .prepare(
      `DELETE FROM net_worth_snapshots
       WHERE is_estimated = 1 AND (date < ? OR substr(date, 9, 2) != '01')`
    )
    .run(earliestMonth).changes;
}

/**
 * The portfolio's membership, frozen as JSON, for a row about to be written.
 *
 * `readPortfolioAccounts` filters on `is_liability = 0 AND is_hidden = 0`, which is a subset of the
 * `is_hidden = 0` a breakdown is written under, so every id here has a value on the row beside it.
 * `coveredIds` narrows that to the accounts a reconstructed month could actually account for.
 *
 * Sorted so two rows written from the same set are byte-identical, which is what makes "did the set
 * change between these two points" a comparison rather than a parse.
 */
function frozenPortfolio(portfolioIds: string[], coveredIds?: Set<string>): string {
  const ids = portfolioIds
    .filter((id) => coveredIds === undefined || coveredIds.has(id))
    .slice()
    .sort();
  return JSON.stringify(ids);
}

export function takeSnapshot(): void {
  const db = getDb();

  const accounts = db.prepare(`
    SELECT id, current_balance, is_liability, type
    FROM accounts
    WHERE is_hidden = 0
  `).all() as Array<{ id: string; current_balance: number; is_liability: number; type: string }>;

  let total_assets = 0;
  let total_liabilities = 0;
  let liquid_assets = 0;
  let investment_assets = 0;
  let crypto_assets = 0;
  const breakdown: Record<string, number> = {};

  // 'closed' accounts are former deposit accounts (checking/savings) kept for net-worth history;
  // they're $0 today so this bucketing is a no-op live, but keeps them liquid in the breakdown.
  const liquidTypes = new Set(['checking', 'savings', 'cash', 'closed']);
  const investmentTypes = new Set(['brokerage', 'ira_traditional', 'ira_roth']);

  for (const account of accounts) {
    breakdown[account.id] = account.current_balance;
    if (account.is_liability) {
      total_liabilities += account.current_balance;
    } else {
      total_assets += account.current_balance;
      if (liquidTypes.has(account.type)) {
        liquid_assets += account.current_balance;
      } else if (investmentTypes.has(account.type)) {
        investment_assets += account.current_balance;
      } else if (account.type === 'crypto_wallet') {
        crypto_assets += account.current_balance;
      }
    }
  }

  const net_worth = total_assets - total_liabilities;
  const today = format(new Date(), 'yyyy-MM-dd');
  const now = new Date().toISOString();

  const existing = db.prepare(
    'SELECT id FROM net_worth_snapshots WHERE date = ?'
  ).get(today) as { id: string } | undefined;

  // A measurement covers every account it lists, by construction: it observed all of them. The
  // columns are still written so the series carries one meaning end to end and a consumer never
  // has to read NULL as "probably complete".
  const coveredAccounts = accounts.length;

  // Which of those accounts were the portfolio, decided here rather than by whoever reads the row
  // later. `/api/reports/investments` used to intersect every historical breakdown with today's
  // accounts table, so retyping an account into a portfolio type moved every past point: on a copy
  // of the live ledger taken 2026-08-01, retyping Wealthfront Cash to `brokerage` moved 2026-07-30
  // from $2,445.89 to $3,447.59 without touching a snapshot. This is 'recorded' in the strict sense
  // that the code writing the balances wrote the set alongside them, in the same statement.
  const portfolioAccounts = frozenPortfolio(readPortfolioAccounts(db).map((a) => a.id));

  if (existing) {
    db.prepare(`
      UPDATE net_worth_snapshots
      SET total_assets = ?, total_liabilities = ?, net_worth = ?, breakdown = ?,
          liquid_assets = ?, investment_assets = ?, crypto_assets = ?,
          covered_accounts = ?, total_accounts = ?,
          portfolio_accounts = ?, portfolio_accounts_source = 'recorded'
      WHERE id = ?
    `).run(total_assets, total_liabilities, net_worth, JSON.stringify(breakdown),
           liquid_assets, investment_assets, crypto_assets,
           coveredAccounts, coveredAccounts, portfolioAccounts, existing.id);
  } else {
    db.prepare(`
      INSERT INTO net_worth_snapshots
        (id, date, total_assets, total_liabilities, net_worth, breakdown, is_estimated,
         liquid_assets, investment_assets, crypto_assets, covered_accounts, total_accounts,
         created_at, portfolio_accounts, portfolio_accounts_source)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, 'recorded')
    `).run(uuidv4(), today, total_assets, total_liabilities, net_worth, JSON.stringify(breakdown),
           liquid_assets, investment_assets, crypto_assets, coveredAccounts, coveredAccounts, now,
           portfolioAccounts);
  }

  takeHoldingsSnapshot(db, today, now);
}

// Mirrors net_worth_snapshots' one-row-per-day pattern above, at the individual holding
// level, so a position's value over time can be charted (holdings itself is overwritten
// on every sync and only ever reflects the current state).
export function takeHoldingsSnapshot(db: Database.Database, today: string, now: string): void {
  const holdings = db.prepare(`
    SELECT account_id, security_id, quantity, institution_price, institution_value, cost_basis
    FROM holdings
  `).all() as Array<{
    account_id: string; security_id: string; quantity: number;
    institution_price: number; institution_value: number; cost_basis: number | null;
  }>;

  const upsert = db.prepare(`
    INSERT INTO holdings_history
      (id, account_id, security_id, date, quantity, institution_price, institution_value, cost_basis, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, security_id, date) DO UPDATE SET
      quantity = excluded.quantity,
      institution_price = excluded.institution_price,
      institution_value = excluded.institution_value,
      cost_basis = excluded.cost_basis
  `);

  for (const h of holdings) {
    upsert.run(uuidv4(), h.account_id, h.security_id, today, h.quantity, h.institution_price, h.institution_value, h.cost_basis, now);
  }
}

/* ── Making the reconstruction reachable ───────────────────────────────────── */

export type ReconstructionTrigger =
  | 'no_ledger'
  | 'floor_raised'
  | 'unreachable_estimates'
  | 'never_reconstructed'
  | 'ledger_window_moved'
  | 'balances_moved';

/**
 * What the last reconstruction was computed against.
 *
 * Persisted because every state derivable from the rows themselves flaps. "The ledger reaches
 * below the oldest snapshot" looks like the natural condition and is permanently true on the real
 * database: after a full rebuild the oldest reconstructed month is 2024-07-01 while the ledger
 * starts 2023-09-16, because the months between are covered and uninformative and the walk
 * correctly declines to emit them. Keyed on that, the reconstruction re-runs every hour forever,
 * which is the churn this design exists to avoid. A watermark is the only thing that can tell
 * "declined to emit" from "never looked".
 *
 * `app_preferences` is the existing key/value store; `services/rules.ts` already keeps machine
 * bookkeeping there, so this needs no migration.
 */
const RECONSTRUCTION_MARK_KEY = 'net_worth_reconstruction_mark';

export interface ReconstructionMark {
  derivedAt: string;
  /** The oldest month that run was able to consider. */
  reconstructableFrom: string | null;
  /** The newest `accounts.updated_at` that run started from. */
  balancesAt: string | null;
}

function readMark(db: Database.Database): ReconstructionMark | null {
  const stored = getPreference(db, RECONSTRUCTION_MARK_KEY);
  const value: unknown = stored?.value;
  if (typeof value !== 'object' || value === null) return null;

  const record = value as Record<string, unknown>;
  const derivedAt = record.derivedAt;
  if (typeof derivedAt !== 'string') return null;

  return {
    derivedAt,
    reconstructableFrom: typeof record.reconstructableFrom === 'string' ? record.reconstructableFrom : null,
    balancesAt: typeof record.balancesAt === 'string' ? record.balancesAt : null,
  };
}

export interface ReconstructionFrontier {
  /** Oldest month reverse-replay can justify from today's balances, or null when it justifies none. */
  reconstructableFrom: string | null;
  /** Oldest snapshot of any kind on record. */
  oldestSnapshot: string | null;
  /** Oldest reconstructed row on record. */
  oldestEstimate: string | null;
  /** Reconstructed rows the month walk can never revisit, so nothing would ever correct them. */
  unreachableEstimates: number;
  /**
   * Newest write to a balance the replay starts from.
   *
   * This is the seed of every reconstructed month: reverse-replay is today's balance minus the
   * transactions after the target, so a balance that moved shifts every point in the series.
   * Hidden accounts are excluded because the walk excludes them.
   */
  balancesAt: string | null;
  mark: ReconstructionMark | null;
}

export interface ReconstructionRun {
  ran: boolean;
  /** Which check found work. Null when the run was forced by the owner, or when none did. */
  trigger: ReconstructionTrigger | null;
  reconstructed: number;
  oldestReconstructed: string | null;
  measured: number;
}

/**
 * Everything the trigger decision needs, read without running the reconstruction.
 *
 * The two queries here are the cheap half of `backfillSnapshots`: the accounts, one grouped MIN
 * over transactions, and one aggregate over the snapshot table. The expensive half is loading
 * every posted row and walking the months, and the point of this function is not to pay for that
 * on a sync that has nothing to reconstruct.
 */
export function readReconstructionFrontier(db: Database.Database): ReconstructionFrontier {
  const accounts = db.prepare(`
    SELECT id, current_balance, updated_at FROM accounts WHERE is_hidden = 0
  `).all() as Array<{ id: string; current_balance: number; updated_at: string }>;

  const firstSeen = db.prepare(`
    SELECT account_id, MIN(date) AS first_date
    FROM transactions
    WHERE pending = 0
    GROUP BY account_id
  `).all() as Array<{ account_id: string; first_date: string }>;

  const floors = accountFloorMonths(
    accounts,
    new Map(firstSeen.map((row) => [row.account_id, row.first_date]))
  );

  const bounds = db.prepare(`
    SELECT MIN(date) AS oldest,
           MIN(CASE WHEN is_estimated = 1 THEN date END) AS oldest_estimate,
           SUM(CASE WHEN is_estimated = 1 AND substr(date, 9, 2) != '01' THEN 1 ELSE 0 END) AS unreachable
    FROM net_worth_snapshots
  `).get() as { oldest: string | null; oldest_estimate: string | null; unreachable: number | null };

  let balancesAt: string | null = null;
  for (const account of accounts) {
    if (balancesAt === null || account.updated_at > balancesAt) balancesAt = account.updated_at;
  }

  return {
    reconstructableFrom: earliestCoveredMonth(floors),
    oldestSnapshot: bounds.oldest,
    oldestEstimate: bounds.oldest_estimate,
    unreachableEstimates: bounds.unreachable ?? 0,
    balancesAt,
    mark: readMark(db),
  };
}

/**
 * Whether reconstruction has anything new to say, and which check decided so.
 *
 * The alternatives were a clock and a button, and both are wrong for different reasons.
 *
 * Every sync is wrong because nothing about this is periodic. An hourly rerun rewrites months of
 * reconstructed history whether or not anything it reads has changed, so points move under the
 * owner between two glances at the same screen. Freshness is a property of the inputs, not of the
 * clock.
 *
 * A button alone is wrong because the moments reconstruction matters (a deep resync, a CSV import,
 * an account connected with history behind it) are exactly the moments nobody is thinking about
 * net-worth history, and a maintenance script the owner has to know about is a feature that does
 * not exist. `backfillSnapshots` was correct and unreachable for precisely that reason: its only
 * caller was `scripts/backfill/rebuild.ts`.
 *
 * So the trigger is a condition on the data, and each clause is a check rather than a guess:
 *
 *   no_ledger             nothing holding value has history left, so every reconstructed row on
 *                         record is unsupported and has to go.
 *   floor_raised          reconstructed rows sit below the oldest month today's data can justify.
 *   unreachable_estimates reconstructed rows the month walk cannot revisit, so nothing corrects
 *                         them and their coverage stays whatever it was written with.
 *   never_reconstructed   no run has ever been recorded.
 *   ledger_window_moved   the oldest month the ledger can justify is not the one the last run was
 *                         computed for. A deep resync or an import of old history looks like this.
 *   balances_moved        the balances the replay starts from were written after the last run.
 *                         Reverse-replay is today's balance minus what came after, so a balance
 *                         that moved shifts every reconstructed point, and leaving them fixed is
 *                         how the reconstructed segment drifts out of agreement with the measured
 *                         one it joins.
 *
 * `balances_moved` is what keeps this from being a button in disguise, and it is not an hourly
 * rewrite either. Measured 2026-07-31 on a copy of .mizan/mizan.db at migration 046:
 *
 *   SELECT COUNT(DISTINCT updated_at) FROM accounts WHERE is_hidden = 0;   -- 6, over 14 accounts
 *   SELECT MIN(updated_at), MAX(updated_at) FROM accounts;  -- 2026-06-30 .. 2026-07-30
 *
 * Six balance writes in the month those snapshots cover, against roughly 24 syncs a day.
 *
 * What this deliberately does NOT catch: transactions arriving inside the window already
 * reconstructed without moving any balance, which adds evidence to a month that had none. The
 * frontier cannot see that without doing the walk it exists to avoid. That is what the owner's
 * rebuild is for, and Settings > Data says when the replay last ran so the gap is visible.
 */
export function reconstructionTrigger(frontier: ReconstructionFrontier): ReconstructionTrigger | null {
  const { mark } = frontier;

  if (frontier.reconstructableFrom === null) {
    // Nothing to replay. Still work if rows are on record claiming otherwise; otherwise the run
    // that withdrew them recorded a mark, and there is nothing left to withdraw.
    if (frontier.oldestEstimate !== null) return 'no_ledger';
    return mark === null ? 'never_reconstructed' : null;
  }
  if (frontier.oldestEstimate !== null && frontier.oldestEstimate < frontier.reconstructableFrom) {
    return 'floor_raised';
  }
  if (frontier.unreachableEstimates > 0) return 'unreachable_estimates';
  if (mark === null) return 'never_reconstructed';
  if (mark.reconstructableFrom !== frontier.reconstructableFrom) return 'ledger_window_moved';
  if (frontier.balancesAt !== null && (mark.balancesAt === null || frontier.balancesAt > mark.balancesAt)) {
    return 'balances_moved';
  }
  return null;
}

function reconstructionCounts(db: Database.Database): Omit<ReconstructionRun, 'ran' | 'trigger'> {
  const row = db.prepare(`
    SELECT SUM(CASE WHEN is_estimated = 1 THEN 1 ELSE 0 END) AS reconstructed,
           SUM(CASE WHEN is_estimated = 0 THEN 1 ELSE 0 END) AS measured,
           MIN(CASE WHEN is_estimated = 1 THEN date END) AS oldest
    FROM net_worth_snapshots
  `).get() as { reconstructed: number | null; measured: number | null; oldest: string | null };

  return {
    reconstructed: row.reconstructed ?? 0,
    measured: row.measured ?? 0,
    oldestReconstructed: row.oldest,
  };
}

/**
 * The one entry point that puts reverse-replay in front of the owner.
 *
 * Called by the post-sync stages (which pass nothing, so the trigger decides) and by the owner's
 * explicit rebuild (which forces it). Both land in the same place, so there is one definition of
 * what reconstructed history is.
 *
 * Measured snapshots are never at risk here: `backfillSnapshots` skips a month holding an
 * `is_estimated = 0` row, and its purge is scoped to `is_estimated = 1`. Forcing changes when the
 * walk runs, never what it is allowed to touch.
 */
export function reconcileReconstructedHistory(options: { force?: boolean } = {}): ReconstructionRun {
  const db = getDb();
  const frontier = readReconstructionFrontier(db);
  const trigger = reconstructionTrigger(frontier);

  if (trigger === null && !options.force) {
    return { ran: false, trigger: null, ...reconstructionCounts(db) };
  }

  backfillSnapshots();

  // Recorded even when the walk emitted nothing. "The ledger justified no month" and "no run has
  // happened" are different states, and only the mark can tell them apart; without it the empty
  // case re-runs on every sync forever.
  const mark: ReconstructionMark = {
    derivedAt: new Date().toISOString(),
    reconstructableFrom: frontier.reconstructableFrom,
    balancesAt: frontier.balancesAt,
  };
  setPreference(db, RECONSTRUCTION_MARK_KEY, mark);

  return { ran: true, trigger, ...reconstructionCounts(db) };
}

export function backfillSnapshots(): void {
  const db = getDb();
  const now = new Date();

  // Load the full posted-transaction history: the backfill extends as far back as the
  // data goes (post one-time import this can be years), not a fixed window.
  const transactions = db.prepare(`
    SELECT id, account_id, date, amount, category_id
    FROM transactions
    WHERE pending = 0
    ORDER BY date ASC
  `).all() as Array<{
    id: string;
    account_id: string;
    date: string;
    amount: number;
    category_id: string | null;
  }>;

  // Reach back to the month of the oldest transaction (clamped), so imported history
  // actually produces net-worth points instead of stopping at a fixed wall.
  const earliestDate = transactions.length ? transactions[0].date : format(now, 'yyyy-MM-dd');
  const monthsOfHistory = differenceInCalendarMonths(now, startOfMonth(new Date(`${earliestDate}T00:00:00`)));
  const monthsBackLimit = Math.min(Math.max(monthsOfHistory, 0), MAX_BACKFILL_MONTHS);

  // Current balances as the starting point (today's balances)
  const accounts = db.prepare(`
    SELECT id, current_balance, is_liability, is_hidden, type
    FROM accounts
    WHERE is_hidden = 0
  `).all() as Array<{
    id: string;
    current_balance: number;
    is_liability: number;
    is_hidden: number;
    type: string;
  }>;

  // transactions is ordered by date ASC, so the first row seen per account is its earliest.
  const firstTransactionByAccount = new Map<string, string>();
  // Which accounts the ledger has anything to say about in a given `yyyy-MM`. Reversing a month
  // moves the estimate by exactly the rows dated inside it, so this is the evidence that makes one
  // month's point different from the next one's.
  const activeAccountsByMonth = new Map<string, Set<string>>();
  for (const txn of transactions) {
    if (!firstTransactionByAccount.has(txn.account_id)) {
      firstTransactionByAccount.set(txn.account_id, txn.date);
    }
    const month = txn.date.slice(0, 7);
    const active = activeAccountsByMonth.get(month);
    if (active) {
      active.add(txn.account_id);
    } else {
      activeAccountsByMonth.set(month, new Set([txn.account_id]));
    }
  }

  const floors = accountFloorMonths(accounts, firstTransactionByAccount);
  const earliestMonth = earliestCoveredMonth(floors);

  // Read once: the set is the same for every month this run writes, and only the covered subset
  // differs. Inside the loop this was one query per month, up to 600 of them.
  const portfolioIds = readPortfolioAccounts(db).map((account) => account.id);

  // Runs before the early return and before any writing, because a raised floor is exactly when
  // stale rows go stale: the months this run will no longer produce are the ones nothing would
  // ever have deleted.
  purgeUnjustifiedEstimates(db, earliestMonth);

  // Nothing that holds value today has any ledger history: every "estimate" would be a copy
  // of today's balances wearing a past date.
  if (!earliestMonth) return;

  const accountMap: Record<string, { is_liability: number; type: string; current_balance: number }> = {};
  for (const account of accounts) {
    accountMap[account.id] = {
      is_liability: account.is_liability,
      type: account.type,
      current_balance: account.current_balance,
    };
  }

  // 'closed' accounts reconstruct their history through the deposit (else) branch below and
  // bucket as liquid: they were checking/savings before closure.
  const liquidTypes = new Set(['checking', 'savings', 'cash', 'closed']);
  const investmentTypes = new Set(['brokerage', 'ira_traditional', 'ira_roth']);

  // Accounts whose value is market-driven, not transaction-driven. Reversing individual
  // buys/sells/dividends off their current value is meaningless (a $100 buy doesn't change
  // account value, it converts cash to securities). Since transaction data can't
  // reconstruct market moves, we instead reverse only NEW external money entering the
  // account (the user's periodic auto-investing / crypto buys) and hold market value flat.
  // Result: past value ≈ "what you'd contributed by then", a flagged estimate, not the
  // reverse-every-trade nonsense.
  const marketValueTypes = new Set(['brokerage', 'ira_traditional', 'ira_roth', 'crypto_wallet']);

  // Walk backwards month by month across the full history.
  for (let monthsBack = 1; monthsBack <= monthsBackLimit; monthsBack++) {
    const targetDate = startOfMonth(subMonths(now, monthsBack));
    const targetStr = format(targetDate, 'yyyy-MM-dd');

    // Walking backwards, so the month before the oldest account floor ends the run. Every month
    // above it has at least one account it can reconstruct.
    if (targetStr < earliestMonth) break;

    // A month that already holds a MEASURED snapshot is left untouched: it records balances
    // actually observed that day, and an estimate must never overwrite an observation.
    //
    // An existing ESTIMATE is recomputed instead of skipped, which is the other half of the
    // staleness bug. `if (existing) continue` treated a derivation as a record. An estimate is a
    // pure function of today's balances and the ledger, and both change on every sync, so a row
    // written weeks ago describes balances nobody holds any more and drifts out of agreement with
    // the measured segment it joins: 2026-06-01 estimated $4,049.84 against $1,068.29 measured
    // four weeks later. Recomputing keeps the two halves of one line consistent. The cost is that
    // a guess can move under the owner, which is the honest behaviour for a guess.
    const existing = db.prepare(
      'SELECT id, is_estimated FROM net_worth_snapshots WHERE date = ?'
    ).get(targetStr) as { id: string; is_estimated: number } | undefined;

    if (existing && existing.is_estimated === 0) continue;

    // Find all transactions that occurred after this target date up to the next month
    // to replay backwards: subtract amounts that happened after target date
    const laterTransactions = transactions.filter(t => t.date > targetStr);

    // Seed only the accounts this month can account for. An account whose own history starts later
    // is omitted rather than carried back at today's balance, because carrying it back would put
    // a card that did not exist yet onto the balance sheet.
    const approxBalances: Record<string, number> = {};
    for (const account of accounts) {
      const floor = floors.get(account.id);
      if (floor !== undefined && floor > targetStr) continue;
      approxBalances[account.id] = account.current_balance;
    }
    const coveredAccounts = Object.keys(approxBalances).length;

    // Compute approximate balances at start of target month by reversing later transactions.
    for (const txn of laterTransactions) {
      if (approxBalances[txn.account_id] === undefined) continue;
      const meta = accountMap[txn.account_id];
      // Transaction sign: negative = money out (expense), positive = money in (income).
      if (meta && marketValueTypes.has(meta.type)) {
        // Market-driven account: only external money moving in/out changes value in a way we
        // can reconstruct; internal buys-with-existing-cash, sells, and dividends leave the
        // estimate flat (market moves are unknowable from transactions).
        const cat = txn.category_id ?? '';
        if (cat === 'cat_inv_buy' || cat === 'cat_crypto_buy') {
          // Money spent to acquire assets (negative cash) RAISES value by its magnitude, so
          // pre-purchase value was lower. Undo by subtracting the magnitude.
          approxBalances[txn.account_id] -= Math.abs(txn.amount);
        } else if (cat === 'cat_crypto_sell') {
          // A crypto SELL leg is the mirror of a buy leg. Undo by ADDING back its magnitude.
          // This makes a Coinbase convert (a matched crypto_sell + crypto_buy of equal USD) net
          // to zero in the estimate, instead of the buy leg being counted as a phantom external
          // contribution. (A real crypto→cash sell is treated as an outflow, a fair approximation.
          // Fiat deposits/withdrawals into the wallet are left flat, so a buy funded by a separate
          // deposit isn't double-counted.)
          approxBalances[txn.account_id] += Math.abs(txn.amount);
        } else if (cat === 'cat_inv_transfer') {
          // Sign-aware external flow: a contribution (+) means value was lower before; a
          // withdrawal/correction (−) means it was higher. Undo by subtracting the amount.
          approxBalances[txn.account_id] -= txn.amount;
        }
      } else if (meta?.is_liability) {
        // Liability balances are stored as positive "amount owed" and move OPPOSITE the
        // sign: a purchase (negative amount) raises what's owed, so undo by adding.
        approxBalances[txn.account_id] += txn.amount;
      } else {
        // Asset balances move WITH the sign, so undo by subtracting the amount.
        approxBalances[txn.account_id] -= txn.amount;
      }
    }

    // A market-driven account cannot sensibly go negative in this estimate: it overshoots when
    // reversed contributions exceed today's value (a market loss or withdrawal we can't see).
    // A liability overshoots the same way when we have a card's purchases but not its payments
    // (a spend-only year-end summary), which would drive "owed" hugely negative.
    //
    // But a card CAN legitimately sit in credit, so zero is the wrong floor for a liability: it
    // erases a real credit position and manufactures a jump on the chart. The floor is instead
    // the credit the account demonstrably holds today, which is an observed number rather than a
    // reconstructed one. For a card that is owed money today this is exactly the old clamp.
    // A clamped balance is the reconstruction admitting it has no answer, so the ids are kept
    // and a month that rests entirely on them is not emitted at all.
    const clampedAccounts = new Set<string>();
    for (const id of Object.keys(approxBalances)) {
      const m = accountMap[id];
      if (!m) continue;
      const floor = m.is_liability ? Math.min(0, m.current_balance) : 0;
      if ((marketValueTypes.has(m.type) || m.is_liability) && approxBalances[id] < floor) {
        approxBalances[id] = floor;
        clampedAccounts.add(id);
      }
    }

    // Nothing the covered accounts recorded this month survived into the estimate, so the row
    // would restate its neighbour under an older date. Any stale estimate here is removed for the
    // same reason it would not be written: the current data does not support it.
    if (!monthIsInformative(activeAccountsByMonth.get(targetStr.slice(0, 7)), approxBalances, clampedAccounts)) {
      if (existing) {
        db.prepare('DELETE FROM net_worth_snapshots WHERE id = ?').run(existing.id);
      }
      continue;
    }

    let total_assets = 0;
    let total_liabilities = 0;
    let liquid_assets = 0;
    let investment_assets = 0;
    let crypto_assets = 0;
    const breakdown: Record<string, number> = {};

    for (const accountId of Object.keys(approxBalances)) {
      const balance = approxBalances[accountId];
      breakdown[accountId] = balance;
      const account = accountMap[accountId];
      if (!account) continue;
      if (account.is_liability) {
        total_liabilities += balance;
      } else {
        total_assets += balance;
        if (liquidTypes.has(account.type)) {
          liquid_assets += balance;
        } else if (investmentTypes.has(account.type)) {
          investment_assets += balance;
        } else if (account.type === 'crypto_wallet') {
          crypto_assets += balance;
        }
      }
    }

    const net_worth = total_assets - total_liabilities;
    // created_at is refreshed on a recompute on purpose: for a derived row it answers "when was
    // this derived", and the value it replaced described balances that no longer exist.
    const derivedAt = new Date().toISOString();

    // The portfolio's membership for this month, narrowed to the accounts the month could account
    // for at all. 'recorded' here means recorded at DERIVATION time, which is `created_at` and not
    // `date`: the balances of a reconstructed row come from today's accounts table too, so the two
    // halves describe the same instant and are rewritten together on every run. Reading it as an
    // observation of what the portfolio was on `date` would be the reverse-replay-as-fact mistake
    // `is_estimated` exists to stop, which is why that flag stays on the same row.
    const portfolioAccounts = frozenPortfolio(portfolioIds, new Set(Object.keys(approxBalances)));

    if (existing) {
      db.prepare(`
        UPDATE net_worth_snapshots
        SET total_assets = ?, total_liabilities = ?, net_worth = ?, breakdown = ?,
            liquid_assets = ?, investment_assets = ?, crypto_assets = ?,
            covered_accounts = ?, total_accounts = ?, created_at = ?,
            portfolio_accounts = ?, portfolio_accounts_source = 'recorded'
        WHERE id = ?
      `).run(
        total_assets,
        total_liabilities,
        net_worth,
        JSON.stringify(breakdown),
        liquid_assets,
        investment_assets,
        crypto_assets,
        coveredAccounts,
        accounts.length,
        derivedAt,
        portfolioAccounts,
        existing.id
      );
      continue;
    }

    db.prepare(`
      INSERT INTO net_worth_snapshots
        (id, date, total_assets, total_liabilities, net_worth, breakdown, is_estimated,
         liquid_assets, investment_assets, crypto_assets, covered_accounts, total_accounts,
         created_at, portfolio_accounts, portfolio_accounts_source)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 'recorded')
    `).run(
      uuidv4(),
      targetStr,
      total_assets,
      total_liabilities,
      net_worth,
      JSON.stringify(breakdown),
      liquid_assets,
      investment_assets,
      crypto_assets,
      coveredAccounts,
      accounts.length,
      derivedAt,
      portfolioAccounts
    );
  }
}
