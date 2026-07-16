import type {
  Account,
  Transaction,
  TransactionFilters,
  Category,
  Goal,
  MerchantRule,
  MerchantRuleSuggestion,
  Budget,
  BudgetGroup,
  BudgetRolloverLedgerEntry,
  RecurringPattern,
  RecurringForecast,
  RecurringOccurrenceAdjustment,
  SubscriptionInsights,
  NetWorthSnapshot,
  Insight,
  DataQualitySummary,
  SyncHealth,
  SyncRun,
  SyncRunDetail,
  CashflowReport,
  ReportSummary,
  ReportComparisonMode,
  SpendingReport,
  CredentialStatus,
  Holding,
  HoldingHistoryPoint,
  Security,
  TransactionReviewSummary,
  PaginatedResponse,
  ChatMessage,
  AiStreamEvent,
  AdvisorAnalysis,
  AdvisorConfirmResponse,
  AdvisorDraftAction,
  AdvisorContextResponse,
  AppPreference,
  CsvImportPreview,
  DataImportRun,
  LocalBackupRestorePreview,
  LocalBackupRestoreResult,
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

  const json = await res.json();
  // Unwrap { data: ... } envelope if present
  if (json && typeof json === 'object' && 'data' in json) {
    return json.data as T;
  }
  return json as T;
}

// ─── Accounts ───────────────────────────────────────────────────────────────

export const accountsApi = {
  list: () => apiFetch<Account[]>('/api/accounts'),
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
    params.accountId?.forEach((id) => q.append('accountId', id));
    params.categoryId?.forEach((id) => q.append('categoryId', id));
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
  markReview: (id: string, status: 'open' | 'reviewed' | 'dismissed') =>
    apiFetch<Transaction>(`/api/transactions/${id}/review`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    }),
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

export const rulesApi = {
  list: () => apiFetch<MerchantRule[]>('/api/rules'),
  suggestions: () => apiFetch<MerchantRuleSuggestion[]>('/api/rules/suggestions'),
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
  groups: (month: string) =>
    apiFetch<BudgetGroup[]>(`/api/budgets/groups?month=${encodeURIComponent(month)}`),
  createGroup: (body: { name: string; color?: string | null; sort_order?: number }) =>
    apiFetch<BudgetGroup>('/api/budgets/groups', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateGroup: (id: string, body: { name?: string; color?: string | null; sort_order?: number }) =>
    apiFetch<BudgetGroup>(`/api/budgets/groups/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  setGroupMembers: (id: string, categoryIds: string[]) =>
    apiFetch<BudgetGroup>(`/api/budgets/groups/${id}/members`, {
      method: 'PUT',
      body: JSON.stringify({ category_ids: categoryIds }),
    }),
  deleteGroup: (id: string) =>
    apiFetch<{ success: boolean }>(`/api/budgets/groups/${id}`, { method: 'DELETE' }),
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
  quality: () => apiFetch<DataQualitySummary>('/api/insights/quality'),
};

// ─── Reports ─────────────────────────────────────────────────────────────────

export interface ReportParams {
  startDate?: string;
  endDate?: string;
  month?: string;
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
    if (params?.month) q.set('month', params.month);
    return apiFetch<SpendingReport>(`/api/reports/spending?${q.toString()}`);
  },
  investments: (params?: ReportParams) => {
    const q = new URLSearchParams();
    if (params?.startDate) q.set('startDate', params.startDate);
    if (params?.endDate) q.set('endDate', params.endDate);
    return apiFetch<{ total_value: number; history: Array<{ date: string; value: number }>; allocation: Array<{ security_type: string; total_value: number }>; holdings: unknown[] }>(`/api/reports/investments?${q.toString()}`);
  },
};

// ─── Net Worth ───────────────────────────────────────────────────────────────

export const networthApi = {
  snapshot: () => apiFetch<NetWorthSnapshot>('/api/networth/snapshot'),
  history: (months?: number) =>
    apiFetch<NetWorthSnapshot[]>(`/api/networth/history${months ? `?months=${months}` : ''}`),
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

export const aiApi = {
  getContext: () => apiFetch<AdvisorContextResponse>('/api/ai/context'),
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
  getProfile: () => apiFetch<{ profile: string }>('/api/ai/profile'),
  saveProfile: (profile: string) =>
    apiFetch<{ profile: string }>('/api/ai/profile', {
      method: 'PUT',
      body: JSON.stringify({ profile }),
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

  streamChat: async (
    messages: ChatMessage[],
    onChunk: (text: string) => void,
    onDone: () => void,
    onError: (msg: string) => void,
    signal?: AbortSignal,
    onThinkingStart?: () => void,
    onThinkingChunk?: (text: string) => void,
    onThinkingEnd?: () => void,
    onToolUse?: (name: string) => void
  ): Promise<void> => {
    const res = await fetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages }),
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
