import type Database from 'better-sqlite3';
import type {
  DataQualityIssue,
  DataQualitySummary,
  InsightSeverity,
  RecurringForecast,
  SyncHealth,
  TransactionReviewSummary,
} from '../../../shared/types';
import { buildRecurringForecast } from './recurringForecast';
import { getSyncHealth } from './syncHealth';
import { getTransactionReviewSummary } from './transactionReview';
import { getPersonalFinanceInvariantIssues } from './personalFinanceInvariants';
import type { PersonalFinanceInvariantIssue } from './personalFinanceInvariants';

/**
 * What the install is doing, apart from its provider connections.
 *
 * `sync-empty` is the one row here that can outlive every action its owner is willing to take. An
 * owner who keeps their accounts by hand has no live connection and never will, so "No live
 * connections" sits in their panel permanently: the standing finding this panel exists to avoid.
 * Nothing in the schema records "deliberately manual", so the honest substitute is what the install
 * is doing. An install whose accounts carry a settled ledger is being used; an install with no
 * ledger at all has nothing to work from yet, and connecting or importing is genuinely the next
 * step, which is also the only version of this row that clears itself.
 *
 * Hidden accounts count. The row's label ("Nothing to track yet") and its sentence ("No account
 * holds a settled transaction") are both claims about the whole install, and the query used to skip
 * `is_hidden = 1`: an owner whose only history sat on a closed card they had archived was told the
 * install held nothing while `SELECT COUNT(*) FROM transactions WHERE pending = 0` returned five.
 * Counting what the sentence says can only silence this row, never make it fire somewhere new.
 */
export interface LedgerFootprint {
  /** Accounts, hidden or not, holding at least one settled (`pending = 0`) transaction. */
  accounts_with_ledger: number;
}

interface DataQualityInputs {
  syncHealth: SyncHealth;
  reviewSummary: TransactionReviewSummary;
  forecast: RecurringForecast;
  invariantIssues?: PersonalFinanceInvariantIssue[];
  footprint?: LedgerFootprint;
}

interface WeightedIssue extends DataQualityIssue {
  weight: number;
}

const severityRank: Record<InsightSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
  positive: 3,
};

/**
 * A counted noun phrase plus whether it takes a singular verb.
 *
 * The old helper handed back only the phrase, so every call site wrote the verb by hand and got it
 * wrong at one: "1 transfer or investment flow were excluded", "1 recurring item need review".
 * Returning a value that is not a string makes interpolating the subject without choosing a verb a
 * type error, so agreement is decided in exactly one place.
 */
interface Counted {
  text: string;
  isOne: boolean;
}

function counted(count: number, singular: string, pluralNoun = `${singular}s`): Counted {
  return { text: `${count} ${count === 1 ? singular : pluralNoun}`, isOne: count === 1 };
}

// Two counted nouns joined are two things, so the joined subject takes a plural verb even when
// every part of it reads "1 something".
function joinCounted(parts: Counted[]): Counted {
  return {
    text: parts.map((part) => part.text).join(', '),
    isOne: parts.length === 1 && parts[0].isOne,
  };
}

function sentence(subject: Counted, singularVerb: string, pluralVerb: string, rest: string): string {
  return `${subject.text} ${subject.isOne ? singularVerb : pluralVerb} ${rest}`;
}

function issue(
  id: string,
  label: string,
  message: string,
  route: string,
  severity: InsightSeverity,
  weight: number
): WeightedIssue {
  return { id, label, message, route, severity, weight };
}

function queueCount(reviewSummary: TransactionReviewSummary, id: string): number {
  return reviewSummary.queues.find((queue) => queue.id === id)?.count ?? 0;
}

/**
 * The queues this row is allowed to speak for, and every one it counts.
 *
 * `total_open` sums every queue except `pending` (see transactionReview.ts), and this list used to
 * omit `ai_insights` while `total_open` included it. On the live database that is the whole row.
 * Re-derived 2026-07-31 against a copy of `.mizan/mizan.db` at migration 054 taken with `.backup`,
 * running `getTransactionReviewSummary` and `getDataQualitySummary` over the copy:
 *
 *   queues -> ai_insights 7, uncategorized 0, rule_suggestions 0, pending 0,
 *             recurring_candidates 0, duplicate_candidates 0, transfer_candidates 0
 *   total_open -> 7
 *
 * so the panel reported a backlog whose entire content it could not name and fell through to
 * "7 review items need attention". A count with no noun is not something an owner can act on.
 *
 * SEVEN, NOT FIFTEEN, AND THE DIFFERENCE IS NOT COSMETIC. `SELECT COUNT(*) FROM advisor_drafts
 * WHERE status = 'open'` on the same copy returns 15 (`GROUP BY kind` -> categorize_transaction 14,
 * update_goal_target 1), but `isDraftStillActionable` drops the drafts whose premise no longer
 * holds before the queue is counted, so 15 is a table count and 7 is the number the panel printed.
 * Writing the table count here as the printed figure is the derived-as-fact failure this file
 * exists to stop.
 *
 * Keeping the list beside the ids it reads is still two places; the guard is a test that walks
 * `TransactionReviewSummary.queues` and fails on any id this list does not cover, so a queue added
 * to the summary cannot go unnamed here again.
 */
const REVIEW_QUEUE_NOUNS: ReadonlyArray<readonly [string, string]> = [
  ['ai_insights', 'AI suggestion'],
  ['uncategorized', 'uncategorized transaction'],
  ['rule_suggestions', 'rule suggestion'],
  ['pending', 'pending transaction'],
  ['recurring_candidates', 'recurring candidate'],
  ['duplicate_candidates', 'possible duplicate'],
  ['transfer_candidates', 'detected transfer'],
];

