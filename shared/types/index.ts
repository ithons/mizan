export type ConnectionType = 'coinbase' | 'simplefin' | 'manual';

export type AccountType =
  | 'checking'
  | 'savings'
  | 'credit'
  | 'brokerage'
  | 'ira_traditional'
  | 'ira_roth'
  | 'crypto_wallet'
  | 'cash'
  | 'other';

export interface Account {
  id: string;
  simplefin_account_id?: string | null;
  coinbase_account_id?: string | null;
  connection_id?: string | null;
  connection_type: ConnectionType;
  institution_name: string;
  account_name: string;
  type: AccountType;
  subtype?: string | null;
  mask?: string | null;
  current_balance: number;
  available_balance?: number | null;
  credit_limit?: number | null;
  currency: string;
  native_currency?: string | null;
  native_balance?: number | null;
  is_manual: boolean;
  is_hidden: boolean;
  is_liability: boolean;
  color?: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface Transaction {
  id: string;
  simplefin_transaction_id?: string | null;
  coinbase_transaction_id?: string | null;
  account_id: string;
  date: string;
  amount: number;
  merchant_name?: string | null;
  original_name: string;
  category_id?: string | null;
  pending: boolean;
  notes?: string | null;
  is_manual: boolean;
  recurring_id?: string | null;
  source_type: 'coinbase' | 'simplefin' | 'manual' | 'import';
  source_detail?: string | null;
  duplicate_group_id?: string | null;
  duplicate_status: 'none' | 'candidate' | 'dismissed';
  transfer_pair_id?: string | null;
  transfer_status: 'none' | 'candidate' | 'confirmed' | 'dismissed';
  review_status: 'open' | 'reviewed' | 'dismissed';
  created_at: string;
  updated_at: string;
  // joined
  category_name?: string | null;
  category_color?: string | null;
  category_icon?: string | null;
  account_name?: string | null;
  institution_name?: string | null;
}

export interface TransactionCategorizationResult {
  rule_id: string | null;
  pattern: string | null;
  applied: number;
}

export interface TransactionUpdateResult {
  transaction: Transaction;
  categorization: TransactionCategorizationResult;
}

export interface AppPreference<T = unknown> {
  key: string;
  value: T;
  created_at: string;
  updated_at: string;
}

export interface DataImportRun {
  id: string;
  source: 'csv' | 'backup_restore';
  status: 'succeeded' | 'partial' | 'failed';
  rows_seen: number;
  rows_imported: number;
  rows_invalid: number;
  duplicate_candidates: number;
  transfer_candidates: number;
  warnings_count: number;
  errors_count: number;
  summary: string;
  created_at: string;
}

export interface InvestmentTransaction {
  id: string;
  account_id: string;
  date: string;
  type: 'buy' | 'sell' | 'dividend' | 'transfer' | 'fee' | 'other';
  security_id?: string | null;
  quantity?: number | null;
  price?: number | null;
  amount: number;
  fees?: number | null;
  name: string;
  created_at: string;
  // joined
  ticker?: string | null;
  security_name?: string | null;
}

export interface Security {
  id: string;
  ticker?: string | null;
  name: string;
  type: 'equity' | 'etf' | 'mutual_fund' | 'crypto' | 'cash' | 'other';
  currency: string;
  sector?: string | null;
  sector_source?: string | null;
}

export interface Holding {
  id: string;
  account_id: string;
  security_id: string;
  quantity: number;
  institution_price: number;
  institution_value: number;
  cost_basis?: number | null;
  provider_cost_basis?: number | null;
  effective_cost_basis?: number | null;
  manual_cost_basis?: number | null;
  manual_cost_basis_note?: string | null;
  manual_cost_basis_updated_at?: string | null;
  cost_basis_quality?: 'manual' | 'provider' | 'missing';
  currency: string;
  updated_at: string;
  // joined
  ticker?: string | null;
  security_name?: string | null;
  security_type?: string | null;
  sector?: string | null;
  sector_source?: string | null;
}

export interface HoldingHistoryPoint {
  date: string;
  quantity: number;
  institution_price: number;
  institution_value: number;
  cost_basis: number | null;
}

export interface Category {
  id: string;
  name: string;
  icon?: string | null;
  color?: string | null;
  parent_id?: string | null;
  is_income: boolean;
  is_system: boolean;
  is_investment: boolean;
  sort_order: number;
  children?: Category[];
}

export interface Budget {
  id: string;
  category_id: string;
  amount: number;
  period: string;
  rollover: boolean;
  rollover_balance: number;
  created_at: string;
  updated_at: string;
  // joined
  category_name?: string | null;
  category_color?: string | null;
  category_icon?: string | null;
  spent?: number;
  expected_recurring?: number;
  projected_spend?: number;
  projected_remaining?: number;
  projected_percent?: number;
  pacing_velocity?: number;
  forecast_confidence?: 'none' | 'confirmed' | 'likely' | 'uncertain';
}

export interface BudgetGroupTotals {
  budget_count: number;
  budgeted: number;
  spent: number;
  rollover_balance: number;
  expected_recurring: number;
  projected_spend: number;
  projected_remaining: number;
  forecast_confidence: NonNullable<Budget['forecast_confidence']>;
}

export interface BudgetGroupMember {
  group_id: string;
  category_id: string;
  sort_order: number;
  created_at: string;
  category_name?: string | null;
  category_color?: string | null;
  category_icon?: string | null;
}

export interface BudgetGroup {
  id: string;
  name: string;
  color?: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
  members: BudgetGroupMember[];
  totals: BudgetGroupTotals;
}

export interface BudgetRolloverLedgerEntry {
  id: string;
  budget_id: string;
  category_id: string;
  category_name?: string | null;
  category_color?: string | null;
  category_icon?: string | null;
  month: string;
  starting_rollover: number;
  budget_amount: number;
  actual_spend: number;
  ending_rollover: number;
  calculated_at: string;
}

export interface RecurringPattern {
  id: string;
  merchant_name: string;
  category_id?: string | null;
  average_amount: number;
  average_signed_amount?: number | null;
  frequency: 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'annual';
  last_seen: string;
  next_expected: string;
  is_active: boolean;
  is_confirmed: boolean;
  transaction_count: number;
  created_at: string;
  updated_at: string;
  // joined
  category_name?: string | null;
  category_color?: string | null;
}

export type RecurringAdjustmentAction = 'skip' | 'snooze' | 'adjust';

export interface RecurringOccurrenceAdjustment {
  id: string;
  recurring_id: string;
  original_date: string;
  action: RecurringAdjustmentAction;
  adjusted_date?: string | null;
  adjusted_amount?: number | null;
  note?: string | null;
  created_at: string;
  updated_at: string;
}

export interface RecurringForecastOccurrence {
  id: string;
  pattern_id: string;
  merchant_name: string;
  category_id?: string | null;
  category_name?: string | null;
  category_color?: string | null;
  frequency: RecurringPattern['frequency'];
  expected_date: string;
  amount: number;
  is_income: boolean;
  is_confirmed: boolean;
  confidence: number;
  confidence_label: 'confirmed' | 'likely' | 'uncertain';
  status: 'overdue' | 'upcoming';
  days_until: number;
  needs_review: boolean;
  adjustment_id?: string | null;
  adjustment_action?: RecurringAdjustmentAction | null;
  original_expected_date?: string | null;
  adjusted_date?: string | null;
  adjusted_amount?: number | null;
  adjustment_note?: string | null;
}

export interface RecurringForecast {
  days: number;
  income: number;
  bills: number;
  net: number;
  confirmed_income: number;
  confirmed_bills: number;
  likely_income: number;
  likely_bills: number;
  uncertain_income: number;
  uncertain_bills: number;
  overdue_count: number;
  review_count: number;
  occurrences: RecurringForecastOccurrence[];
}

export interface SubscriptionInsightItem {
  pattern_id: string;
  merchant_name: string;
  category_id?: string | null;
  category_name?: string | null;
  category_color?: string | null;
  frequency: RecurringPattern['frequency'];
  average_amount: number;
  monthly_amount: number;
  next_expected: string;
  upcoming_amount: number;
  is_confirmed: boolean;
  confidence: number;
  confidence_label: RecurringForecastOccurrence['confidence_label'];
  transaction_count: number;
  latest_amount?: number | null;
  previous_amount?: number | null;
  increase_amount?: number | null;
  increase_percent?: number | null;
}

export interface SubscriptionInsights {
  days: number;
  subscription_count: number;
  total_monthly_amount: number;
  total_upcoming_amount: number;
  confirmed_monthly_amount: number;
  unconfirmed_monthly_amount: number;
  increase_count: number;
  unconfirmed_count: number;
  upcoming_renewal_count: number;
  subscriptions: SubscriptionInsightItem[];
  increases: SubscriptionInsightItem[];
  unconfirmed: SubscriptionInsightItem[];
  upcoming: SubscriptionInsightItem[];
}

export interface MerchantRule {
  id: string;
  pattern: string;
  category_id: string;
  created_at: string;
  category_name?: string | null;
  category_color?: string | null;
  category_icon?: string | null;
  match_count?: number;
}

export interface MerchantRuleSuggestionPreview {
  id: string;
  date: string;
  amount: number;
  merchant_name: string;
  account_name?: string | null;
  category_name?: string | null;
  will_apply: boolean;
}

export interface MerchantRuleSuggestion {
  pattern: string;
  category_id: string;
  category_name: string;
  category_color?: string | null;
  category_icon?: string | null;
  categorized_count: number;
  uncategorized_count: number;
  confidence: number;
  affected_transaction_ids: string[];
  preview_transactions: MerchantRuleSuggestionPreview[];
  reason: string;
}

export type TransactionReviewQueueId =
  | 'ai_insights'
  | 'uncategorized'
  | 'rule_suggestions'
  | 'pending'
  | 'recurring_candidates'
  | 'duplicate_candidates'
  | 'transfer_candidates';

export interface TransactionReviewQueueSummary {
  id: TransactionReviewQueueId;
  label: string;
  count: number;
  action_label: string;
  severity: 'attention' | 'warning' | 'info';
  filters?: TransactionFilters;
}

export interface TransactionReviewSummary {
  total_open: number;
  queues: TransactionReviewQueueSummary[];
  rule_suggestions: MerchantRuleSuggestion[];
  recurring_candidates: RecurringPattern[];
  duplicate_candidates: DuplicateCandidateGroup[];
  transfer_candidates: TransferCandidatePair[];
  ai_drafts: AdvisorDraftAction[];
}

export type GoalType = 'savings' | 'debt';

export interface Goal {
  id: string;
  name: string;
  type: GoalType;
  target_amount: number;
  current_amount: number;
  starting_amount?: number | null;
  account_id?: string | null;
  target_date?: string | null;
  color?: string | null;
  is_archived: boolean;
  created_at: string;
  updated_at: string;
  progress_amount: number;
  remaining_amount: number;
  progress_percent: number;
  account_name?: string | null;
  institution_name?: string | null;
  account_balance?: number | null;
  account_is_liability?: boolean | null;
}



export interface SimplefinConnection {
  id: string;
  access_url: string;
  last_synced_at?: string | null;
  status: string;
  created_at: string;
}

export interface CoinbaseConnection {
  id: string;
  coinbase_user_id: string;
  display_name?: string | null;
  last_synced_at?: string | null;
  status: string;
  created_at: string;
}

export interface NetWorthSnapshot {
  id: string;
  date: string;
  total_assets: number;
  total_liabilities: number;
  net_worth: number;
  breakdown: string;
  is_estimated: boolean;
  created_at: string;
  liquid_assets?: number | null;
  investment_assets?: number | null;
  crypto_assets?: number | null;
}

export interface SyncEvent {
  type: 'sync_start' | 'sync_progress' | 'sync_complete' | 'sync_error';
  message: string;
  progress?: number;
  completedAt?: string;
}

export type SyncHealthStatus = 'empty' | 'healthy' | 'stale' | 'attention';
export type SyncHealthRecommendedAction = 'connect' | 'none' | 'sync' | 'reconnect' | 'retry';
export type SyncHealthFreshness = 'fresh' | 'stale' | 'never' | 'attention';

export interface SyncHealthConnection {
  id: string;
  provider: 'coinbase' | 'simplefin';
  institution_name: string;
  status: string;
  last_synced_at?: string | null;
  last_success_at?: string | null;
  last_attempted_at?: string | null;
  age_days?: number | null;
  account_count: number;
  is_stale: boolean;
  needs_attention: boolean;
  freshness: SyncHealthFreshness;
  status_label: string;
  status_detail: string;
  failure_reason?: string | null;
  recommended_action: SyncHealthRecommendedAction;
}

export interface SyncHealth {
  status: SyncHealthStatus;
  status_label: string;
  status_detail: string;
  connection_count: number;
  stale_count: number;
  attention_count: number;
  fresh_count: number;
  never_synced_count: number;
  last_synced_at?: string | null;
  connections: SyncHealthConnection[];
}

export type SyncRunScope = 'full' | 'coinbase' | 'simplefin_all';
export type SyncRunStatus = 'running' | 'succeeded' | 'partial' | 'failed';
export type SyncRunItemProvider = 'coinbase' | 'simplefin' | 'system';
export type SyncRunItemStatus = 'running' | 'succeeded' | 'skipped' | 'reauth_required' | 'failed';

export interface SyncRun {
  id: string;
  scope: SyncRunScope;
  status: SyncRunStatus;
  started_at: string;
  completed_at?: string | null;
  message?: string | null;
  error_code?: string | null;
  error_message?: string | null;
  recovery_action?: string | null;
  accounts_seen: number;
  transactions_added: number;
  transactions_modified: number;
  transactions_removed: number;
  transactions_skipped: number;
  duplicate_candidates: number;
  transfer_candidates: number;
}

export interface SyncRunItem {
  id: string;
  run_id: string;
  provider: SyncRunItemProvider;
  connection_id?: string | null;
  institution_name: string;
  status: SyncRunItemStatus;
  started_at: string;
  completed_at?: string | null;
  accounts_seen: number;
  transactions_added: number;
  transactions_modified: number;
  transactions_removed: number;
  transactions_skipped: number;
  error_code?: string | null;
  error_message?: string | null;
  recovery_action?: string | null;
}

export interface SyncChange {
  id: string;
  run_item_id: string;
  entity_type: 'account' | 'transaction' | 'investment' | 'recurring' | 'snapshot' | 'integrity';
  entity_id?: string | null;
  change_type: 'inserted' | 'updated' | 'deleted' | 'skipped' | 'detected';
  description: string;
  created_at: string;
}

export interface SyncRunDetail extends SyncRun {
  items: SyncRunItem[];
  changes: SyncChange[];
}

export interface DuplicateCandidateGroup {
  group_id: string;
  count: number;
  amount: number;
  date: string;
  merchant_name: string;
  account_name: string;
  transaction_ids: string[];
}

export interface TransferCandidatePair {
  pair_id: string;
  amount: number;
  date: string;
  from_account_name: string;
  to_account_name: string;
  outflow_transaction_id: string;
  inflow_transaction_id: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AiStreamEvent {
  type: 'chunk' | 'thinking_start' | 'thinking' | 'thinking_end' | 'done' | 'error';
  text?: string;
  message?: string;
}

export type InsightSeverity = 'critical' | 'warning' | 'positive' | 'info';

export interface Insight {
  id: string;
  severity: InsightSeverity;
  title: string;
  message: string;
  metric?: string;
  action_label?: string;
  action_route?: string;
}

export type DataQualityStatus = 'healthy' | 'review' | 'stale' | 'attention';

export interface DataQualityIssue {
  id: string;
  label: string;
  message: string;
  route: string;
  severity: InsightSeverity;
}

export interface DataQualitySummary {
  status: DataQualityStatus;
  status_label: string;
  status_detail: string;
  score: number;
  issues: DataQualityIssue[];
}

export interface AdvisorAction {
  id: string;
  label: string;
  route: string;
  prompt: string;
  reason: string;
  severity: InsightSeverity;
}

export type AdvisorIntent =
  | 'overview'
  | 'sync'
  | 'review'
  | 'budget'
  | 'recurring'
  | 'subscriptions'
  | 'goals'
  | 'investments'
  | 'imports'
  | 'reports'
  | 'insights'
  | 'quality';

export type AdvisorCitationKind =
  | 'account'
  | 'transaction'
  | 'budget'
  | 'goal'
  | 'recurring'
  | 'report'
  | 'sync'
  | 'review'
  | 'investment'
  | 'import'
  | 'data_quality'
  | 'insight';

export interface AdvisorCitation {
  id: string;
  kind: AdvisorCitationKind;
  label: string;
  detail?: string;
  route?: string;
  record_id?: string;
  amount?: number | null;
  date?: string | null;
}

export interface AdvisorToolStatus {
  id: string;
  label: string;
  status: 'available' | 'empty' | 'attention';
  count: number;
  route: string;
}

export type AdvisorDraftActionKind =
  | 'create_merchant_rule'
  | 'categorize_transaction'
  | 'update_budget'
  | 'update_goal_target'
  | 'confirm_recurring'
  | 'create_budget_group'
  | 'rename_budget_group'
  | 'assign_category_to_budget_group'
  | 'create_recurring_adjustment'
  | 'set_manual_cost_basis'
  | 'set_sector_metadata';

export interface AdvisorDraftChange {
  field: string;
  before: string | number | boolean | null;
  after: string | number | boolean | null;
}

export type AdvisorDraftPayload =
  | {
      kind: 'create_merchant_rule';
      pattern: string;
      category_id: string;
      apply_existing: boolean;
    }
  | {
      kind: 'categorize_transaction';
      transaction_id: string;
      category_id: string;
    }
  | {
      kind: 'update_budget';
      category_id: string;
      amount: number;
      period: 'monthly';
      rollover: boolean;
    }
  | {
      kind: 'update_goal_target';
      goal_id: string;
      target_amount: number;
    }
  | {
      kind: 'confirm_recurring';
      recurring_id: string;
    }
  | {
      kind: 'create_budget_group';
      name: string;
      color?: string | null;
    }
  | {
      kind: 'rename_budget_group';
      group_id: string;
      name: string;
    }
  | {
      kind: 'assign_category_to_budget_group';
      group_id: string;
      category_id: string;
    }
  | {
      kind: 'create_recurring_adjustment';
      recurring_id: string;
      original_date: string;
      action: RecurringAdjustmentAction;
      adjusted_date?: string | null;
      adjusted_amount?: number | null;
      note?: string | null;
    }
  | {
      kind: 'set_manual_cost_basis';
      holding_id: string;
      manual_cost_basis: number | null;
      note?: string | null;
    }
  | {
      kind: 'set_sector_metadata';
      security_id: string;
      sector: string | null;
      sector_source?: string | null;
    };

export interface AdvisorDraftAction {
  id: string;
  kind: AdvisorDraftActionKind;
  label: string;
  summary: string;
  route: string;
  payload: AdvisorDraftPayload;
  changes: AdvisorDraftChange[];
  citations: AdvisorCitation[];
  confirmation_required: true;
  status?: 'open' | 'confirmed' | 'dismissed';
  created_at?: string;
  updated_at?: string;
}

export interface AdvisorConfirmRequest {
  draft: AdvisorDraftAction;
  confirm: true;
}

export interface AdvisorConfirmResponse {
  success: boolean;
  message: string;
  changed: number;
  draft: AdvisorDraftAction;
  result?: unknown;
}

export interface AdvisorAnalysis {
  question: string;
  intent: AdvisorIntent;
  answer: string;
  generated_at: string;
  tools: AdvisorToolStatus[];
  citations: AdvisorCitation[];
  drafts: AdvisorDraftAction[];
}

export interface AdvisorContextResponse {
  context: string;
  configured: boolean;
  generated_at: string;
  sync_health: SyncHealth;
  actions: AdvisorAction[];
  tools: AdvisorToolStatus[];
}

export interface ApiResponse<T> {
  data: T;
}

export interface ApiError {
  error: string;
  details?: unknown[];
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}

export interface TransactionFilters {
  page?: number;
  limit?: number;
  accountId?: string[];
  categoryId?: string[];
  startDate?: string;
  endDate?: string;
  search?: string;
  minAmount?: number;
  maxAmount?: number;
  pending?: boolean;
  recurring?: boolean;
  uncategorized?: boolean;
  reviewStatus?: 'open' | 'reviewed' | 'dismissed';
  type?: string;
  sortBy?: 'date' | 'amount' | 'merchant';
  sortDir?: 'asc' | 'desc';
}

export interface CashflowReport {
  months: Array<{
    month: string;
    income: number;
    expenses: number;
    net: number;
  }>;
}

export interface SpendingReport {
  categories: Array<{
    category_id: string;
    category_name: string;
    color?: string | null;
    amount: number;
    percentage: number;
    children?: SpendingReport['categories'];
  }>;
  total: number;
}

export interface ReportMetricSummary {
  current: number;
  previous: number;
  delta: number;
  delta_percent: number | null;
}

export type ReportComparisonMode =
  | 'prior_period'
  | 'prior_month'
  | 'same_month_last_year'
  | 'trailing_3'
  | 'trailing_12';

export interface ReportCategoryChange {
  category_id: string;
  category_name: string;
  color?: string | null;
  current: number;
  previous: number;
  delta: number;
  delta_percent: number | null;
}

export interface ReportExcludedFlowSummary {
  flow_type: 'transfers' | 'investments' | 'crypto';
  count: number;
  inflows: number;
  outflows: number;
  net: number;
}

export interface ReportSummary {
  start_date?: string;
  end_date?: string;
  comparison: ReportComparisonMode;
  comparison_label: string;
  comparison_start_date?: string;
  comparison_end_date?: string;
  previous_start_date?: string;
  previous_end_date?: string;
  income: ReportMetricSummary;
  expenses: ReportMetricSummary;
  net: ReportMetricSummary;
  savings_rate: ReportMetricSummary;
  top_spending: ReportCategoryChange[];
  top_income: ReportCategoryChange[];
  spending_movers: ReportCategoryChange[];
  excluded_flows: ReportExcludedFlowSummary[];
}

export interface ReportDrilldown {
  kind: 'spending' | 'income';
  category_id: string;
  category_name: string;
  start_date?: string;
  end_date?: string;
  total: number;
  count: number;
  transactions: Transaction[];
}

export type ReportEvidenceKind = 'cashflow_month' | 'excluded_flow';

export interface ReportEvidenceDrilldown {
  kind: ReportEvidenceKind;
  label: string;
  start_date?: string;
  end_date?: string;
  month?: string;
  flow_type?: ReportExcludedFlowSummary['flow_type'];
  income: number;
  expenses: number;
  net: number;
  total: number;
  count: number;
  transactions: Transaction[];
}

export interface ReportNetWorthEvidenceAccount {
  account_id: string;
  account_name: string | null;
  institution_name: string | null;
  type: string | null;
  is_liability: boolean | null;
  balance: number;
}

export interface ReportNetWorthEvidence {
  kind: 'networth_snapshot';
  label: string;
  snapshot: NetWorthSnapshot;
  previous_snapshot: NetWorthSnapshot | null;
  delta: number | null;
  asset_delta: number | null;
  liability_delta: number | null;
  accounts: ReportNetWorthEvidenceAccount[];
}

export interface CredentialStatus {
  coinbase: boolean;
  coinbaseFromEnv: boolean;
  simplefin: boolean;
}

export interface CsvImportPreviewIssue {
  row_number: number;
  severity: 'error' | 'warning';
  field?: string;
  message: string;
}

export interface CsvImportPreviewRow {
  row_number: number;
  valid: boolean;
  date?: string;
  amount?: number;
  merchant_name?: string | null;
  original_name?: string;
  account_id?: string;
  account_name?: string;
  category_id?: string | null;
  category_name?: string | null;
  notes?: string | null;
  duplicate_candidate_count: number;
  transfer_candidate_count: number;
  balance_delta: number;
  issues: CsvImportPreviewIssue[];
}

export interface CsvImportPreview {
  rows: CsvImportPreviewRow[];
  valid_count: number;
  invalid_count: number;
  duplicate_candidate_count: number;
  transfer_candidate_count: number;
  balance_delta: number;
  errors: CsvImportPreviewIssue[];
  warnings: CsvImportPreviewIssue[];
}

export interface LocalBackupRestorePreviewTable {
  table: string;
  backup_rows: number;
  current_rows: number;
  restorable: boolean;
  missing_columns: string[];
  extra_columns: string[];
}

export interface LocalBackupRestorePreview {
  valid: boolean;
  app?: string;
  version?: number;
  exported_at?: string;
  table_count: number;
  restorable_table_count: number;
  total_rows: number;
  restorable_rows: number;
  tables: LocalBackupRestorePreviewTable[];
  errors: string[];
  warnings: string[];
}

export interface LocalBackupRestoreResult {
  restored_tables: number;
  restored_rows: number;
  skipped_tables: string[];
  warnings: string[];
}
