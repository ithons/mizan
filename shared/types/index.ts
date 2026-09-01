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
  | 'other'
  | 'closed';

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

/**
 * Where one point on an account's balance chart came from.
 *
 * - `ledger`: replayed from this account's own transactions off its current balance. Every point of
 *   a `ledger` basis series is this one, which is why that line never changes style mid-series.
 * - `measured`: a value a net-worth snapshot recorded. Only the snapshot basis produces these.
 * - `estimated`: a reverse-replay reconstruction stored as a snapshot, for months the ledger never
 *   reached. Only the snapshot basis produces these.
 */
export type BalancePointSource = 'ledger' | 'measured' | 'estimated';

export type BalanceSeriesBasis = 'ledger' | 'snapshot';

/** Why the series begins where it does. A chart that starts mid-air must say so. */
export type BalanceSeriesStart =
  | 'first_transaction'
  | 'backfill_floor'
  | 'requested_window'
  | 'snapshot_series'
  | 'no_ledger'
  | 'account_not_found';

export interface BalanceHistoryPoint {
  date: string;
  /** Net-worth signed: an asset's balance, or minus what a liability owes. Dollars at the API edge. */
  balance: number;
  source: BalancePointSource;
}

/** A balance a net-worth snapshot recorded for this account on one day inside the drawn window. */
export interface BalanceMeasurement {
  date: string;
  /**
   * What the snapshot recorded that day, net-worth signed like `BalanceHistoryPoint.balance` and in
   * dollars at the API edge. It is NOT a difference against the line and nothing here compares the
   * two: the chart draws it as a point on the line, so a divergence is seen rather than asserted.
   */
  balance: number;
}

export interface AccountBalanceHistory {
  basis: BalanceSeriesBasis;
  points: BalanceHistoryPoint[];
  start_date: string | null;
  start_reason: BalanceSeriesStart;
  /**
   * Measured snapshots falling inside the drawn window, to be marked as points on the line. Always
   * empty on the `snapshot` basis, where the measurements are already the line itself.
   */
  measurements: BalanceMeasurement[];
  /**
   * How many transactions built the drawn window, not how many the account has ever held.
   *
   * The name carries the window on purpose. A `from`/`to` clamp changes this count without changing
   * `start_reason`, so a caption that reads it as "this account's N transactions" is right only
   * while the window happens to be the whole ledger.
   */
  drawn_transaction_count: number;
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
  /**
   * Who decided this row's category (migration 041). NULL means the category was set before
   * provenance was tracked, which is most of the ledger and is not the same as "nobody".
   */
  category_source?: 'human' | 'rule' | 'heuristic' | 'ai' | null;
  /** The other half of the same question. Read with `category_source`, never instead of it. */
  manually_categorized?: boolean;
  /**
   * Who authored the amount this row holds (migration 048). 'human' means the owner corrected it
   * and `upsertSimplefinTransaction` will keep it rather than overwrite it on the next sync. NULL
   * means the author was never recorded, which is most of the ledger and is not the same as
   * "nobody".
   */
  amount_source?: 'provider' | 'human' | 'ai' | null;
  /**
   * What the institution still reports for this row, in dollars, when the owner corrected the
   * amount and the provider has since re-offered a different one. Null whenever there is no
   * standing disagreement, which includes "no sync has happened since the correction": absence
   * here means no later sync reported a different amount, never that the provider agrees.
   */
  provider_amount?: number | null;
  created_at: string;
  updated_at: string;
  // joined
  category_name?: string | null;
  category_color?: string | null;
  category_icon?: string | null;
  /** Whether the row's category is an income category, so a refund is not read as income. */
  category_is_income?: boolean | null;
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
  /** NULL when the provider did not say and the owner has not either; rendered "Unclassified". */
  type: 'equity' | 'etf' | 'mutual_fund' | 'crypto' | 'cash' | 'other' | null;
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
  /**
   * Coefficient of variation of this pattern's amounts. Patterns admitted on cadence alone (a
   * paycheck tracking hours, a utility bill) carry a high value here, and `average_amount` is only
   * a median for them, so surface it as approximate rather than as a known amount.
   */
  amount_variance?: number;
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
  /** True when the pattern's amount moves materially; `amount` is a median estimate, not a bill. */
  amount_varies?: boolean;
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
  /**
   * How many accounts the row could account for, out of how many it was written against. An
   * estimated month reaches only as far back as each account's own ledger, so an older point
   * covers fewer accounts than a newer one and the two are not comparable. NULL means the row
   * predates migration 044. Counts, not money: they stay integers through the dollar boundary.
   */
  covered_accounts?: number | null;
  total_accounts?: number | null;
}

