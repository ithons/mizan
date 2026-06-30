import React, { useState } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  Plus,
  Download,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  X,
  Trash2,
  SlidersHorizontal,
  Sparkles,
  FileText,
} from 'lucide-react';
import { format, subMonths } from 'date-fns';
import { transactionsApi, accountsApi, categoriesApi, settingsApi, flattenCategories, rulesApi } from '../lib/api';
import { formatDate, formatCurrency } from '../lib/formatters';
import { useAppStore } from '../store';
import { Modal } from '../components/Modal';
import { AmountBadge } from '../components/AmountBadge';
import { EmptyState } from '../components/EmptyState';
import { InlineEdit } from '../components/InlineEdit';
import { SkeletonList } from '../components/SkeletonLoader';
import { invalidateFinancialData } from '../lib/queryInvalidation';
import { parseDecimalInput } from '../lib/numberInput';
import {
  BulkCategoryDropdown,
  CategoryDropdown,
  FilterChip,
  SortableHeader,
  type SortCol,
  type SortDir,
} from './transactions/TransactionControls';
import { TransactionReviewPanel } from './transactions/TransactionReviewPanel';
import type {
  MerchantRuleSuggestion,
  TransactionFilters,
  TransactionReviewQueueId,
  Category,
} from '@shared/types';

const PAGE_SIZE = 50;

// ─── Add Transaction Modal ────────────────────────────────────────────────────

