export type ConnectionType = 'plaid' | 'coinbase' | 'manual';

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
  plaid_account_id?: string | null;
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
  plaid_transaction_id?: string | null;
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
  source_type: 'plaid' | 'coinbase' | 'manual' | 'import';
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

export interface InvestmentTransaction {
  id: string;
  plaid_investment_transaction_id?: string | null;
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
  plaid_security_id?: string | null;
  ticker?: string | null;
  name: string;
  type: 'equity' | 'etf' | 'mutual_fund' | 'crypto' | 'cash' | 'other';
  currency: string;
}

export interface Holding {
  id: string;
  account_id: string;
  security_id: string;
  quantity: number;
  institution_price: number;
  institution_value: number;
  cost_basis?: number | null;
  currency: string;
  updated_at: string;
  // joined
  ticker?: string | null;
  security_name?: string | null;
  security_type?: string | null;
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
  forecast_confidence?: 'none' | 'confirmed' | 'likely' | 'uncertain';
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

export interface MerchantRuleSuggestion {
  pattern: string;
  category_id: string;
  category_name: string;
  category_color?: string | null;
  category_icon?: string | null;
  categorized_count: number;
  uncategorized_count: number;
  confidence: number;
}

export type TransactionReviewQueueId =
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

export interface PlaidItem {
  id: string;
  item_id: string;
  institution_id?: string | null;
  institution_name: string;
  cursor?: string | null;
  last_synced_at?: string | null;
  products?: string | null;
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
  provider: 'plaid' | 'coinbase';
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

export type SyncRunScope = 'full' | 'plaid_item' | 'plaid_all' | 'coinbase';
export type SyncRunStatus = 'running' | 'succeeded' | 'partial' | 'failed';
export type SyncRunItemProvider = 'plaid' | 'coinbase' | 'system';
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
  type: 'chunk' | 'done' | 'error';
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

export interface AdvisorContextResponse {
  context: string;
  configured: boolean;
  generated_at: string;
  sync_health: SyncHealth;
  actions: AdvisorAction[];
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

export interface NetWorthHistory {
  snapshots: NetWorthSnapshot[];
}

export interface CredentialStatus {
  plaid: boolean;
  plaidEnvironment: 'sandbox' | 'production' | null;
  plaidFromEnv: boolean;
  coinbase: boolean;
  coinbaseFromEnv: boolean;
}
