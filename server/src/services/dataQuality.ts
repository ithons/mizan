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

interface DataQualityInputs {
  syncHealth: SyncHealth;
  reviewSummary: TransactionReviewSummary;
  forecast: RecurringForecast;
  invariantIssues?: PersonalFinanceInvariantIssue[];
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

function transactionReviewIssue(reviewSummary: TransactionReviewSummary): WeightedIssue | null {
  if (reviewSummary.total_open <= 0) return null;

  const uncategorized = queueCount(reviewSummary, 'uncategorized');
  const parts = [
    [uncategorized, 'uncategorized transaction'],
    [queueCount(reviewSummary, 'rule_suggestions'), 'rule suggestion'],
    [queueCount(reviewSummary, 'pending'), 'pending transaction'],
    [queueCount(reviewSummary, 'recurring_candidates'), 'recurring candidate'],
    [queueCount(reviewSummary, 'duplicate_candidates'), 'possible duplicate'],
    [queueCount(reviewSummary, 'transfer_candidates'), 'detected transfer'],
  ] as const;
  const named = parts
    .filter(([count]) => count > 0)
    .map(([count, noun]) => counted(count, noun));

  return issue(
    'transaction-review',
    'Transaction review backlog',
    named.length > 0
      ? sentence(joinCounted(named), 'needs', 'need', 'review before reports can be fully trusted.')
      : sentence(counted(reviewSummary.total_open, 'review item'), 'needs', 'need', 'attention.'),
    '/review',
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

function syncIssue(syncHealth: SyncHealth): WeightedIssue | null {
  switch (syncHealth.status) {
    case 'attention':
      return issue('sync-attention', 'Connection needs attention', syncHealth.status_detail, '/accounts', 'critical', 35);
    case 'stale':
      return issue('sync-stale', 'Sync is stale', syncHealth.status_detail, '/accounts', 'warning', 20);
    case 'empty':
      return issue('sync-empty', 'No live connections', syncHealth.status_detail, '/accounts', 'warning', 30);
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
}: DataQualityInputs): DataQualitySummary {
  const issues: WeightedIssue[] = [
    ...invariantIssues,
    syncIssue(syncHealth),
    transactionReviewIssue(reviewSummary),
    cashFlowReviewIssue(forecast),
  ].filter((item): item is WeightedIssue => item !== null);

  return {
    issues: issues
      .sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || b.weight - a.weight)
      .map(({ weight: _weight, ...item }) => item),
  };
}

export function getDataQualitySummary(db: Database.Database): DataQualitySummary {
  const now = new Date();

  return summarizeDataQuality({
    syncHealth: getSyncHealth(db),
    reviewSummary: getTransactionReviewSummary(db),
    forecast: buildRecurringForecast(db, 60),
    invariantIssues: getPersonalFinanceInvariantIssues(db, now),
  });
}
