import type {
  Account,
  AccountBalanceHistory,
  AdvisorAnalysis,
  AdvisorAutonomyResponse,
  AdvisorConfirmResponse,
  AdvisorContextResponse,
  AdvisorDraftAction,
  AdvisorSettings,
  AdvisorSettingsUpdate,
  AdvisorProviderStatus,
  AiProviderId,
  AiDigest,
  AiDigestRevertResult,
  AiMemory,
  AiMemoryInput,
  AiMemoryRevision,
  AiStreamEvent,
  AppPreference,
  Budget,
  BudgetRolloverLedgerEntry,
  CashflowReport,
  Category,
  CategoryTrendReport,
  ChatMessage,
  CredentialStatus,
  CsvImportPreview,
  DataImportRun,
  DataQualitySummary,
  Goal,
  Holding,
  HoldingHistoryPoint,
  Insight,
  LocalBackupRestorePreview,
  LocalBackupRestoreResult,
  MerchantRule,
  MerchantRuleSuggestion,
  NetWorthAttribution,
  NetWorthSnapshot,
  PaginatedResponse,
  RecurringForecast,
  RecurringOccurrenceAdjustment,
  RecurringPattern,
  ReportComparisonMode,
  ReportSummary,
  SafeToSpend,
  Security,
  SpendingReport,
  SubscriptionInsights,
  SyncHealth,
  SyncRun,
  SyncRunDetail,
  TopMerchantsReport,
  Transaction,
  TransactionFilters,
  TransactionReviewSummary,
  TransactionUpdateResult,
} from '@shared/types';

async function apiFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });

  if (!res.ok) {
    let errMsg = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      errMsg = body.error || errMsg;
    } catch (err) {
      console.warn('Failed to parse API error response', err);
    }
    throw new Error(errMsg);
  }

  // Handle 204 No Content
  if (res.status === 204) {
    return undefined as unknown as T;
  }

  // A 200 with a non-JSON body (e.g. the Vite dev middleware serving index.html for an unknown
  // /api path) would otherwise throw a cryptic "Unexpected token '<'".
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new Error(`Unexpected non-JSON response from ${url}`);
  }
  // Unwrap { data: ... } envelope if present
  if (json && typeof json === 'object' && 'data' in json) {
    return json.data as T;
  }
  return json as T;
}

// ─── Accounts ───────────────────────────────────────────────────────────────

