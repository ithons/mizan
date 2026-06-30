import type {
  DataQualitySummary,
  RecurringForecast,
  SyncHealth,
  TransactionReviewSummary,
} from '@shared/types';

export type DashboardMode =
  | 'first_run'
  | 'sync_repair'
  | 'review_backlog'
  | 'forecast_warning'
  | 'clean_overview';

export interface DashboardStateInput {
  accountCount: number;
  syncHealth?: SyncHealth;
  reviewSummary?: TransactionReviewSummary;
  forecast?: RecurringForecast;
  dataQuality?: DataQualitySummary;
}

export function getDashboardMode({
  accountCount,
  syncHealth,
  reviewSummary,
  forecast,
  dataQuality,
}: DashboardStateInput): DashboardMode {
  if (accountCount === 0 && (!syncHealth || syncHealth.status === 'empty')) {
    return 'first_run';
  }

  if (
    syncHealth?.status === 'attention' ||
    syncHealth?.status === 'stale' ||
    dataQuality?.status === 'attention' ||
    dataQuality?.status === 'stale'
  ) {
    return 'sync_repair';
  }

  if ((reviewSummary?.total_open ?? 0) > 0) {
    return 'review_backlog';
  }

  if ((forecast?.net ?? 0) < 0) {
    return 'forecast_warning';
  }

  return 'clean_overview';
}