function AddTransactionModal({
  open,
  onClose,
  accounts,
  categories,
}: {
  open: boolean;
  onClose: () => void;
  accounts: Array<{ id: string; account_name: string }>;
  categories: Category[];
}) {
  const qc = useQueryClient();
  const { addToast } = useAppStore();
  const [form, setForm] = useState({
    account_id: accounts[0]?.id ?? '',
    date: format(new Date(), 'yyyy-MM-dd'),
    amount: '',
    merchant_name: '',
    category_id: '',
    notes: '',
  });

  const mutation = useMutation({
    mutationFn: () => {
      const amount = parseDecimalInput(form.amount);
      if (amount === null) {
        throw new Error('Enter a valid amount');
      }

      return transactionsApi.createManual({
        ...form,
        amount,
        original_name: form.merchant_name,
      });
    },
    onSuccess: () => {
      invalidateFinancialData(qc);
      addToast({ type: 'success', message: 'Transaction added' });
      onClose();
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  return (
    <Modal open={open} onClose={onClose} title="Add Transaction">
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-muted mb-1">Date</label>
            <input
              type="date"
              className="w-full bg-background border border-border rounded px-3 py-2 text-sm text-text font-mono focus:outline-none focus:ring-1 focus:ring-green-50"
              value={form.date}
              onChange={(e) => setForm({ ...form, date: e.target.value })}
            />
          </div>
          <div>
            <label className="block text-xs text-muted mb-1">Amount</label>
            <input
              type="number"
              step="0.01"
              className="w-full bg-background border border-border rounded px-3 py-2 text-sm text-text font-mono focus:outline-none focus:ring-1 focus:ring-green-50"
              value={form.amount}
              onChange={(e) => setForm({ ...form, amount: e.target.value })}
              placeholder="0.00"
            />
          </div>
        </div>
        <div>
          <label className="block text-xs text-muted mb-1">Merchant</label>
          <input
            className="w-full bg-background border border-border rounded px-3 py-2 text-sm text-text focus:outline-none focus:ring-1 focus:ring-green-50"
            value={form.merchant_name}
            onChange={(e) => setForm({ ...form, merchant_name: e.target.value })}
            placeholder="Amazon"
          />
        </div>
        <div>
          <label className="block text-xs text-muted mb-1">Account</label>
          <select
            className="w-full bg-background border border-border rounded px-3 py-2 text-sm text-text focus:outline-none focus:ring-1 focus:ring-green-50"
            value={form.account_id}
            onChange={(e) => setForm({ ...form, account_id: e.target.value })}
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>{a.account_name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-muted mb-1">Category</label>
          <select
            className="w-full bg-background border border-border rounded px-3 py-2 text-sm text-text focus:outline-none focus:ring-1 focus:ring-green-50"
            value={form.category_id}
            onChange={(e) => setForm({ ...form, category_id: e.target.value })}
          >
            <option value="">Uncategorized</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-muted mb-1">Notes</label>
          <input
            className="w-full bg-background border border-border rounded px-3 py-2 text-sm text-text focus:outline-none focus:ring-1 focus:ring-green-50"
            value={form.notes}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
            placeholder="Optional"
          />
        </div>
        <div className="flex gap-3 pt-1">
          <button
            className="flex-1 py-2 text-sm bg-text text-surface font-medium rounded hover:opacity-90"
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending}
          >
            {mutation.isPending ? 'Adding...' : 'Add Transaction'}
          </button>
          <button
            className="px-4 py-2 text-sm border border-border rounded text-muted hover:text-text"
            onClick={onClose}
          >
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function Transactions() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { addToast } = useAppStore();
  const [page, setPage] = useState(1);
  const [showAddModal, setShowAddModal] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showFilters, setShowFilters] = useState(false);
  const [sortBy, setSortBy] = useState<SortCol>('date');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const DEFAULT_START = format(subMonths(new Date(), 1), 'yyyy-MM-dd');
  const DEFAULT_END = format(new Date(), 'yyyy-MM-dd');

  const [filters, setFilters] = useState<TransactionFilters>({
    startDate: DEFAULT_START,
    endDate: DEFAULT_END,
    search: '',
    type: '',
    pending: undefined,
    recurring: undefined,
    uncategorized: undefined,
  });

  const queryFilters = { ...filters, page, limit: PAGE_SIZE, sortBy, sortDir };

  const { data: txData, isLoading, isError } = useQuery({
    queryKey: ['transactions', queryFilters],
    queryFn: () => transactionsApi.list(queryFilters),
  });

  const { data: reviewSummary } = useQuery({
    queryKey: ['transactions', 'review'],
    queryFn: transactionsApi.review,
  });

  const { data: accounts = [] } = useQuery({
    queryKey: ['accounts'],
    queryFn: accountsApi.list,
  });

  const { data: categoriesTree = [] } = useQuery({
    queryKey: ['categories'],
    queryFn: categoriesApi.list,
  });
  const categories = flattenCategories(categoriesTree);

  const updateCatMutation = useMutation({
    mutationFn: ({ id, categoryId }: { id: string; categoryId: string }) =>
      transactionsApi.update(id, { category_id: categoryId }),
    onSuccess: () => invalidateFinancialData(qc),
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const updateMerchantMutation = useMutation({
    mutationFn: ({ id, merchant_name }: { id: string; merchant_name: string }) =>
      transactionsApi.update(id, { merchant_name }),
    onSuccess: () => invalidateFinancialData(qc),
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const updateNoteMutation = useMutation({
    mutationFn: ({ id, notes }: { id: string; notes: string }) =>
      transactionsApi.update(id, { notes }),
    onSuccess: () => invalidateFinancialData(qc),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => transactionsApi.delete(id),
    onSuccess: () => {
      invalidateFinancialData(qc);
      setSelectedIds(new Set());
      addToast({ type: 'success', message: 'Transaction deleted' });
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const bulkCatMutation = useMutation({
    mutationFn: ({ ids, categoryId }: { ids: string[]; categoryId: string }) =>
      transactionsApi.bulkCategory(ids, categoryId),
    onSuccess: () => {
      invalidateFinancialData(qc);
      setSelectedIds(new Set());
      addToast({ type: 'success', message: 'Categories updated' });
    },
  });

  const createRuleMutation = useMutation({
    mutationFn: ({ pattern, categoryId }: { pattern: string; categoryId: string }) =>
      rulesApi.create({
        pattern,
        category_id: categoryId,
        apply_existing: true,
      }),
    onSuccess: (result) => {
      invalidateFinancialData(qc);
      addToast({
        type: 'success',
        message: result.applied > 0
          ? `Rule saved and applied to ${result.applied} transactions`
          : 'Rule saved',
      });
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const createRuleFromTransaction = (merchantName: string | null | undefined, categoryId: string | null | undefined) => {
    const pattern = merchantName?.trim();
    if (!pattern || !categoryId) return;
    createRuleMutation.mutate({ pattern, categoryId });
  };

  const applyRuleSuggestion = (suggestion: MerchantRuleSuggestion) => {
    createRuleMutation.mutate({
      pattern: suggestion.pattern,
      categoryId: suggestion.category_id,
    });
  };

  const txs = txData?.data ?? [];
  const total = txData?.total ?? 0;
  const totalPages = Math.ceil(total / PAGE_SIZE);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    if (selectedIds.size === txs.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(txs.map((t) => t.id)));
    }
  };

  const handleSort = (col: SortCol) => {
    if (sortBy === col) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(col);
      setSortDir('desc');
    }
  };

  const clearFilter = (key: keyof TransactionFilters) => {
    setFilters((f) => ({
      ...f,
      [key]: key === 'pending' || key === 'recurring' || key === 'uncategorized' ? undefined : '',
    }));
    setPage(1);
  };

  const resetFilters = () => {
    setFilters({
      startDate: DEFAULT_START,
      endDate: DEFAULT_END,
      search: '',
      type: '',
      pending: undefined,
      recurring: undefined,
      uncategorized: undefined,
    });
    setPage(1);
  };

  const reviewUncategorized = () => {
    setFilters({
      startDate: '',
      endDate: '',
      search: '',
      type: '',
      pending: false,
      recurring: undefined,
      uncategorized: true,
    });
    setPage(1);
    setSelectedIds(new Set());
  };

  const reviewPending = () => {
    setFilters({
      startDate: '',
      endDate: '',
      search: '',
      type: '',
      pending: true,
      recurring: undefined,
      uncategorized: undefined,
    });
    setPage(1);
    setSelectedIds(new Set());
  };

  const selectReviewQueue = (queueId: TransactionReviewQueueId) => {
    navigate(`/review?queue=${queueId}`);
  };

  const hasSearch = !!filters.search;
  const hasType = !!filters.type;
  const hasPending = filters.pending !== undefined;
  const hasRecurring = filters.recurring !== undefined;
  const hasUncategorized = filters.uncategorized !== undefined;
  const isDefaultDateRange = filters.startDate === DEFAULT_START && filters.endDate === DEFAULT_END;
  const hasDateRange = !isDefaultDateRange;
  const hasActiveFilters = hasSearch || hasType || hasPending || hasRecurring || hasUncategorized || hasDateRange;
  const dateRangeLabel = `${filters.startDate || 'Any'} → ${filters.endDate || 'Any'}`;
  const hasNoAccountSetup = accounts.length === 0 && !hasActiveFilters;
  const emptyTitle = hasNoAccountSetup
    ? 'No accounts connected'
    : hasActiveFilters
      ? 'No transactions match these filters'
      : 'No transactions yet';
  const emptyDescription = hasNoAccountSetup
    ? 'Connect a bank account or create a manual account before reviewing transactions.'
    : hasActiveFilters
      ? 'Clear the filters to return to the full ledger.'
      : 'Add a manual transaction or connect another account to start building reports.';
  const emptyAction = hasNoAccountSetup
    ? () => navigate('/accounts?connect=bank')
    : hasActiveFilters
      ? resetFilters
      : () => setShowAddModal(true);
  const emptyActionLabel = hasNoAccountSetup
    ? 'Connect Account'
    : hasActiveFilters
      ? 'Clear Filters'
      : 'Add Transaction';
  const emptySecondaryAction = hasNoAccountSetup
    ? () => navigate('/accounts?manual=1')
    : hasActiveFilters
      ? () => setShowAddModal(true)
      : () => navigate('/accounts?connect=bank');
  const emptySecondaryActionLabel = hasNoAccountSetup
    ? 'Add Manual Account'
    : hasActiveFilters
      ? 'Add Transaction'
      : 'Connect Account';

  return (
    <div className="p-6 flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <h1 className="text-xl font-semibold text-text mr-auto">Transactions</h1>
        {/* Active filter chips */}
        {hasDateRange && (
          <FilterChip
            label={dateRangeLabel}
            onRemove={() => { setFilters((f) => ({ ...f, startDate: DEFAULT_START, endDate: DEFAULT_END })); setPage(1); }}
          />
        )}
        {hasSearch && <FilterChip label={`"${filters.search}"`} onRemove={() => clearFilter('search')} />}
        {hasType && <FilterChip label={filters.type as string} onRemove={() => clearFilter('type')} />}
        {hasPending && <FilterChip label={filters.pending ? 'Pending' : 'Posted'} onRemove={() => clearFilter('pending')} />}
        {hasRecurring && <FilterChip label={filters.recurring ? 'Recurring' : 'One-time'} onRemove={() => clearFilter('recurring')} />}
        {hasUncategorized && <FilterChip label={filters.uncategorized ? 'Needs category' : 'Categorized'} onRemove={() => clearFilter('uncategorized')} />}

        <button
          className={`flex items-center gap-1.5 text-xs border rounded px-3 py-1.5 transition-colors ${
            showFilters
              ? 'bg-green-10 text-green border-green/40'
              : 'text-muted border-border hover:text-text'
          }`}
          onClick={() => setShowFilters((v) => !v)}
        >
          <SlidersHorizontal size={13} /> Filters
        </button>
        <button
          className="flex items-center gap-1.5 text-xs text-muted border border-border rounded px-3 py-1.5 hover:text-text"
          onClick={() =>
            settingsApi.exportCsv().catch((err: unknown) =>
              addToast({ type: 'error', message: err instanceof Error ? err.message : 'Export failed' })
            )
          }
        >
          <Download size={13} /> Export
        </button>
        <button
          className="flex items-center gap-1.5 text-xs bg-text text-surface font-medium rounded px-3 py-1.5 hover:opacity-90"
          onClick={() => setShowAddModal(true)}
        >
          <Plus size={13} /> Add Transaction
        </button>
      </div>

      {/* Collapsible filter panel */}
      {showFilters && (
        <div className="flex flex-wrap gap-2 mb-4 p-3 bg-surface shadow-sm border border-border rounded">
          <input
            type="date"
            className="bg-background border border-border rounded px-2 py-1 text-xs text-text font-mono focus:outline-none focus:ring-1 focus:ring-green-50"
            value={filters.startDate ?? ''}
            onChange={(e) => { setFilters({ ...filters, startDate: e.target.value }); setPage(1); }}
          />
          <span className="text-muted text-xs self-center">to</span>
          <input
            type="date"
            className="bg-background border border-border rounded px-2 py-1 text-xs text-text font-mono focus:outline-none focus:ring-1 focus:ring-green-50"
            value={filters.endDate ?? ''}
            onChange={(e) => { setFilters({ ...filters, endDate: e.target.value }); setPage(1); }}
          />
          <input
            type="text"
            placeholder="Search..."
            className="bg-background border border-border rounded px-2 py-1 text-xs text-text focus:outline-none focus:ring-1 focus:ring-green-50 flex-1 min-w-[160px]"
            value={filters.search ?? ''}
            onChange={(e) => { setFilters({ ...filters, search: e.target.value }); setPage(1); }}
          />
          <select
            className="bg-background border border-border rounded px-2 py-1 text-xs text-text focus:outline-none focus:ring-1 focus:ring-green-50"
            value={filters.type ?? ''}
            onChange={(e) => { setFilters({ ...filters, type: e.target.value }); setPage(1); }}
          >
            <option value="">All Types</option>
            <option value="income">Income</option>
            <option value="expense">Expense</option>
          </select>
          <select
            className="bg-background border border-border rounded px-2 py-1 text-xs text-text focus:outline-none focus:ring-1 focus:ring-green-50"
            value={filters.pending === undefined ? '' : String(filters.pending)}
            onChange={(e) => {
              const v = e.target.value;
              setFilters({ ...filters, pending: v === '' ? undefined : v === 'true' });
              setPage(1);
            }}
          >
            <option value="">All Status</option>
            <option value="true">Pending</option>
            <option value="false">Posted</option>
          </select>
          <select
            className="bg-background border border-border rounded px-2 py-1 text-xs text-text focus:outline-none focus:ring-1 focus:ring-green-50"
            value={filters.recurring === undefined ? '' : String(filters.recurring)}
            onChange={(e) => {
              const v = e.target.value;
              setFilters({ ...filters, recurring: v === '' ? undefined : v === 'true' });
              setPage(1);
            }}
          >
            <option value="">All</option>
            <option value="true">Recurring</option>
            <option value="false">One-time</option>
          </select>
          <select
            className="bg-background border border-border rounded px-2 py-1 text-xs text-text focus:outline-none focus:ring-1 focus:ring-green-50"
            value={filters.uncategorized === undefined ? '' : String(filters.uncategorized)}
            onChange={(e) => {
              const v = e.target.value;
              setFilters({ ...filters, uncategorized: v === '' ? undefined : v === 'true' });
              setPage(1);
            }}
          >
            <option value="">All Categories</option>
            <option value="true">Needs Category</option>
            <option value="false">Categorized</option>
          </select>
          {hasActiveFilters && (
            <button
              className="flex items-center gap-1 text-xs text-muted hover:text-text"
              onClick={resetFilters}
            >
              <X size={12} /> Clear All
            </button>
          )}
        </div>
      )}

      <TransactionReviewPanel
        summary={reviewSummary}
        onQueueSelect={selectReviewQueue}
        onApplySuggestion={applyRuleSuggestion}
        applyingPattern={createRuleMutation.variables?.pattern ?? null}
      />

      {/* Bulk Action Bar */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-3 mb-3 px-3 py-2 bg-green-10 border border-green/30 rounded sticky top-0 z-10">
          <input
            type="checkbox"
            className="accent-green"
            checked={selectedIds.size === txs.length && txs.length > 0}
            onChange={selectAll}
          />
          <span className="text-xs text-green font-medium">{selectedIds.size} selected</span>
          <div className="ml-auto flex gap-2 items-center">
            <BulkCategoryDropdown
              categories={categories}
              onSelect={(catId) => bulkCatMutation.mutate({ ids: Array.from(selectedIds), categoryId: catId })}
            />
            <button
              className="text-xs text-muted hover:text-text"
              onClick={() => setSelectedIds(new Set())}
            >
              Clear
            </button>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="bg-surface shadow-sm border border-border rounded flex-1 overflow-hidden flex flex-col">
        <div className="overflow-y-auto flex-1">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-surface border-b border-border z-10">
              <tr>
                <th className="w-8 px-3 py-2.5">
                  <input
                    type="checkbox"
                    className="accent-green"
                    checked={selectedIds.size === txs.length && txs.length > 0}
                    onChange={selectAll}
                  />
                </th>
                <SortableHeader label="Date" col="date" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                <th className="text-left px-3 py-2.5 text-xs text-muted font-medium uppercase tracking-wider">Account</th>
                <SortableHeader label="Merchant" col="merchant" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                <th className="text-left px-3 py-2.5 text-xs text-muted font-medium uppercase tracking-wider">Category</th>
                <SortableHeader label="Amount" col="amount" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                <th className="text-left px-3 py-2.5 text-xs text-muted font-medium uppercase tracking-wider">Notes</th>
                <th className="w-8" />
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <SkeletonList rows={12} cols={8} />
              ) : isError ? (
                <tr>
                  <td colSpan={8} className="px-3 py-12 text-center text-muted text-sm">
                    Failed to load transactions
                  </td>
                </tr>
              ) : (
                txs.map((tx) => (
                  <tr key={tx.id} className={`border-b border-border hover:bg-white/2 group ${selectedIds.has(tx.id) ? 'bg-green/5' : ''}`}>
                    <td className="px-3 py-2.5">
                      <input
                        type="checkbox"
                        className="accent-green"
                        checked={selectedIds.has(tx.id)}
                        onChange={() => toggleSelect(tx.id)}
                      />
                    </td>
                    <td className="px-3 py-2.5 font-mono text-muted whitespace-nowrap">{formatDate(tx.date)}</td>
                    <td className="px-3 py-2.5 text-muted max-w-[120px]">
                      <span className="truncate block" title={tx.account_name ?? undefined}>{tx.account_name}</span>
                    </td>
                    <td className="px-3 py-2.5 text-text max-w-[180px]">
                      <div className="flex items-center gap-1.5">
                        {tx.pending && (
                          <span className="w-1.5 h-1.5 rounded-full bg-amber flex-shrink-0" title="Pending" />
                        )}
                        {tx.recurring_id && <RefreshCw size={10} className="text-muted flex-shrink-0" />}
                        <InlineEdit
                          value={tx.merchant_name || tx.original_name || ''}
                          onSave={(v) => updateMerchantMutation.mutate({ id: tx.id, merchant_name: v })}
                          className="truncate text-xs"
                          inputClassName="w-32"
                        />
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        <CategoryDropdown
                          value={tx.category_id}
                          categories={categories}
                          onChange={(catId) => updateCatMutation.mutate({ id: tx.id, categoryId: catId })}
                        />
                        {tx.category_id && (tx.merchant_name || tx.original_name) && (
                          <button
                            className="text-muted hover:text-amber opacity-0 group-hover:opacity-100 transition-colors disabled:opacity-30"
                            onClick={() => createRuleFromTransaction(tx.merchant_name || tx.original_name, tx.category_id)}
                            disabled={createRuleMutation.isPending}
                            title="Create merchant rule"
                          >
                            <Sparkles size={12} />
                          </button>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      <AmountBadge amount={tx.amount} />
                    </td>
                    <td className="px-3 py-2.5 max-w-[160px]">
                      <InlineEdit
                        value={tx.notes ?? ''}
                        onSave={(v) => updateNoteMutation.mutate({ id: tx.id, notes: v })}
                        placeholder="Add note..."
                        className="text-muted text-xs truncate"
                        inputClassName="w-32"
                      />
                    </td>
                    <td className="px-2 py-2.5">
                      {tx.is_manual && (
                        <button
                          className="text-muted hover:text-rose transition-colors opacity-0 group-hover:opacity-100"
                          onClick={() => deleteMutation.mutate(tx.id)}
                        >
                          <Trash2 size={12} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          {!isLoading && !isError && txs.length === 0 && (
            <EmptyState
              icon={FileText}
              title={emptyTitle}
              description={emptyDescription}
              action={emptyAction}
              actionLabel={emptyActionLabel}
              secondaryAction={emptySecondaryAction}
              secondaryActionLabel={emptySecondaryActionLabel}
            />
          )}
        </div>

        {/* Pagination */}
        <div className="flex items-center justify-between px-4 py-2.5 border-t border-border">
          <span className="text-xs text-muted font-mono">
            {total > 0 ? `${(page - 1) * PAGE_SIZE + 1}-${Math.min(page * PAGE_SIZE, total)} of ${total}` : '0 results'}
          </span>
          <div className="flex items-center gap-1">
            <button
              className="p-1 text-muted hover:text-text disabled:opacity-30"
              disabled={page === 1}
              onClick={() => setPage(page - 1)}
            >
              <ChevronLeft size={16} />
            </button>
            <span className="text-xs text-muted px-2">{page} / {Math.max(totalPages, 1)}</span>
            <button
              className="p-1 text-muted hover:text-text disabled:opacity-30"
              disabled={page >= totalPages}
              onClick={() => setPage(page + 1)}
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      </div>

      <AddTransactionModal
        open={showAddModal}
        onClose={() => setShowAddModal(false)}
        accounts={accounts}
        categories={categories}
      />
    </div>
  );
}