export const accountsApi = {
  list: () => apiFetch<Account[]>('/api/accounts'),
  history: (id: string) => apiFetch<AccountBalanceHistory>(`/api/accounts/${id}/history`),
  createManual: (body: {
    account_name: string;
    type: string;
    current_balance: number;
    currency?: string;
    institution_name?: string;
    is_liability?: boolean;
  }) =>
    apiFetch<Account>('/api/accounts/manual', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  update: (id: string, body: Partial<Account>) =>
    apiFetch<Account>(`/api/accounts/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  delete: (id: string) =>
    apiFetch<void>(`/api/accounts/${id}`, { method: 'DELETE' }),
  merge: (body: { targetAccountId: string; sourceAccountId: string }) =>
    apiFetch<void>('/api/accounts/merge', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
};

// ─── Transactions ────────────────────────────────────────────────────────────

export const transactionsApi = {
  list: (params: TransactionFilters = {}) => {
    const q = new URLSearchParams();
    if (params.page) q.set('page', String(params.page));
    if (params.limit) q.set('limit', String(params.limit));
    if (params.startDate) q.set('startDate', params.startDate);
    if (params.endDate) q.set('endDate', params.endDate);
    if (params.search) q.set('search', params.search);
    if (params.minAmount != null) q.set('minAmount', String(params.minAmount));
    if (params.maxAmount != null) q.set('maxAmount', String(params.maxAmount));
    if (params.pending != null) q.set('pending', String(params.pending));
    if (params.recurring != null) q.set('recurring', String(params.recurring));
    if (params.uncategorized != null) q.set('uncategorized', String(params.uncategorized));
    if (params.reviewStatus) q.set('reviewStatus', params.reviewStatus);
    if (params.type) q.set('type', params.type);
    if (params.sortBy) q.set('sortBy', params.sortBy);
    if (params.sortDir) q.set('sortDir', params.sortDir);
    if (params.duplicateStatus) q.set('duplicateStatus', params.duplicateStatus);
    if (params.transferStatus) q.set('transferStatus', params.transferStatus);
    params.accountId?.forEach((id) => q.append('accountId', id));
    params.categoryId?.forEach((id) => q.append('categoryId', id));
    params.categorySource?.forEach((s) => q.append('categorySource', s));
    // Sent even when empty: `ids: []` asks for those zero rows, and dropping the param would ask
    // for the whole ledger instead. `undefined` is how a caller says "no id filter".
    params.ids?.forEach((id) => q.append('id', id));
    if (params.ids?.length === 0) q.set('id', '');
    return apiFetch<PaginatedResponse<Transaction>>(`/api/transactions?${q.toString()}`);
  },
  review: () => apiFetch<TransactionReviewSummary>('/api/transactions/review'),
  get: (id: string) => apiFetch<Transaction>(`/api/transactions/${id}`),
  createManual: (body: Partial<Transaction>) =>
    apiFetch<Transaction>('/api/transactions/manual', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  update: (id: string, body: Partial<Transaction>) =>
    apiFetch<TransactionUpdateResult>(`/api/transactions/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  /**
   * Set a row aside, or bring it back. The Ledger's row action column is the only caller.
   *
   * The server's `TransactionReviewStatusSchema` also accepts `'reviewed'`, and nothing here sends
   * it, because nothing needs to: `updateTransaction` and `bulkCategorizeTransactions` already set
   * `review_status = 'reviewed'` as a side effect of filing a row
   * (server/src/services/transactions.ts, server/src/services/categoryWrites.ts). Offering it as a
   * button would be a second way to say what categorizing already says.
   *
   * `'dismissed'` is the one state nothing else can reach, and three server queries read it:
   * `getCounts` in services/transactionReview.ts, the worker's uncategorized pull in
   * services/aiWorker.ts, and `draftLiveness` in services/advisorDrafts.ts all exclude it. Without
   * a caller those three clauses can never fire and the "needs a category" queue has no exit but
   * categorizing.
   */
  markReview: (id: string, status: 'open' | 'dismissed') =>
    apiFetch<Transaction>(`/api/transactions/${id}/review`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    }),
  // Resolve as a real duplicate: keep one copy, exclude the rest from reports.
  confirmDuplicateGroup: (groupId: string, keepId: string) =>
    apiFetch<{ excluded: number }>(
      `/api/transactions/duplicates/${encodeURIComponent(groupId)}/confirm`,
      { method: 'POST', body: JSON.stringify({ keepId }) }
    ),
  dismissDuplicateGroup: (groupId: string) =>
    apiFetch<{ updated: number }>(`/api/transactions/duplicates/${encodeURIComponent(groupId)}/dismiss`, {
      method: 'POST',
    }),
  confirmTransferPair: (pairId: string) =>
    apiFetch<{ updated: number }>(`/api/transactions/transfers/${encodeURIComponent(pairId)}/confirm`, {
      method: 'POST',
    }),
  dismissTransferPair: (pairId: string) =>
    apiFetch<{ updated: number }>(`/api/transactions/transfers/${encodeURIComponent(pairId)}/dismiss`, {
      method: 'POST',
    }),
  delete: (id: string) =>
    apiFetch<void>(`/api/transactions/${id}`, { method: 'DELETE' }),
  bulkCategory: (ids: string[], categoryId: string) =>
    apiFetch<void>('/api/transactions/bulk-category', {
      method: 'POST',
      body: JSON.stringify({ ids, categoryId }),
    }),
};

// ─── Investments ─────────────────────────────────────────────────────────────

export const investmentsApi = {
  holdings: () => apiFetch<Holding[]>('/api/investments/holdings'),
  holdingsByAccount: (accountId: string) =>
    apiFetch<Holding[]>(`/api/investments/holdings/${accountId}`),
  holdingHistory: (holdingId: string, days?: number) =>
    apiFetch<HoldingHistoryPoint[]>(`/api/investments/holdings/${holdingId}/history${days ? `?days=${days}` : ''}`),
  updateHoldingCostBasis: (
    holdingId: string,
    body: { manual_cost_basis: number | null; manual_cost_basis_note?: string | null }
  ) =>
    apiFetch<Holding>(`/api/investments/holdings/${holdingId}/cost-basis`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  updateSecurityMetadata: (
    securityId: string,
    body: { sector: string | null; sector_source?: string | null }
  ) =>
    apiFetch<Security>(`/api/investments/securities/${securityId}/metadata`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
};

// ─── Categories ──────────────────────────────────────────────────────────────

/** Flatten a nested category tree into a single sorted array (parents before children). */
export function flattenCategories(cats: import('@shared/types').Category[]): import('@shared/types').Category[] {
  const result: import('@shared/types').Category[] = [];
  for (const cat of cats) {
    result.push(cat);
    if (cat.children?.length) {
      result.push(...flattenCategories(cat.children));
    }
  }
  return result;
}

export function collectCategoryAndDescendantIds(cats: Category[], categoryId: string): string[] {
  for (const cat of cats) {
    if (cat.id === categoryId) {
      return flattenCategories([cat]).map((category) => category.id);
    }

    const childMatch = collectCategoryAndDescendantIds(cat.children ?? [], categoryId);
    if (childMatch.length > 0) return childMatch;
  }

  return [];
}

export const categoriesApi = {
  list: () => apiFetch<Category[]>('/api/categories'),
  create: (body: Partial<Category>) =>
    apiFetch<Category>('/api/categories', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  update: (id: string, body: Partial<Category>) =>
    apiFetch<Category>(`/api/categories/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  delete: (id: string) =>
    apiFetch<void>(`/api/categories/${id}`, { method: 'DELETE' }),
  merge: (sourceId: string, targetId: string) =>
    apiFetch<void>(`/api/categories/${sourceId}/merge`, {
      method: 'POST',
      body: JSON.stringify({ targetId }),
    }),
};

// ─── Rules ──────────────────────────────────────────────────────────────────

/**
 * One approval the server would not honour, and why.
 *
 * Named rather than left inline because the screen has to render it: an approval of N suggestions
 * that quietly saves N-2 rules is a partial success reported as a whole one. The two reasons are
 * what `approveMerchantRuleSuggestions` (server/src/services/rules.ts) emits, and both mean the
 * page was looking at something the database no longer holds.
 */
export interface RuleApprovalSkip {
  pattern: string;
  reason: 'unknown_pattern' | 'unknown_category';
}

export const rulesApi = {
  list: () => apiFetch<MerchantRule[]>('/api/rules'),
  suggestions: () => apiFetch<MerchantRuleSuggestion[]>('/api/rules/suggestions'),
  dismissSuggestion: (pattern: string) =>
    apiFetch<{ success: boolean }>('/api/rules/suggestions/dismiss', {
      method: 'POST',
      body: JSON.stringify({ pattern }),
    }),
  // Approves N suggestions in one request. Only patterns travel: the server recomputes which
  // transactions each one touches, so approving cannot relabel rows the preview didn't show.
  approveSuggestions: (approvals: Array<{ pattern: string; category_id?: string }>) =>
    apiFetch<{
      approved: number;
      applied: number;
      skipped: RuleApprovalSkip[];
    }>('/api/rules/suggestions/approve', {
      method: 'POST',
      body: JSON.stringify({ approvals }),
    }),
  create: (body: {
    pattern: string;
    category_id: string;
    apply_existing?: boolean;
    apply_existing_overwrite?: boolean;
  }) =>
    apiFetch<{ rule: MerchantRule | null; applied: number }>('/api/rules', {
      method: 'POST',
      body: JSON.stringify({
        ...body,
        apply_existing: body.apply_existing ?? true,
        apply_existing_overwrite: body.apply_existing_overwrite ?? false,
      }),
    }),
  update: (id: string, body: Partial<MerchantRule>) =>
    apiFetch<MerchantRule>(`/api/rules/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  apply: (body: { only_uncategorized?: boolean } = {}) =>
    apiFetch<{ updated: number }>('/api/rules/apply', {
      method: 'POST',
      body: JSON.stringify({
        only_uncategorized: body.only_uncategorized ?? true,
      }),
    }),
  recategorize: () =>
    apiFetch<{ updated: number }>('/api/rules/recategorize', { method: 'POST' }),
  delete: (id: string) =>
    apiFetch<void>(`/api/rules/${id}`, { method: 'DELETE' }),
};

// ─── Budgets ─────────────────────────────────────────────────────────────────

export const budgetsApi = {
  list: () => apiFetch<Budget[]>('/api/budgets'),
  getMonth: (month: string) => {
    const [year, m] = month.split('-');
    return apiFetch<Budget[]>(`/api/budgets/month/${year}/${parseInt(m, 10)}`);
  },
  rolloverLedger: (params: { budgetId?: string; month?: string; months?: number } = {}) => {
    const q = new URLSearchParams();
    if (params.budgetId) q.set('budgetId', params.budgetId);
    if (params.month) q.set('month', params.month);
    if (params.months) q.set('months', String(params.months));
    return apiFetch<BudgetRolloverLedgerEntry[]>(`/api/budgets/rollover-ledger?${q.toString()}`);
  },
  upsert: (categoryId: string, body: { amount: number; period?: 'monthly'; rollover?: boolean }) =>
    apiFetch<Budget>(`/api/budgets/${categoryId}`, {
      method: 'PUT',
      body: JSON.stringify({
        amount: body.amount,
        period: body.period ?? 'monthly',
        rollover: body.rollover ?? false,
      }),
    }),
  delete: (id: string) =>
    apiFetch<void>(`/api/budgets/${id}`, { method: 'DELETE' }),
};

// ─── Recurring ───────────────────────────────────────────────────────────────

export const recurringApi = {
  list: () => apiFetch<RecurringPattern[]>('/api/recurring'),
  create: (body: {
    merchant_name: string;
    frequency: RecurringPattern['frequency'];
    average_amount: number;
    next_expected: string;
    category_id?: string | null;
  }) => apiFetch<RecurringPattern>('/api/recurring', { method: 'POST', body: JSON.stringify(body) }),
  upcoming: (days?: number) =>
    apiFetch<RecurringPattern[]>(`/api/recurring/upcoming${days ? `?days=${days}` : ''}`),
  forecast: (days?: number) =>
    apiFetch<RecurringForecast>(`/api/recurring/forecast${days ? `?days=${days}` : ''}`),
  subscriptions: (days?: number) =>
    apiFetch<SubscriptionInsights>(`/api/recurring/subscriptions${days ? `?days=${days}` : ''}`),
  adjustments: (id: string) =>
    apiFetch<RecurringOccurrenceAdjustment[]>(`/api/recurring/${id}/adjustments`),
  upsertAdjustment: (
    id: string,
    body: {
      original_date: string;
      action: 'skip' | 'snooze' | 'adjust';
      adjusted_date?: string | null;
      adjusted_amount?: number | null;
      note?: string | null;
    }
  ) =>
    apiFetch<RecurringOccurrenceAdjustment>(`/api/recurring/${id}/adjustments`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  deleteAdjustment: (id: string, adjustmentId: string) =>
    apiFetch<{ success: boolean }>(`/api/recurring/${id}/adjustments/${adjustmentId}`, {
      method: 'DELETE',
    }),
  confirm: (id: string) =>
    apiFetch<RecurringPattern>(`/api/recurring/${id}/confirm`, { method: 'POST' }),
  dismiss: (id: string) =>
    apiFetch<void>(`/api/recurring/${id}/dismiss`, { method: 'POST' }),
  update: (id: string, body: Partial<RecurringPattern>) =>
    apiFetch<RecurringPattern>(`/api/recurring/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
};

// ─── Goals ──────────────────────────────────────────────────────────────────

export const goalsApi = {
  list: (opts?: { includeArchived?: boolean }) =>
    apiFetch<Goal[]>(`/api/goals${opts?.includeArchived ? '?includeArchived=true' : ''}`),
  create: (body: Partial<Goal>) =>
    apiFetch<Goal>('/api/goals', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  update: (id: string, body: Partial<Goal>) =>
    apiFetch<Goal>(`/api/goals/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  delete: (id: string) =>
    apiFetch<void>(`/api/goals/${id}`, { method: 'DELETE' }),
};

// Insights

export const insightsApi = {
  list: () => apiFetch<Insight[]>('/api/insights'),
  safeToSpend: () => apiFetch<SafeToSpend>('/api/insights/safe-to-spend'),
  quality: () => apiFetch<DataQualitySummary>('/api/insights/quality'),
};

// ─── Reports ─────────────────────────────────────────────────────────────────

export interface ReportParams {
  startDate?: string;
  endDate?: string;
  comparison?: ReportComparisonMode;
}

export const reportsApi = {
  cashflow: (params?: ReportParams) => {
    const q = new URLSearchParams();
    if (params?.startDate) q.set('startDate', params.startDate);
    if (params?.endDate) q.set('endDate', params.endDate);
    return apiFetch<CashflowReport>(`/api/reports/cashflow?${q.toString()}`);
  },
  summary: (params?: ReportParams) => {
    const q = new URLSearchParams();
    if (params?.startDate) q.set('startDate', params.startDate);
    if (params?.endDate) q.set('endDate', params.endDate);
    if (params?.comparison) q.set('comparison', params.comparison);
    return apiFetch<ReportSummary>(`/api/reports/summary?${q.toString()}`);
  },
  spending: (params?: ReportParams) => {
    const q = new URLSearchParams();
    if (params?.startDate) q.set('startDate', params.startDate);
    if (params?.endDate) q.set('endDate', params.endDate);
    return apiFetch<SpendingReport>(`/api/reports/spending?${q.toString()}`);
  },
  trends: (params?: ReportParams & { categoryIds?: string[] }) => {
    const q = new URLSearchParams();
    if (params?.startDate) q.set('startDate', params.startDate);
    if (params?.endDate) q.set('endDate', params.endDate);
    if (params?.categoryIds?.length) q.set('categoryIds', params.categoryIds.join(','));
    return apiFetch<CategoryTrendReport>(`/api/reports/trends?${q.toString()}`);
  },
  merchants: (params?: ReportParams & { limit?: number }) => {
    const q = new URLSearchParams();
    if (params?.startDate) q.set('startDate', params.startDate);
    if (params?.endDate) q.set('endDate', params.endDate);
    if (params?.limit) q.set('limit', String(params.limit));
    return apiFetch<TopMerchantsReport>(`/api/reports/merchants?${q.toString()}`);
  },
  // Null when the window holds fewer than two snapshots: there is no movement to attribute.
  networthAttribution: (params?: ReportParams) => {
    const q = new URLSearchParams();
    if (params?.startDate) q.set('startDate', params.startDate);
    if (params?.endDate) q.set('endDate', params.endDate);
    return apiFetch<NetWorthAttribution | null>(`/api/reports/networth-attribution?${q.toString()}`);
  },
  investments: (params?: ReportParams) => {
    const q = new URLSearchParams();
    if (params?.startDate) q.set('startDate', params.startDate);
    if (params?.endDate) q.set('endDate', params.endDate);
    return apiFetch<{ total_value: number; history: Array<{ date: string; value: number; estimated: boolean }>; allocation: Array<{ security_type: string; total_value: number }>; holdings: unknown[] }>(`/api/reports/investments?${q.toString()}`);
  },
};

// ─── Net Worth ───────────────────────────────────────────────────────────────

/**
 * The state of the replayed half of the net-worth series.
 *
 * Declared here rather than in `shared/types` because nothing on the server side of this call
 * consumes a shared shape: `routes/networth.ts` composes the object from two queries and hands it
 * straight out. If a second consumer appears, move it.
 *
 * `pending` is the sync stage's own trigger, verbatim, so the screen and the sync cannot disagree
 * about whether a rebuild is owed. Null means the ledger has nothing new to reconstruct.
 */
export type ReconstructionTrigger =
  | 'no_ledger'
  | 'floor_raised'
  | 'unreachable_estimates'
  | 'never_reconstructed'
  | 'ledger_window_moved'
  | 'balances_moved';

export interface ReconstructionState {
  reconstructed: number;
  measured: number;
  /** Reconstructed rows carrying no coverage, which the chart cannot compare against anything. */
  without_coverage: number;
  /** When the replay last ran, even if that run justified no month and wrote no row. */
  last_run_at: string | null;
  oldest_reconstructed: string | null;
  oldest_snapshot: string | null;
  /** Oldest month today's balances and ledger can justify replaying. */
  reconstructable_from: string | null;
  pending: ReconstructionTrigger | null;
}

export interface ReconstructionRun {
  ran: boolean;
  trigger: ReconstructionTrigger | null;
  reconstructed: number;
  oldestReconstructed: string | null;
  measured: number;
}

export const networthApi = {
  // Null, not undefined, and not a zeroed sheet: the route returns null when no sheet has ever
  // been recorded, and a caller that cannot see the difference reports "nothing on either side of
  // the sheet" as a fact about the owner's finances.
  snapshot: () => apiFetch<NetWorthSnapshot | null>('/api/networth/snapshot'),
  history: (months?: number) =>
    apiFetch<NetWorthSnapshot[]>(`/api/networth/history${months ? `?months=${months}` : ''}`),
  // A trailing count of months cannot express a closed window ("last month"), and the route has
  // always accepted an explicit one. Additive rather than a signature change, because `history`
  // has callers elsewhere.
  historyBetween: (startDate: string, endDate: string) =>
    apiFetch<NetWorthSnapshot[]>(
      `/api/networth/history?${new URLSearchParams({ startDate, endDate }).toString()}`
    ),
  reconstruction: () => apiFetch<ReconstructionState>('/api/networth/reconstruction'),
  rebuildReconstruction: () =>
    apiFetch<ReconstructionRun>('/api/networth/reconstruction/rebuild', { method: 'POST' }),
};

// ─── Sync ────────────────────────────────────────────────────────────────────

export const syncApi = {
  run: () => apiFetch<{ success: boolean }>('/api/sync/run', { method: 'POST' }),
  health: () => apiFetch<SyncHealth>('/api/sync/health'),
  history: (limit?: number) =>
    apiFetch<SyncRun[]>(`/api/sync/history${limit ? `?limit=${limit}` : ''}`),
  historyDetail: (id: string) => apiFetch<SyncRunDetail>(`/api/sync/history/${id}`),
};

// ─── SimpleFIN ───────────────────────────────────────────────────────────────

export const simplefinApi = {
  setup: (body: { setupToken: string }) =>
    apiFetch<{ success: boolean }>('/api/simplefin/setup', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  connection: () =>
    apiFetch<{ id: string; status: string; last_synced_at: string | null; created_at: string } | null>(
      '/api/simplefin/connection'
    ),
  disconnect: () => apiFetch<void>('/api/simplefin/connection', { method: 'DELETE' }),
  resync: () =>
    apiFetch<{ success: boolean; transactionsAdded: number; transactionsModified: number }>(
      '/api/simplefin/resync',
      { method: 'POST' }
    ),
};

export const coinbaseApi = {
  connect: (body: { keyName: string; privateKey: string }) =>
    apiFetch<{
      accountCount: number;
      transactionCount: number;
      staleAccountCount: number;
      displayName: string;
    }>('/api/coinbase/connect', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  sync: () => apiFetch<{
    accountCount: number;
    transactionCount: number;
    staleAccountCount: number;
  }>('/api/coinbase/sync', { method: 'POST' }),
  disconnect: () => apiFetch<void>('/api/coinbase/disconnect', { method: 'DELETE' }),
};

// ─── Settings ────────────────────────────────────────────────────────────────

export const settingsApi = {
  getCredentials: () => apiFetch<CredentialStatus>('/api/settings/credentials'),
  getPreference: <T = unknown>(key: string) =>
    apiFetch<AppPreference<T> | null>(`/api/settings/preferences/${encodeURIComponent(key)}`),
  setPreference: <T = unknown>(key: string, value: T) =>
    apiFetch<AppPreference<T>>(`/api/settings/preferences/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: JSON.stringify({ value }),
    }),
  importRuns: (limit = 20) =>
    apiFetch<DataImportRun[]>(`/api/settings/import-runs?limit=${limit}`),
  saveCoinbaseCredentials: (body: { keyName: string; privateKey: string }) =>
    apiFetch<void>('/api/settings/credentials/coinbase', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  exportCsv: async (format: 'mizan' | 'monarch' = 'mizan') => {
    const query = format === 'monarch' ? '?format=monarch' : '';
    const res = await fetch(`/api/settings/export-csv${query}`);
    if (!res.ok) throw new Error('Export failed');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = format === 'monarch'
      ? `mizan-monarch-transactions-${new Date().toISOString().split('T')[0]}.csv`
      : `mizan-export-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  },
  exportBackupJson: async () => {
    const res = await fetch('/api/settings/backup-json');
    if (!res.ok) throw new Error('Backup export failed');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `mizan-backup-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
  },
  importCsv: (body: {
    rows: Array<Record<string, string>>;
    mapping: {
      date: string;
      amount: string;
      merchant?: string;
      category?: string;
      account?: string;
      notes?: string;
      dateFormat?: string;
      amountNegate?: boolean;
    };
  }) =>
    apiFetch<{ imported: number; errors: string[] }>('/api/settings/import-csv', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  previewCsvImport: (body: {
    rows: Array<Record<string, string>>;
    mapping: {
      date: string;
      amount: string;
      merchant?: string;
      category?: string;
      account?: string;
      notes?: string;
      dateFormat?: string;
      amountNegate?: boolean;
    };
  }) =>
    apiFetch<CsvImportPreview>('/api/settings/import-csv/preview', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  previewBackupRestore: (body: { backup: unknown }) =>
    apiFetch<LocalBackupRestorePreview>('/api/settings/backup-json/preview', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  restoreBackup: (body: { backup: unknown; confirm: 'restore' }) =>
    apiFetch<LocalBackupRestoreResult>('/api/settings/backup-json/restore', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  deleteAllData: () =>
    apiFetch<void>('/api/settings/data', {
      method: 'DELETE',
      body: JSON.stringify({ confirm: 'delete' }),
    }),
};

// ─── AI Advisor ──────────────────────────────────────────────────────────────

/**
 * Mirrors `GuardRejectionReason` (server/src/services/aiWriteGuards.ts). Restated rather than
 * imported because the client never imports server modules; it exists so a refusal can be told
 * apart from a fault without parsing the prose that explains it. `readBatchOutcomes`
 * (client/src/views/ledger/spine.ts) is what reads it, and the Ledger row prints the sentence
 * beside the entry the refusal is about.
 */
export type DraftRefusalReason =
  | 'pattern_too_short'
  | 'blast_radius_exceeded'
  | 'contradicts_history'
  | 'contradicts_owner_rule'
  | 'rule_exists_with_different_category'
  | 'human_authored';

export interface BatchConfirmOutcome {
  id: string;
  status: 'applied' | 'skipped';
  changed?: number;
  /**
   * Present on 'skipped': one of 'not_found_or_resolved', 'unreadable_payload', 'apply_failed', or
   * the guard's own sentence when `refused` is set. The server never puts exception text here.
   */
  reason?: string;
  /** Set when a write guard refused, rather than something failing. */
  refused?: DraftRefusalReason;
  label?: string;
}

/**
 * What a successful `POST /api/ai/actions/:id/undo` carries back.
 *
 * `reverted_rules` and `rule_failures` are the halves the screens dropped: an undo of a rule
 * retirement puts back no transaction at all, and a rule the server could not restore has to be
 * said out loud or a partial revert reads as a complete one. Both are optional because this shape
 * is declared here rather than by `undoAdvisorAction` (services/advisorDrafts.ts), so the client
 * reports them only when the server actually sent them.
 */
export interface AiActionUndoResult {
  ok: boolean;
  /** Transaction categories put back. */
  reverted: number;
  /** Merchant rules un-retired. Counted apart: a rule is not a row of the ledger. */
  reverted_rules?: number;
  /** One sentence per rule the undo could not restore, written by the server. */
  rule_failures?: string[];
}

export const aiApi = {
  getContext: () => apiFetch<AdvisorContextResponse>('/api/ai/context'),
  // Which draft kinds apply unattended. Fetched rather than restated: this is the table Settings
  // derives both its Undo buttons and its statement of the boundary from.
  getAutonomy: () => apiFetch<AdvisorAutonomyResponse>('/api/ai/autonomy'),
  listActions: () =>
    apiFetch<
      Array<{
        id: string;
        kind: string;
        label: string;
        summary: string;
        source: 'worker_auto' | 'user_confirm';
        created_at: string;
      }>
    >('/api/ai/actions'),
  // Reverses every categorization the action made, restoring each row's prior category, and
  // un-retires every rule it retired. Rows edited by hand since are skipped, and any rule the
  // action created stays.
  undoAction: (id: string) =>
    apiFetch<AiActionUndoResult>(`/api/ai/actions/${id}/undo`, { method: 'POST' }),
  getProfile: () => apiFetch<{ profile: string }>('/api/ai/profile'),
  saveProfile: (profile: string) =>
    apiFetch<{ profile: string }>('/api/ai/profile', {
      method: 'PUT',
      body: JSON.stringify({ profile }),
    }),
  /* `suggestCategories` used to sit here, calling POST /api/ai/suggest-categories for the retired
     review inbox. It is gone rather than re-homed, and the reason is provenance, not tidiness.
     The endpoint hands back a bare merchant -> category map with no draft behind it, so the only
     way a screen can apply one is `transactionsApi.bulkCategory`, and
     `bulkCategorizeTransactions` (server/src/services/transactions.ts) writes
     `source: 'human', markManual: true` AND upserts a human-source merchant rule for every
     merchant it touches. Applying a model's guess through it would stamp the model's choice as the
     owner's and mint owner rules from it. The worker's `categorize_transaction` drafts cover the
     same ground and carry `category_source = 'ai'`, a `category_action_id`, the write guards, and
     `POST /api/ai/actions/:id/undo`; they are reachable on the Ledger's "Model suggests" chip.
     The server route still exists: it is outside this change's file set. */

  // Standing statements the advisor reasons from. A statement carrying a derived figure is refused
  // by the server with the reason in `error`, which the panel shows verbatim.
  listMemory: () => apiFetch<AiMemory[]>('/api/ai/memory'),
  createMemory: (input: AiMemoryInput) =>
    apiFetch<AiMemory>('/api/ai/memory', { method: 'POST', body: JSON.stringify(input) }),
  // Replaces the statement and keeps the old one in its history. Not an in-place edit.
  reviseMemory: (id: string, revision: AiMemoryRevision) =>
    apiFetch<AiMemory>(`/api/ai/memory/${id}`, { method: 'PUT', body: JSON.stringify(revision) }),
  deleteMemory: (id: string) =>
    apiFetch<{ success: boolean }>(`/api/ai/memory/${id}`, { method: 'DELETE' }),
  getSettings: () => apiFetch<AdvisorSettings>('/api/ai/settings'),
  saveSettings: (update: AdvisorSettingsUpdate) =>
    apiFetch<AdvisorSettings>('/api/ai/settings', {
      method: 'PUT',
      body: JSON.stringify(update),
    }),

  /* Per-provider credentials. Keys go into the same AES-256-GCM store as the bank
     credentials, and nothing here ever reads one back: the response says which source is in
     use and whether one exists, which is all a settings screen needs to render. A key
     supplied through `.env` is not deletable from the UI, and the server says so rather than
     reporting success on a deletion the owner cannot see the effect of. */
  listProviders: () =>
    apiFetch<{ providers: AdvisorProviderStatus[] }>('/api/ai/providers'),
  saveProviderKey: (provider: AiProviderId, apiKey: string) =>
    apiFetch<{ providers: AdvisorProviderStatus[] }>(`/api/ai/providers/${provider}/key`, {
      method: 'PUT',
      body: JSON.stringify({ api_key: apiKey }),
    }),
  clearProviderKey: (provider: AiProviderId) =>
    apiFetch<{ providers: AdvisorProviderStatus[] }>(`/api/ai/providers/${provider}/key`, {
      method: 'DELETE',
    }),
  listConversations: () =>
    apiFetch<Array<{ id: string; title: string; updated_at: string; message_count: number }>>(
      '/api/ai/conversations'
    ),
  createConversation: () =>
    apiFetch<{ id: string }>('/api/ai/conversations', { method: 'POST', body: JSON.stringify({}) }),
  getConversation: (id: string) =>
    apiFetch<{ id: string; title: string; messages: ChatMessage[] }>(`/api/ai/conversations/${id}`),
  appendMessages: (id: string, messages: ChatMessage[]) =>
    apiFetch<{ success: boolean }>(`/api/ai/conversations/${id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ messages }),
    }),
  deleteConversation: (id: string) =>
    apiFetch<{ success: boolean }>(`/api/ai/conversations/${id}`, { method: 'DELETE' }),
  analyze: (question: string, signal?: AbortSignal) =>
    apiFetch<AdvisorAnalysis>('/api/ai/analyze', {
      method: 'POST',
      body: JSON.stringify({ question }),
      signal,
    }),
  confirmDraft: (draft: AdvisorDraftAction) =>
    apiFetch<AdvisorConfirmResponse>('/api/ai/confirm', {
      method: 'POST',
      body: JSON.stringify({ draft, confirm: true }),
    }),
  dismissDraft: (id: string) =>
    apiFetch<{ success: boolean }>(`/api/ai/drafts/${id}/dismiss`, {
      method: 'POST',
    }),
  // Ids only: the server reads each payload back from advisor_drafts. Partial success is normal,
  // so the per-draft outcomes come back rather than a single success flag.
  confirmDrafts: (ids: string[]) =>
    apiFetch<{
      applied: number;
      skipped: number;
      outcomes: BatchConfirmOutcome[];
    }>('/api/ai/drafts/confirm', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),

  // Every row the AI touched since `since`, grouped by the action that caused it.
  digest: (since: string | null, limit?: number, signal?: AbortSignal) => {
    const params = new URLSearchParams();
    if (since) params.set('since', since);
    if (limit !== undefined) params.set('limit', String(limit));
    const query = params.toString();
    return apiFetch<AiDigest>(`/api/ai/digest${query ? `?${query}` : ''}`, { signal });
  },
  // One gesture, and the result says what it left alone as well as what it put back.
  // `limit` is the action cap the caller's digest used: sending the digest's own `action_limit`
  // back is what keeps the revert's population identical to the one the caller was shown.
  revertDigestSince: (since: string, limit: number) =>
    apiFetch<AiDigestRevertResult>('/api/ai/digest/revert', {
      method: 'POST',
      body: JSON.stringify({ since, limit }),
    }),

  streamChat: async (
    messages: ChatMessage[],
    onChunk: (text: string) => void,
    onDone: () => void,
    onError: (msg: string) => void,
    signal?: AbortSignal,
    onThinkingStart?: () => void,
    onThinkingChunk?: (text: string) => void,
    onThinkingEnd?: () => void,
    onToolUse?: (name: string) => void,
    // When the thread is saved, send its id and the new turn only: the server rebuilds the history
    // from its own tables, so the prefix in front of the cached system block is one it controls.
    // Without an id (the conversation row failed to create) the array is still sent, unchanged.
    conversationId?: string | null
  ): Promise<void> => {
    const latest = messages[messages.length - 1];
    const body =
      conversationId && latest?.role === 'user'
        ? { conversation_id: conversationId, message: latest.content }
        : { messages };

    const res = await fetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const body = await res.json();
        msg = body.error || msg;
      } catch (err) {
        console.warn('Failed to parse AI error response', err);
      }
      onError(msg);
      return;
    }

    const reader = res.body?.getReader();
    if (!reader) { onError('No response body'); return; }

    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const ev = JSON.parse(line.slice(6)) as AiStreamEvent;
          if (ev.type === 'chunk' && ev.text) onChunk(ev.text);
          else if (ev.type === 'thinking_start') onThinkingStart?.();
          else if (ev.type === 'thinking' && ev.text) onThinkingChunk?.(ev.text);
          else if (ev.type === 'thinking_end') onThinkingEnd?.();
          else if (ev.type === 'tool_use' && ev.name) onToolUse?.(ev.name);
          else if (ev.type === 'done') onDone();
          else if (ev.type === 'error') onError(ev.message ?? 'Unknown error');
        } catch (err) {
          console.warn('Ignoring malformed AI stream event', err);
        }
      }
    }
  },
};