export const REVIEW_QUEUE_IDS_NAMED: ReadonlyArray<string> = REVIEW_QUEUE_NOUNS.map(([id]) => id);

function transactionReviewIssue(reviewSummary: TransactionReviewSummary): WeightedIssue | null {
  if (reviewSummary.total_open <= 0) return null;

  const uncategorized = queueCount(reviewSummary, 'uncategorized');
  const named = REVIEW_QUEUE_NOUNS
    .map(([id, noun]) => [queueCount(reviewSummary, id), noun] as const)
    .filter(([count]) => count > 0)
    .map(([count, noun]) => counted(count, noun));

  return issue(
    'transaction-review',
    'Transaction review backlog',
    named.length > 0
      ? sentence(joinCounted(named), 'needs', 'need', 'review before reports can be fully trusted.')
      : sentence(counted(reviewSummary.total_open, 'review item'), 'needs', 'need', 'attention.'),
    // `/review` redirected to `/ledger?uncategorized=1`, a filter that holds none of the AI
    // suggestions and, on the measured state above, no rows at all: the row's only action landed on
    // an empty list. `/ledger` is the screen every queue named here is worked on, and it carries a
    // chip per queue including "Model suggests".
    '/ledger',
    reviewSummary.total_open > 10 || uncategorized > 5 ? 'warning' : 'info',
    Math.min(25, Math.ceil(reviewSummary.total_open * 1.5))
  );
}

function cashFlowReviewIssue(forecast: RecurringForecast): WeightedIssue | null {
  if (forecast.review_count <= 0) return null;

  const subject = counted(forecast.review_count, 'recurring item');
  const overdue = counted(forecast.overdue_count, 'overdue item');

  return issue(
    'cash-flow-review',
    'Cash flow confidence',
    forecast.overdue_count > 0
      ? sentence(subject, 'needs', 'need', `review, including ${overdue.text}.`)
      : sentence(subject, 'needs', 'need', 'confirmation before the forecast is dependable.'),
    '/bills',
    forecast.overdue_count > 0 ? 'warning' : 'info',
    Math.min(20, forecast.overdue_count * 8 + (forecast.review_count - forecast.overdue_count) * 4)
  );
}

function syncIssue(syncHealth: SyncHealth, footprint: LedgerFootprint): WeightedIssue | null {
  switch (syncHealth.status) {
    case 'attention':
      return issue('sync-attention', 'Connection needs attention', syncHealth.status_detail, '/accounts', 'critical', 35);
    case 'stale':
      return issue('sync-stale', 'Sync is stale', syncHealth.status_detail, '/accounts', 'warning', 20);
    case 'empty':
      // A ledger the owner maintains by hand is an install that works, not one waiting to be
      // connected. See LedgerFootprint for why this is the signal and not a preference.
      if (footprint.accounts_with_ledger > 0) return null;
      return issue(
        'sync-empty',
        'Nothing to track yet',
        'No account holds a settled transaction. Connect an institution, import a statement, or add transactions by hand.',
        '/accounts',
        'warning',
        30
      );
    default:
      return null;
  }
}

/**
 * Every issue here is something the owner can act on. Report exclusions used to be listed too, and
 * they are the reason this panel never reached a clean state: a routine checking-to-savings
 * transfer, both legs categorized and the pair confirmed, put a permanent row in a list of things
 * to fix. Excluding transfers, investment and crypto flows from income and spending totals is the
 * intended behaviour of `transactionFilters.excludedFromTotalsSql`, not a defect, and the counts
 * still reach the owner where they belong: `ReportSummary.excluded_flows` on the Reports screen and
 * in the advisor's financial context. Nothing that only describes correct behaviour goes in here.
 *
 * `weight` orders ties inside one severity band. It is never summed, never serialized, and is not a
 * score; the panel reports conditions, and a grade derived from them would be a claim nothing
 * measured.
 */
export function summarizeDataQuality({
  syncHealth,
  reviewSummary,
  forecast,
  invariantIssues = [],
  // Defaults to "no ledger", the state in which `sync-empty` is genuinely actionable, so a caller
  // that cannot measure the footprint keeps the old behaviour rather than silently going quiet.
  footprint = { accounts_with_ledger: 0 },
}: DataQualityInputs): DataQualitySummary {
  const issues: WeightedIssue[] = [
    ...invariantIssues,
    syncIssue(syncHealth, footprint),
    transactionReviewIssue(reviewSummary),
    cashFlowReviewIssue(forecast),
  ].filter((item): item is WeightedIssue => item !== null);

  return {
    issues: issues
      .sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || b.weight - a.weight)
      .map(({ weight: _weight, ...item }) => item),
  };
}

export function readLedgerFootprint(db: Database.Database): LedgerFootprint {
  const row = db.prepare(`
    SELECT COUNT(*) AS total FROM accounts a
    WHERE EXISTS (SELECT 1 FROM transactions t WHERE t.account_id = a.id AND t.pending = 0)
  `).get() as { total: number };

  return { accounts_with_ledger: row.total };
}

export function getDataQualitySummary(db: Database.Database): DataQualitySummary {
  const now = new Date();

  return summarizeDataQuality({
    syncHealth: getSyncHealth(db),
    reviewSummary: getTransactionReviewSummary(db),
    forecast: buildRecurringForecast(db, 60),
    invariantIssues: getPersonalFinanceInvariantIssues(db, now),
    footprint: readLedgerFootprint(db),
  });
}