export interface SyncEvent {
  // 'ai_pass_applied' is not a sync stage: a background AI pass runs AFTER the terminal
  // sync_complete has been emitted and the client has already refreshed, so a pass that
  // recategorizes rows leaves pre-AI totals on screen until something else invalidates them.
  // It is emitted only when a pass actually wrote something.
  type: 'sync_start' | 'sync_progress' | 'sync_complete' | 'sync_error' | 'ai_pass_applied';
  message: string;
  progress?: number;
  completedAt?: string;
  // Set on sync_complete. 'partial' means a stage failed after provider writes had already
  // committed: the run is over and the ledger moved, so the client must refresh on it exactly as
  // it would on a clean run, and say the run had issues.
  status?: 'succeeded' | 'partial';
  // Set on ai_pass_applied: the AiJobName (server/src/services/aiJobs.ts) whose pass wrote, and
  // how many actions it applied. Typed as a string rather than importing the job registry's union,
  // because this file is shared with the client and the registry is server-side.
  job?: string;
  applied?: number;
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

/**
 * The last sync run that reached a terminal state, read from `sync_runs`.
 *
 * It is on this payload because "did the run that wrote the current figures finish?" is a fact
 * about the database, and the only place it was previously readable was the live SSE event, which
 * exists for the length of one page session. A reload cleared it, so a balance sheet written by a
 * partial run read as fully calibrated from then on.
 */
export interface SyncHealthLastRun {
  id: string;
  status: SyncRunStatus;
  completed_at?: string | null;
  message?: string | null;
  /** The run ended 'partial' or 'failed': at least one stage did not complete. */
  incomplete: boolean;
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
  /** Null when no run has finished yet. Never inferred from connection state. */
  last_run: SyncHealthLastRun | null;
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
  type: 'chunk' | 'thinking_start' | 'thinking' | 'thinking_end' | 'tool_use' | 'done' | 'error';
  text?: string;
  message?: string;
  name?: string;
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

export interface DataQualityIssue {
  id: string;
  label: string;
  message: string;
  route: string;
  severity: InsightSeverity;
}

/**
 * Open conditions only. There is deliberately no score and no status verdict: a number out of 100
 * and the label derived from it stated a judgement where a measurement belongs, and both were still
 * readable through `GET /api/insights/quality` after the panel stopped rendering them.
 */
export interface DataQualitySummary {
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
  | 'retire_merchant_rule'
  | 'categorize_transaction'
  | 'update_budget'
  | 'update_goal_target'
  | 'confirm_recurring'
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
      /**
       * Retire one rule the MODEL wrote. `rule_id`, not a pattern: a pattern would have to be
       * resolved back to a row, and the resolution is fuzzy in this app by design.
       */
      kind: 'retire_merchant_rule';
      rule_id: string;
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

export type AdvisorAutonomy = 'autonomous' | 'proposal_only';

/**
 * One kind's autonomy, as the screens see it.
 *
 * The decision stays where it is argued: `DRAFT_KIND_AUTONOMY` in
 * `server/src/services/draftAutonomy.ts`. This is only the wire shape that carries it out, so the
 * owner-facing surfaces derive the boundary from the same table the model's prompt is generated
 * from. Settings used to keep its own `new Set([...])` of undoable kinds, which was a copy of the
 * autonomous set on the day it was written and stopped being one the day a kind was added.
 */
export interface AdvisorAutonomyEntry {
  kind: AdvisorDraftActionKind;
  autonomy: AdvisorAutonomy;
}

/** Every declared kind, in the order the table declares them. */
export interface AdvisorAutonomyResponse {
  kinds: AdvisorAutonomyEntry[];
}

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
  /**
   * True when the handler could prove it touched nothing: the state the draft proposes already
   * held. Not an applied change, and callers must not count or toast it as one.
   */
  wroteNothing?: boolean;
}

/**
 * The four kinds a memory may take, all of them dispositional. There is deliberately no
 * 'observation' or 'fact' member, which says what the store is for; it does not stop a number
 * appearing inside a statement, and nothing does. What keeps a stale figure harmless is that
 * aiContext.ts prints every statement with the date it was recorded.
 */
export type AiMemoryKind = 'preference' | 'constraint' | 'intent' | 'interpretation';

/** What class of thing a statement is about. 'household' is the owner's finances as a whole. */
export type AiMemoryScope = 'household' | 'account' | 'category' | 'merchant' | 'goal';

/** A statement this one replaced. Kept so a belief that changed shows what it used to be. */
export interface AiMemoryPriorStatement {
  id: string;
  statement: string;
  evidence: string;
  superseded_at: string;
}

export interface AiMemory {
  id: string;
  scope: AiMemoryScope;
  /** Null exactly when scope is 'household'. */
  subject: string | null;
  statement: string;
  kind: AiMemoryKind;
  /** What was observed to conclude the statement. Not rendered into the prompt; readable by SQL. */
  evidence: string;
  evidence_count: number;
  source: 'owner' | 'ai';
  created_at: string;
  /** Newest first. Empty for a statement that has never been revised. */
  prior_statements: AiMemoryPriorStatement[];
}

export interface AiMemoryInput {
  scope: AiMemoryScope;
  subject?: string | null;
  statement: string;
  kind: AiMemoryKind;
  evidence: string;
  evidence_count?: number;
}

/**
 * A revision replaces the statement and states fresh evidence for the change. Scope, subject and
 * kind carry over from the entry being replaced unless given: a belief that changed its subject is
 * a different belief and belongs in its own entry.
 */
export interface AiMemoryRevision {
  statement: string;
  evidence: string;
  kind?: AiMemoryKind;
  evidence_count?: number;
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
  /** Which credential form the SDK resolved. Never the secret itself. */
  credential_source?: AdvisorCredentialSource;
  generated_at: string;
  sync_health: SyncHealth;
  actions: AdvisorAction[];
  tools: AdvisorToolStatus[];
}

// The union of every effort ladder the offered models accept. NOT every model takes every
// level: Gemini's dial has three rungs with these names and no `xhigh` or `max`, and Haiku
// 4.5 has none at all. The request shape is derived per model in advisorSettings.ts, and the
// per-model `efforts` list below is what a dial must render from.
export type AdvisorEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type AiProviderId = 'anthropic' | 'openai' | 'gemini';

/** How a provider's credential was found. `stored` means `.mizan/credentials.json`. */
export type AdvisorCredentialSource = 'env' | 'oauth_profile' | 'stored' | 'none';

/**
 * One offered model, with the facts a surface needs to render only knobs that exist.
 *
 * `efforts` is per model rather than per provider on purpose: an effort dial that is not
 * rendered for a model with no effort ladder is better than one that silently does nothing.
 */
export interface AdvisorModelOption {
  id: string;
  label: string;
  provider: AiProviderId;
  /** False when this provider has no credential; picking it would fail at the first question. */
  configured: boolean;
  /** Whether reasoning is configurable and its summary streams. */
  reasoning: boolean;
  efforts: AdvisorEffort[];
  context_window: number;
  max_output_tokens: number;
  /** What caching this model gets and what it costs, said before the owner picks it. */
  caching_note: string;
}

export interface AdvisorProviderStatus {
  id: AiProviderId;
  configured: boolean;
  credential_source: AdvisorCredentialSource;
}

/** A fixed-purpose job and the model serving it, which need not share the advisor's provider. */
export interface AdvisorJobAssignment {
  job: string;
  model: string;
  effort: AdvisorEffort | null;
  provider: AiProviderId;
  /**
   * False when the assigned model's provider has no credential. The job then skips before it
   * writes an `ai_runs` row, so there is no run, no digest entry and no error anywhere else:
   * this flag is the only surface that state reaches.
   */
  configured: boolean;
  available: Array<{ id: string; label: string; provider: AiProviderId; configured: boolean }>;
}

// Advisor chat model/effort configuration. The option lists are server-authoritative (the
// model is whitelisted so a tampered client can't point it at an arbitrary string, which
// matters more now that every provider SDK widens its model parameter to `string`); the
// client renders its controls from them.
export interface AdvisorSettings {
  model: string;
  effort: AdvisorEffort;
  available: {
    models: AdvisorModelOption[];
    /** The union of every ladder. Prefer the selected model's own `efforts`. */
    efforts: AdvisorEffort[];
    providers: AdvisorProviderStatus[];
  };
  jobs: AdvisorJobAssignment[];
}

export interface AdvisorSettingsUpdate {
  model?: string;
  effort?: AdvisorEffort;
  /** Job name to model id. Cross-provider tiering is a feature, not an accident. */
  jobs?: Record<string, string>;
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
  /** Exactly these rows. Capped by the server; see MAX_ID_FILTER in routes/transactions.ts. */
  ids?: string[];
  /** `category_source` values to keep. 'none' selects the rows recorded before provenance was. */
  categorySource?: Array<'human' | 'rule' | 'heuristic' | 'ai' | 'none'>;
  duplicateStatus?: 'none' | 'candidate' | 'dismissed';
  transferStatus?: 'none' | 'candidate' | 'confirmed' | 'dismissed';
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

export interface NullableMetricSummary {
  current: number | null;
  previous: number | null;
  delta: number | null;
  delta_percent: number | null;
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
  /**
   * Null when the window has no income: a rate of "saved out of nothing" has no value, and
   * reporting 0 for it said "you saved nothing" about a month whose pay had not arrived yet.
   */
  savings_rate: NullableMetricSummary;
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

export interface TopMerchant {
  merchant: string;
  transaction_count: number;
  total: number;
  last_date: string;
  category_name: string | null;
}

export interface TopMerchantsReport {
  merchants: TopMerchant[];
  /** Total reportable spend in the window, so a merchant's share can be shown. */
  total: number;
}

export interface NetWorthAttributionAccount {
  account_id: string;
  account_name: string | null;
  institution_name: string | null;
  type: string | null;
  is_liability: boolean | null;
  start_balance: number;
  end_balance: number;
  delta: number;
}

export interface NetWorthAttribution {
  start_date: string;
  end_date: string;
  start_net_worth: number;
  end_net_worth: number;
  delta: number;
  /** Non-zero movers only, largest absolute move first. */
  accounts: NetWorthAttributionAccount[];
}

export interface CategoryTrendReport {
  months: string[];
  series: Array<{
    category_id: string;
    category_name: string;
    color: string | null;
    values: number[];
  }>;
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
  /** False when the backup predates the table; it is then restored empty rather than rejected. */
  present_in_backup: boolean;
  missing_columns: string[];
  extra_columns: string[];
}

export interface LocalBackupRestorePreview {
  valid: boolean;
  app?: string;
  version?: number;
  exported_at?: string;
  /** Tables the restore covers. The denominator of the N/M the preview reports. */
  table_count: number;
  /** Covered tables the backup supplies and that restore as-is. The numerator. */
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

/**
 * "Free to spend" and every claim subtracted to get there, in DOLLARS (the API boundary).
 *
 * `free` is signed on purpose: a negative value means the claims on the liquid pool exceed it, and
 * that is the most important thing this number can say. The previous client-side version clamped it
 * at zero, so "you are $400 short" and "you have nothing spare" rendered identically.
 */
export interface SafeToSpend {
  liquid: number;
  card_balances: number;
  upcoming_bills: number;
  allocated_budgets: number;
  allocated_goals: number;
  free: number;
  forecast_days: number;
}

/* --- Does the ledger explain the balances? (GET /api/insights/reconciliation) --- */

/** One account's balance against the transactions that should explain it. Money in DOLLARS. */
export interface ReconciliationAccountReading {
  account_id: string;
  account_name: string;
  is_liability: boolean;
  is_market_driven: boolean;
  window_count: number;
  first_date: string | null;
  last_date: string | null;
  observed_delta: number;
  explained_delta: number;
  residual: number;
  boundary_amount: number;
  adjusted_residual: number;
  direction_conflict: boolean;
  largest_window_residual: number;
  residual_ratio: number | null;
}

/** Two accounts whose rows do not explain each other. Money in DOLLARS. */
export interface FlowConservationReading {
  account_a_id: string;
  account_a_name: string | null;
  account_b_id: string;
  account_b_name: string | null;
  leg_count: number;
  first_date: string;
  last_date: string;
  movement: number;
}

export interface ReconciliationReading {
  accounts: ReconciliationAccountReading[];
  /** The subset judged unexplained. Empty is the healthy state and must render as silence. */
  unreconciled: ReconciliationAccountReading[];
  /** Magnitude summed over `unreconciled` only, so opposite directions cannot cancel. */
  unreconciled_residual: number;
  /** Raw residual over EVERY account, including market-driven ones the filter exempts. */
  residual_all_accounts: number;
  measured_snapshot_count: number;
  flow_conservation: FlowConservationReading[];
}

/* --- What the AI changed (GET /api/ai/digest) --- */

/**
 * `standing` the AI's category is what the row holds now; `superseded` a later write replaced it;
 * `reverted` this revision has already been undone.
 */
export type AiDigestRowStatus = 'standing' | 'superseded' | 'reverted';

/**
 * Why a revert-since would leave a row alone. Each is read off the revision log, not guessed.
 *
 * `changed_since` means something OUTSIDE this action now stands where this write did.
 * `replaced_by_same_action` means the action itself wrote the row again later, so undoing it
 * restores the second write's prior value rather than this one. Folding the second into the first
 * told the owner someone had changed a row that only the AI's own action had touched.
 */
export type AiDigestBlockedReason = 'already_reverted' | 'changed_since' | 'replaced_by_same_action';

/** One transaction the AI recategorized, with the value it displaced. Amounts are DOLLARS. */
export interface AiDigestRow {
  revision_id: string;
  transaction_id: string;
  date: string;
  merchant: string;
  account_name: string | null;
  /** Negative means money left the account. */
  amount: number;
  before_category_id: string | null;
  /** Null with a non-null id means the category has since been deleted. */
  before_category_name: string | null;
  after_category_id: string | null;
  after_category_name: string | null;
  status: AiDigestRowStatus;
  /** True when the revert this digest describes would put this row back. */
  revertable: boolean;
  blocked_reason: AiDigestBlockedReason | null;
  /** `category_source` stamped on the write that now stands where this one did. */
  changed_since_by_source: string | null;
  changed_since_by_action_id: string | null;
}

export interface AiDigestRule {
  rule_id: string;
  pattern: string;
  category_id: string | null;
  category_name: string | null;
  source: string;
  retired_at: string | null;
}

export interface AiDigestRuleRevision {
  rule_id: string;
  pattern: string;
  operation: 'create' | 'recategorize' | 'rename' | 'retire';
  from_category_id: string | null;
  from_category_name: string | null;
  to_category_id: string | null;
  to_category_name: string | null;
  created_at: string;
}

/** An `ai_feedback` row (migration 047): the owner already answered this action. */
export interface AiDigestFeedback {
  signal: string;
  owner_choice: string;
  affected_transactions: number;
  created_at: string;
}

/**
 * Why an action has no transaction rows in the revision log, when it has none.
 *
 * `rows` the log holds rows for it. `no_rows_changed` the action was applied while the log
 * existed and wrote no transaction row, so "it changed nothing" is a fact about the action, not a
 * gap: `create_merchant_rule` is autonomous and a rule matching no settled transaction applies
 * cleanly. `unrecorded` the action predates the log (or the log's start cannot be read), so what it
 * changed row by row was never written down and cannot be stated either way.
 *
 * The boundary is `schema_migrations.applied_at` for the migration that created the log, read at
 * digest time. Nothing here asserts WHY a given pre-migration action has no rows.
 */
export type AiDigestRecordState = 'rows' | 'no_rows_changed' | 'unrecorded';

/**
 * `none` means rows exist and every one of them is blocked. The other two are the no-rows cases and
 * mirror `AiDigestRecordState`: `nothing_to_revert` is an action that changed no rows, `unrecorded`
 * is an action whose row-level effect was never recorded.
 */
export type AiDigestRevertScope = 'full' | 'partial' | 'none' | 'nothing_to_revert' | 'unrecorded';

export interface AiDigestAction {
  action_id: string;
  kind: string;
  label: string;
  summary: string;
  source: 'worker_auto' | 'user_confirm';
  created_at: string;
  rows: AiDigestRow[];
  /** The merchant rule this action wrote, as it stands now. Null when no rule points at it. */
  rule: AiDigestRule | null;
  rule_revisions: AiDigestRuleRevision[];
  owner_feedback: AiDigestFeedback[];
  record_state: AiDigestRecordState;
  standing_rows: number;
  revertable_rows: number;
  blocked_rows: number;
  /**
   * Rule retirements this action made that undo can still take back.
   *
   * Separate from `revertable_rows` because it is not a row of the ledger. `retire_merchant_rule`
   * is autonomous precisely because it changes no transaction, so an action can have zero
   * revertable rows and still have something to put back.
   */
  revertable_rules: number;
  revert_scope: AiDigestRevertScope;
}

export interface AiDigest {
  since: string | null;
  generated_at: string;
  /** The action cap this digest was built with. Echoed so a revert can name the same population. */
  action_limit: number;
  /** True when more actions fall in the window than were returned. */
  truncated: boolean;
  action_count: number;
  /** Actions applied while the revision log existed that changed no transaction row. */
  actions_that_changed_no_rows: number;
  /** Actions whose row-level effect was never recorded. Not the same fact as the line above. */
  actions_unrecorded: number;
  row_count: number;
  standing_rows: number;
  revertable_rows: number;
  /** Rule retirements across the window that undo can still take back. */
  revertable_rules: number;
  /**
   * Split on purpose. A row the owner already put back and a row someone else has since changed are
   * both unreachable, and copy that folds them into one number tells the owner their own undo was
   * somebody else's edit.
   */
  already_reverted_rows: number;
  changed_since_rows: number;
  replaced_within_action_rows: number;
  actions: AiDigestAction[];
}

export interface AiDigestRevertActionOutcome {
  action_id: string;
  label: string;
  planned_rows: number;
  reverted_rows: number;
  planned_rules: number;
  reverted_rules: number;
}

export interface AiDigestRevertResult {
  since: string;
  /** The action cap the revert planned against. Equal to the digest's `action_limit` when they agree. */
  action_limit: number;
  planned_rows: number;
  reverted_rows: number;
  planned_rules: number;
  reverted_rules: number;
  /** Rows the plan never claimed, split by why. Restated so the result cannot read as complete. */
  already_reverted_rows: number;
  changed_since_rows: number;
  replaced_within_action_rows: number;
  actions: AiDigestRevertActionOutcome[];
  /** Populated when an action restored a different number of rows than the plan expected. */
  discrepancies: string[];
}

// ---------------------------------------------------------------------------
// SimpleFIN re-link (services/simplefinRelink.ts, migration 055)
// ---------------------------------------------------------------------------
//
// When a provider re-mints its account ids, the sync stops before writing and asks. These are the
// API-edge shapes: money is DOLLARS here, converted exactly once by `toRelinkProposalView`, while
// the service and the stored snapshots stay in integer cents like the rest of the schema.

/** How much the evidence behind a proposed pair carries. Three words, never a score. */
export type SimplefinRelinkPairStrength = 'exact' | 'strong' | 'inferred';

/** The specific comparisons that produced (or failed to produce) a pairing. */
export type SimplefinRelinkPairEvidence =
  | 'institution_name_match'
  | 'institution_name_differs'
  | 'account_name_match'
  | 'account_number_mask_match'
  | 'account_name_similar'
  | 'currency_match'
  | 'currency_differs'
  | 'balance_match'
  | 'sole_unmatched_at_institution';

export type SimplefinRelinkUnpairedReason = 'no_candidate' | 'ambiguous';

export type SimplefinRelinkProposalStatus = 'pending' | 'applied' | 'dismissed';

/** Only the two reportable outcomes are ever persisted; `none` is the silent healthy case. */
export type SimplefinRelinkOutcome = 'relink' | 'partial';

export interface SimplefinRelinkProviderAccountView {
  provider_account_id: string;
  name: string;
  institution_name: string;
  currency: string;
  /** Dollars, as the provider reported them, with no liability negation applied. Null if unparseable. */
  balance: number | null;
}

export interface SimplefinRelinkStoredAccountView {
  account_id: string;
  /** The provider id the row was carrying when the proposal was raised. */
  simplefin_account_id: string;
  account_name: string;
  institution_name: string;
  currency: string;
  type: string;
  /** Dollars. Positive-as-owed for a liability, and legitimately negative when the card is in credit. */
  balance: number;
  is_liability: boolean;
}

export interface SimplefinRelinkPairView {
  stored_account_id: string;
  stored_account_name: string;
  stored_institution_name: string;
  stored_simplefin_account_id: string;
  provider_account_id: string;
  provider_account_name: string;
  provider_institution_name: string;
  strength: SimplefinRelinkPairStrength;
  evidence: SimplefinRelinkPairEvidence[];
  /** The sentence the owner confirms against. It restates what was compared, never a likelihood. */
  reason: string;
}

export interface SimplefinRelinkUnpairedStoredView {
  account_id: string;
  account_name: string;
  institution_name: string;
  simplefin_account_id: string;
  /** Dollars. */
  balance: number;
  is_liability: boolean;
  reason_code: SimplefinRelinkUnpairedReason;
  reason: string;
}

export interface SimplefinRelinkUnpairedProviderView {
  provider_account_id: string;
  name: string;
  institution_name: string;
  currency: string;
  /** Dollars. Null if the provider sent a balance that did not parse. */
  balance: number | null;
  reason_code: SimplefinRelinkUnpairedReason;
  reason: string;
}

export interface SimplefinRelinkAppliedPairView {
  stored_account_id: string;
  provider_account_id: string;
  previous_simplefin_account_id: string | null;
  outcome: 'adopted' | 'already_adopted';
}

export interface SimplefinRelinkProposalView {
  id: string;
  detected_at: string;
  outcome: SimplefinRelinkOutcome;
  status: SimplefinRelinkProposalStatus;
  headline: string;
  recovery_action: string;
  /** The screen the owner resolves this on, and its path. One copy, generated from the service. */
  resolve_on: string;
  resolve_on_path: string;
  provider_accounts: SimplefinRelinkProviderAccountView[];
  stored_accounts: SimplefinRelinkStoredAccountView[];
  pairs: SimplefinRelinkPairView[];
  /**
   * Reported on both sides on purpose. An account genuinely closed at the bank has no partner and
   * never will, so leaving it unpaired has to be a sayable outcome rather than a blocked one.
   */
  unpaired_stored: SimplefinRelinkUnpairedStoredView[];
  unpaired_provider: SimplefinRelinkUnpairedProviderView[];
  resolved_at: string | null;
  applied_pairs: SimplefinRelinkAppliedPairView[] | null;
  dismissed_reason: string | null;
}

/** Request body for confirming a pairing. Pairs are confirmed explicitly; none is applied silently. */
export interface SimplefinRelinkAdoptRequest {
  pairs: Array<{ stored_account_id: string; provider_account_id: string }>;
}

/**
 * What a stored account is carrying right now, read live off the row rather than out of the
 * proposal's snapshot.
 *
 * The snapshot records what the row looked like when the response arrived; these four fields are
 * what adoption is protecting, and the owner is confirming against the row as it stands. An account
 * the proposal names but that is no longer in the ledger has no entry here at all, which is how the
 * screen says so rather than rendering zeros.
 */
export interface SimplefinRelinkStoredCarryView {
  account_id: string;
  transaction_count: number;
  /** Earliest transaction date on the row. Null when the row carries no transactions. */
  first_transaction_date: string | null;
  /** The line below which manual history owns this account. Null when none is set. */
  backfill_floor_date: string | null;
  /** 'manual' when the owner set it, 'auto' when it was guessed. */
  type_source: string;
  name_source: string;
}

/** `proposal` is null exactly when nothing is pending, and the screen renders nothing at all. */
export interface SimplefinRelinkPendingResponse {
  proposal: SimplefinRelinkProposalView | null;
  carries: SimplefinRelinkStoredCarryView[];
}

export interface SimplefinRelinkAdoptResponse {
  proposal: SimplefinRelinkProposalView;
  adopted: SimplefinRelinkAppliedPairView[];
  /** Stored accounts the proposal named that this confirmation deliberately did not pair. */
  left_unpaired_stored_account_ids: string[];
  /** Provider ids from the snapshot no account adopted. */
  left_unpaired_provider_account_ids: string[];
}

/** Dismissal states a reason, because "these are new accounts" is a claim the owner is making. */
export interface SimplefinRelinkDismissRequest {
  reason: string;
}

export interface SimplefinRelinkDismissResponse {
  proposal: SimplefinRelinkProposalView;
  acknowledged_provider_ids: string[];
}
