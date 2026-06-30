import { format, startOfMonth } from 'date-fns';
import type Database from 'better-sqlite3';
import type {
  DataQualityIssue,
  DataQualityStatus,
  DataQualitySummary,
  InsightSeverity,
  RecurringForecast,
  ReportSummary,
  SyncHealth,
  TransactionReviewSummary,
} from '../../../shared/types';
import { buildRecurringForecast } from './recurringForecast';
import { getReportSummary } from './reporting';
import { getSyncHealth } from './syncHealth';
import { getTransactionReviewSummary } from './transactionReview';

interface DataQualityInputs {
  syncHealth: SyncHealth;
  reviewSummary: TransactionReviewSummary;
  forecast: RecurringForecast;
  reportSummary: ReportSummary;
}

interface ScoredIssue extends DataQualityIssue {
  penalty: number;
}

const severityRank: Record<InsightSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
  positive: 3,
};

function plural(count: number, singular: string, pluralLabel = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralLabel}`;
}

function issue(
  id: string,
  label: string,
  message: string,
  route: string,
  severity: InsightSeverity,
  penalty: number
): ScoredIssue {
  return { id, label, message, route, severity, penalty };
}

function statusFromIssues(
  issues: ScoredIssue[],
  score: number,
  syncStatus: SyncHealth['status']
): {
  status: DataQualityStatus;
  statusLabel: string;
  statusDetail: string;
} {
  if (issues.some((item) => item.severity === 'critical')) {
    return {
      status: 'attention',
      statusLabel: 'Needs attention',
      statusDetail: 'One or more data sources need action before Mizān can fully trust the numbers.',
    };
  }

  if (syncStatus === 'stale' || syncStatus === 'empty') {
    return {
      status: 'stale',
      statusLabel: syncStatus === 'empty' ? 'Not connected' : 'Sync is stale',
      statusDetail: syncStatus === 'empty'
        ? 'Connect live institutions before relying on reports, budgets, or advisor answers.'
        : 'Sync one or more institutions before relying on current balances and recent activity.',
    };
  }

  if (issues.some((item) => item.severity === 'warning') || score < 90) {
    return {
      status: 'review',
      statusLabel: 'Review recommended',
      statusDetail: 'Core data is usable, but review queues or forecast confidence can improve the picture.',
    };
  }

  return {
    status: 'healthy',
    statusLabel: 'Reliable enough',
    statusDetail: 'Core data is fresh and the main review queues are clear.',
  };
}

export function summarizeDataQuality({
  syncHealth,
  reviewSummary,
  forecast,
  reportSummary,
}: DataQualityInputs): DataQualitySummary {
  const issues: ScoredIssue[] = [];

  if (syncHealth.status === 'attention') {
    issues.push(issue(
      'sync-attention',
      'Connection needs attention',
      syncHealth.status_detail,
      '/accounts',
      'critical',
      35
    ));
  } else if (syncHealth.status === 'stale') {
    issues.push(issue(
      'sync-stale',
      'Sync is stale',
      syncHealth.status_detail,
      '/accounts',
      'warning',
      20
    ));
  } else if (syncHealth.status === 'empty') {
    issues.push(issue(
      'sync-empty',
      'No live connections',
      syncHealth.status_detail,
      '/accounts',
      'warning',
      30
    ));
  }

  if (reviewSummary.total_open > 0) {
    const uncategorized = reviewSummary.queues.find((queue) => queue.id === 'uncategorized')?.count ?? 0;
    const rules = reviewSummary.queues.find((queue) => queue.id === 'rule_suggestions')?.count ?? 0;
    const recurring = reviewSummary.queues.find((queue) => queue.id === 'recurring_candidates')?.count ?? 0;
    const duplicates = reviewSummary.queues.find((queue) => queue.id === 'duplicate_candidates')?.count ?? 0;
    const transfers = reviewSummary.queues.find((queue) => queue.id === 'transfer_candidates')?.count ?? 0;
    const reviewParts = [
      uncategorized > 0 ? plural(uncategorized, 'uncategorized transaction') : null,
      rules > 0 ? plural(rules, 'rule suggestion') : null,
      recurring > 0 ? plural(recurring, 'recurring candidate') : null,
      duplicates > 0 ? plural(duplicates, 'possible duplicate') : null,
      transfers > 0 ? plural(transfers, 'detected transfer') : null,
    ].filter((part): part is string => Boolean(part));

    issues.push(issue(
      'transaction-review',
      'Transaction review backlog',
      reviewParts.length > 0
        ? `${reviewParts.join(', ')} need review before reports can be fully trusted.`
        : `${plural(reviewSummary.total_open, 'review item')} need attention.`,
      '/review',
      reviewSummary.total_open > 10 || uncategorized > 5 ? 'warning' : 'info',
      Math.min(25, Math.ceil(reviewSummary.total_open * 1.5))
    ));
  }

  if (forecast.review_count > 0) {
    issues.push(issue(
      'cash-flow-review',
      'Cash flow confidence',
      forecast.overdue_count > 0
        ? `${plural(forecast.review_count, 'recurring item')} need review, including ${plural(forecast.overdue_count, 'overdue item')}.`
        : `${plural(forecast.review_count, 'recurring item')} need confirmation before the forecast is dependable.`,
      '/bills',
      forecast.overdue_count > 0 ? 'warning' : 'info',
      Math.min(20, forecast.overdue_count * 8 + (forecast.review_count - forecast.overdue_count) * 4)
    ));
  }

  if (reportSummary.excluded_flows.length > 0) {
    const count = reportSummary.excluded_flows.reduce((sum, flow) => sum + flow.count, 0);
    issues.push(issue(
      'report-exclusions',
      'Report exclusions applied',
      `${plural(count, 'transfer or investment flow')} were excluded from income and spending reports for cleaner comparisons.`,
      '/reports',
      'info',
      0
    ));
  }

  const score = Math.max(0, 100 - issues.reduce((sum, item) => sum + item.penalty, 0));
  const status = statusFromIssues(issues, score, syncHealth.status);

  return {
    status: status.status,
    status_label: status.statusLabel,
    status_detail: status.statusDetail,
    score,
    issues: issues
      .sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || b.penalty - a.penalty)
      .map(({ penalty: _penalty, ...item }) => item),
  };
}

export function getDataQualitySummary(db: Database.Database): DataQualitySummary {
  const today = new Date();
  const startDate = format(startOfMonth(today), 'yyyy-MM-dd');
  const endDate = format(today, 'yyyy-MM-dd');

  return summarizeDataQuality({
    syncHealth: getSyncHealth(db),
    reviewSummary: getTransactionReviewSummary(db),
    forecast: buildRecurringForecast(db, 60),
    reportSummary: getReportSummary(db, { startDate, endDate }),
  });
}
