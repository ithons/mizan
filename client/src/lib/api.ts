import type {
  Account,
  Transaction,
  TransactionFilters,
  Category,
  Budget,
  RecurringPattern,
  NetWorthSnapshot,
  PlaidItem,
  CashflowReport,
  SpendingReport,
  NetWorthHistory,
  CredentialStatus,
  Holding,
  InvestmentTransaction,
  PaginatedResponse,
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
    } catch {
      // ignore parse errors
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
    if (params.type) q.set('type', params.type);
    params.accountId?.forEach((id) => q.append('accountId', id));
    params.categoryId?.forEach((id) => q.append('categoryId', id));
    return apiFetch<PaginatedResponse<Transaction>>(`/api/transactions?${q.toString()}`);
  },
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
      result.push(...cat.children);
    }
  }
  return result;
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
    apiFetch<void>('/api/categories/merge', {
      method: 'POST',
      body: JSON.stringify({ sourceId, targetId }),
    }),
};

// ─── Budgets ─────────────────────────────────────────────────────────────────

export const budgetsApi = {
  list: () => apiFetch<Budget[]>('/api/budgets'),
  getMonth: (month: string) => {
    const [year, m] = month.split('-');
    return apiFetch<Budget[]>(`/api/budgets/month/${year}/${parseInt(m, 10)}`);
  },
  upsert: (categoryId: string, body: { amount: number; period?: string; rollover?: boolean }) =>
    apiFetch<Budget>(`/api/budgets/${categoryId}`, {
      method: 'PUT',
      body: JSON.stringify({ amount: body.amount, period: body.period ?? 'monthly', rollover: body.rollover ?? false }),
    }),
  delete: (id: string) =>
    apiFetch<void>(`/api/budgets/${id}`, { method: 'DELETE' }),
};

// ─── Recurring ───────────────────────────────────────────────────────────────

export const recurringApi = {
  list: () => apiFetch<RecurringPattern[]>('/api/recurring'),
  upcoming: (days?: number) =>
    apiFetch<RecurringPattern[]>(`/api/recurring/upcoming${days ? `?days=${days}` : ''}`),
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

// ─── Reports ─────────────────────────────────────────────────────────────────

export interface ReportParams {
  startDate?: string;
  endDate?: string;
  month?: string;
}

export const reportsApi = {
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

// ─── Plaid ───────────────────────────────────────────────────────────────────

export const plaidApi = {
  createLinkToken: () =>
    apiFetch<{ link_token: string; redirect_uri: string }>('/api/plaid/link-token', {
      method: 'POST',
      body: JSON.stringify({ redirectUri: window.location.origin }),
    }),
  exchangeToken: (publicToken: string, metadata: unknown) =>
    apiFetch<{ success: boolean }>('/api/plaid/exchange-token', {
      method: 'POST',
      body: JSON.stringify({ publicToken, metadata }),
    }),
  syncItem: (itemId: string) =>
    apiFetch<void>(`/api/plaid/sync/${itemId}`, { method: 'POST' }),
  syncAll: () => apiFetch<void>('/api/plaid/sync/all', { method: 'POST' }),
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
    apiFetch<{ accountCount: number; displayName: string }>('/api/coinbase/connect', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  sync: () => apiFetch<void>('/api/coinbase/sync', { method: 'POST' }),
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
  importCsv: (formData: FormData) =>
    fetch('/api/settings/import-csv', { method: 'POST', body: formData }).then((r) => r.json()),
  deleteAllData: () =>
    apiFetch<void>('/api/settings/data', { method: 'DELETE' }),
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
