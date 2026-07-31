import { format, subDays } from 'date-fns';
import type Database from 'better-sqlite3';
import type { DataQualityIssue, InsightSeverity } from '../../../shared/types';

// `weight` orders ties within one severity band in dataQuality.ts. It is never summed into a
// score and never leaves the server.
export interface PersonalFinanceInvariantIssue extends DataQualityIssue {
  weight: number;
}

interface AccountRow {
  id: string;
  account_name: string;
}

interface SnapshotRow {
  id: string;
  date: string;
  breakdown: string;
}

interface CountRow {
  count: number;
}

function issue(
  id: string,
  label: string,
  message: string,
  route: string,
  severity: InsightSeverity,
  weight: number
): PersonalFinanceInvariantIssue {
  return { id, label, message, route, severity, weight };
}

function count(db: Database.Database, sql: string, ...params: unknown[]): number {
  const row = db.prepare(sql).get(...params) as CountRow | undefined;
  return row?.count ?? 0;
}

function latestSnapshot(db: Database.Database): SnapshotRow | null {
  return db.prepare(`
    SELECT id, date, breakdown
    FROM net_worth_snapshots
    ORDER BY date DESC, created_at DESC
    LIMIT 1
  `).get() as SnapshotRow | undefined ?? null;
}

function hiddenAccounts(db: Database.Database): AccountRow[] {
  return db.prepare(`
    SELECT id, account_name
    FROM accounts
    WHERE is_hidden = 1
  `).all() as AccountRow[];
}

function hiddenAccountSnapshotIssue(db: Database.Database): PersonalFinanceInvariantIssue | null {
  const snapshot = latestSnapshot(db);
  if (!snapshot) return null;

  let breakdown: Record<string, unknown>;
  try {
    breakdown = JSON.parse(snapshot.breakdown) as Record<string, unknown>;
  } catch {
    return issue(
      'net-worth-breakdown-invalid',
      'Net worth evidence is unreadable',
      `The latest net worth snapshot on ${snapshot.date} has an invalid account breakdown, so Mizān cannot explain that number reliably.`,
      '/reports',
      'critical',
      35
    );
  }

  const hiddenById = new Map(hiddenAccounts(db).map((account) => [account.id, account]));
  const leakedAccounts = Object.keys(breakdown)
    .map((accountId) => hiddenById.get(accountId))
    .filter((account): account is AccountRow => Boolean(account));

  if (leakedAccounts.length === 0) return null;

  const names = leakedAccounts.map((account) => account.account_name).join(', ');
  return issue(
    'hidden-account-net-worth',
    'Hidden account included in net worth',
    `The latest net worth snapshot includes hidden ${leakedAccounts.length === 1 ? 'account' : 'accounts'}: ${names}. Refresh the snapshot after hiding accounts before trusting net worth.`,
    '/accounts',
    'critical',
    35
  );
}

function stalePendingTransactionsIssue(
  db: Database.Database,
  now: Date
): PersonalFinanceInvariantIssue | null {
  const cutoff = format(subDays(now, 7), 'yyyy-MM-dd');
  const stalePending = count(
    db,
    'SELECT COUNT(*) AS count FROM transactions WHERE pending = 1 AND date < ?',
    cutoff
  );

  if (stalePending === 0) return null;

  // `?range=all` and not `?pending=true`: Transactions reads only `uncategorized` and `range`, so
  // the pending param was silently dropped and the row landed on an unfiltered this-month list that
  // need not even contain the rows being described. `range=all` is a param that screen honours, and
  // it guarantees a row older than 7 days is inside the visible window.
  return issue(
    'stale-pending-transactions',
    'Old pending transactions',
    `${stalePending} pending ${stalePending === 1 ? 'transaction is' : 'transactions are'} older than 7 days and may never post. Pending rows stay out of reports until they post or are removed.`,
    '/transactions?range=all',
    'warning',
    Math.min(15, stalePending * 3)
  );
}

// Holdings whose account was deleted are dead weight that inflate the portfolio total and can't
// be reconciled to any account: a real integrity break, not a soft-data-quality nit.
function orphanHoldingsIssue(db: Database.Database): PersonalFinanceInvariantIssue | null {
  const orphans = count(
    db,
    `SELECT COUNT(*) AS count FROM holdings h
     LEFT JOIN accounts a ON a.id = h.account_id
     WHERE a.id IS NULL`
  );
  if (orphans === 0) return null;
  return issue(
    'orphan-holdings',
    'Holdings without an account',
    `${orphans} holding ${orphans === 1 ? 'row references' : 'rows reference'} an account that no longer exists. They inflate the portfolio total and can't be reconciled.`,
    '/investments',
    'critical',
    30
  );
}

// A 'closed' account is expected to sit at $0 (it's kept for net-worth history, not live value).
// A non-zero one leaks into future net-worth snapshots, distorting the current total.
function closedAccountBalanceIssue(db: Database.Database): PersonalFinanceInvariantIssue | null {
  const nonZero = db.prepare(
    "SELECT id, account_name FROM accounts WHERE type = 'closed' AND current_balance != 0"
  ).all() as AccountRow[];
  if (nonZero.length === 0) return null;
  const names = nonZero.map((account) => account.account_name).join(', ');
  return issue(
    'closed-account-nonzero',
    'Closed account has a balance',
    `Closed ${nonZero.length === 1 ? 'account' : 'accounts'} with a non-zero balance: ${names}. Closed accounts should be $0 so they don't distort current net worth.`,
    '/accounts',
    'warning',
    Math.min(15, nonZero.length * 5)
  );
}

export function getPersonalFinanceInvariantIssues(
  db: Database.Database,
  now = new Date()
): PersonalFinanceInvariantIssue[] {
  return [
    hiddenAccountSnapshotIssue(db),
    stalePendingTransactionsIssue(db, now),
    orphanHoldingsIssue(db),
    closedAccountBalanceIssue(db),
  ].filter((item): item is PersonalFinanceInvariantIssue => Boolean(item));
}
