import type {
  Account,
  Transaction,
  TransactionFilters,
  Category,
  Goal,
  MerchantRule,
  MerchantRuleSuggestion,
  Budget,
  RecurringPattern,
  RecurringForecast,
  NetWorthSnapshot,
  PlaidItem,
  Insight,
  DataQualitySummary,
  SyncHealth,
  SyncRun,
  SyncRunDetail,
  CashflowReport,
  ReportDrilldown,
  ReportEvidenceDrilldown,
  ReportEvidenceKind,
  ReportExcludedFlowSummary,
  ReportComparisonMode,
  ReportSummary,
  SpendingReport,
  NetWorthHistory,
  CredentialStatus,
  Holding,
  InvestmentTransaction,
  TransactionReviewSummary,
  PaginatedResponse,
  ChatMessage,
  AiStreamEvent,
  AdvisorAnalysis,
  AdvisorConfirmResponse,
  AdvisorDraftAction,
  AdvisorContextResponse,
  CsvImportPreview,
} from '@shared/types';

type PlaidSyncStatus = 'synced' | 'reauth_required';

interface PlaidSyncIssue {
  itemId: string;
  institutionName: string;
  message: string;
}

interface PlaidExchangeResult {
  itemId: string;
  accounts: Account[];
  initialSyncStatus: PlaidSyncStatus | 'failed';
  initialSyncError?: string;
}

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
    apiFetch<Transaction>(`/api/transactions/${id}`, {
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
  transactions: (params?: { accountId?: string; startDate?: string; endDate?: string }) => {
    const q = new URLSearchParams();
    if (params?.accountId) q.set('accountId', params.accountId);
    if (params?.startDate) q.set('startDate', params.startDate);
    if (params?.endDate) q.set('endDate', params.endDate);
    return apiFetch<InvestmentTransaction[]>(`/api/investments/transactions?${q.toString()}`);
  },
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
  create: (body: { pattern: string; category_id: string; apply_existing?: boolean }) =>
    apiFetch<{ rule: MerchantRule | null; applied: number }>('/api/rules', {
      method: 'POST',
      body: JSON.stringify({
        ...body,
        apply_existing: body.apply_existing ?? true,
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
  upcoming: (days?: number) =>
    apiFetch<RecurringPattern[]>(`/api/recurring/upcoming${days ? `?days=${days}` : ''}`),
  forecast: (days?: number) =>
    apiFetch<RecurringForecast>(`/api/recurring/forecast${days ? `?days=${days}` : ''}`),
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
  list: () => apiFetch<Goal[]>('/api/goals'),
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
  summary: (params?: ReportParams) => {
    const q = new URLSearchParams();
    if (params?.startDate) q.set('startDate', params.startDate);
    if (params?.endDate) q.set('endDate', params.endDate);
    if (params?.comparison) q.set('comparison', params.comparison);
    return apiFetch<ReportSummary>(`/api/reports/summary?${q.toString()}`);
  },
  cashflow: (params?: ReportParams) => {
    const q = new URLSearchParams();
    if (params?.startDate) q.set('startDate', params.startDate);
    if (params?.endDate) q.set('endDate', params.endDate);
    return apiFetch<CashflowReport>(`/api/reports/cashflow?${q.toString()}`);
  },
  spending: (params?: ReportParams) => {
    const q = new URLSearchParams();
    if (params?.startDate) q.set('startDate', params.startDate);
    if (params?.endDate) q.set('endDate', params.endDate);
    if (params?.month) q.set('month', params.month);
    return apiFetch<SpendingReport>(`/api/reports/spending?${q.toString()}`);
  },
  income: (params?: ReportParams) => {
    const q = new URLSearchParams();
    if (params?.startDate) q.set('startDate', params.startDate);
    if (params?.endDate) q.set('endDate', params.endDate);
    if (params?.month) q.set('month', params.month);
    return apiFetch<SpendingReport>(`/api/reports/income?${q.toString()}`);
  },
  trends: (params?: ReportParams & { categoryIds?: string[] }) => {
    const q = new URLSearchParams();
    if (params?.startDate) q.set('startDate', params.startDate);
    if (params?.endDate) q.set('endDate', params.endDate);
    if (params?.categoryIds?.length) q.set('categoryIds', params.categoryIds.join(','));
    return apiFetch<{ months: string[]; series: Array<{ category_id: string; category_name: string; color?: string | null; values: number[] }> }>(`/api/reports/trends?${q.toString()}`);
  },
  drilldown: (params: ReportParams & { kind: 'spending' | 'income'; categoryId: string }) => {
    const q = new URLSearchParams();
    q.set('kind', params.kind);
    q.set('categoryId', params.categoryId);
    if (params.startDate) q.set('startDate', params.startDate);
    if (params.endDate) q.set('endDate', params.endDate);
    return apiFetch<ReportDrilldown>(`/api/reports/drilldown?${q.toString()}`);
  },
  evidence: (params: ReportParams & {
    kind: ReportEvidenceKind;
    month?: string;
    flowType?: ReportExcludedFlowSummary['flow_type'];
  }) => {
    const q = new URLSearchParams();
    q.set('kind', params.kind);
    if (params.month) q.set('month', params.month);
    if (params.flowType) q.set('flowType', params.flowType);
    if (params.startDate) q.set('startDate', params.startDate);
    if (params.endDate) q.set('endDate', params.endDate);
    return apiFetch<ReportEvidenceDrilldown>(`/api/reports/evidence?${q.toString()}`);
  },
  networth: (params?: { months?: number }) =>
    apiFetch<NetWorthHistory>(`/api/reports/networth${params?.months ? `?months=${params.months}` : ''}`),
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

// ─── Plaid ───────────────────────────────────────────────────────────────────

export const plaidApi = {
  createLinkToken: () =>
    apiFetch<{ link_token: string; redirect_uri: string }>('/api/plaid/link-token', {
      method: 'POST',
      body: JSON.stringify({ redirectUri: window.location.origin }),
    }),
  exchangeToken: (publicToken: string, metadata: unknown) =>
    apiFetch<PlaidExchangeResult>('/api/plaid/exchange-token', {
      method: 'POST',
      body: JSON.stringify({ publicToken, metadata }),
    }),
  syncItem: (itemId: string) =>
    apiFetch<{ success: boolean; status: PlaidSyncStatus }>(`/api/plaid/sync/${itemId}`, { method: 'POST' }),
  syncAll: () => apiFetch<{
    success: boolean;
    synced: number;
    reauthRequired: PlaidSyncIssue[];
    failed: PlaidSyncIssue[];
  }>('/api/plaid/sync/all', { method: 'POST' }),
  listItems: () => apiFetch<PlaidItem[]>('/api/plaid/items'),
  deleteItem: (itemId: string) =>
    apiFetch<void>(`/api/plaid/items/${itemId}`, { method: 'DELETE' }),
  createUpdateToken: (itemId: string) =>
    apiFetch<{ link_token: string; redirect_uri: string }>(`/api/plaid/update-token/${itemId}`, {
      method: 'POST',
      body: JSON.stringify({ redirectUri: window.location.origin }),
    }),
};

// ─── Coinbase ────────────────────────────────────────────────────────────────

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
  savePlaidCredentials: (body: { clientId: string; secret: string; environment: string }) =>
    apiFetch<void>('/api/settings/credentials/plaid', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  saveCoinbaseCredentials: (body: { keyName: string; privateKey: string }) =>
    apiFetch<void>('/api/settings/credentials/coinbase', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  exportCsv: async () => {
    const res = await fetch('/api/settings/export-csv');
    if (!res.ok) throw new Error('Export failed');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `mizan-export-${new Date().toISOString().split('T')[0]}.csv`;
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
  deleteAllData: () =>
    apiFetch<void>('/api/settings/data', {
      method: 'DELETE',
      body: JSON.stringify({ confirm: 'delete' }),
    }),
};

// ─── AI Advisor ──────────────────────────────────────────────────────────────

export const aiApi = {
  getContext: () => apiFetch<AdvisorContextResponse>('/api/ai/context'),
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

  streamChat: async (
    messages: ChatMessage[],
    onChunk: (text: string) => void,
    onDone: () => void,
    onError: (msg: string) => void,
    signal?: AbortSignal
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
          else if (ev.type === 'done') onDone();
          else if (ev.type === 'error') onError(ev.message ?? 'Unknown error');
        } catch (err) {
          console.warn('Ignoring malformed AI stream event', err);
        }
      }
    }
  },
};

// ─── Health ──────────────────────────────────────────────────────────────────

export const healthApi = {
  get: () =>
    apiFetch<{
      status: string;
      version: string;
      plaidEnvironment: 'sandbox' | 'production' | null;
      plaidItemCount: number;
      coinbaseConnected: boolean;
      error: string | null;
    }>('/api/health'),
};
