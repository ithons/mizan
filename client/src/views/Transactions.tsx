import React, { useState } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import {
  Plus,
  Download,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  X,
  Trash2,
  SlidersHorizontal,
} from 'lucide-react';
import { format, subMonths } from 'date-fns';
import { transactionsApi, accountsApi, categoriesApi, settingsApi, flattenCategories } from '../lib/api';
import { formatDate, formatCurrency } from '../lib/formatters';
import { useAppStore } from '../store';
import { Modal } from '../components/Modal';
import { AmountBadge } from '../components/AmountBadge';
import { CategoryBadge } from '../components/CategoryBadge';
import { InlineEdit } from '../components/InlineEdit';
import { SkeletonList } from '../components/SkeletonLoader';
import { invalidateFinancialData } from '../lib/queryInvalidation';
import type { TransactionFilters, Category } from '@shared/types';

const PAGE_SIZE = 50;

type SortCol = 'date' | 'amount' | 'merchant';
type SortDir = 'asc' | 'desc';

// ─── Sortable header ──────────────────────────────────────────────────────────

function SortableHeader({
  label,
  col,
  sortBy,
  sortDir,
  onSort,
}: {
  label: string;
  col: SortCol;
  sortBy: SortCol;
  sortDir: SortDir;
  onSort: (col: SortCol) => void;
}) {
  const active = sortBy === col;
  return (
    <th
      className="text-left px-3 py-2.5 text-xs text-muted font-medium uppercase tracking-wider cursor-pointer select-none hover:text-text"
      onClick={() => onSort(col)}
    >
      <span className="flex items-center gap-1">
        {label}
        {active ? (
          sortDir === 'asc' ? <ChevronUp size={11} /> : <ChevronDown size={11} />
        ) : (
          <ChevronDown size={11} className="opacity-0 group-hover:opacity-30" />
        )}
      </span>
    </th>
  );
}

// ─── Category dropdown ────────────────────────────────────────────────────────

function CategoryDropdown({
  value,
  categories,
  onChange,
}: {
  value: string | null | undefined;
  categories: Category[];
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = categories.find((c) => c.id === value);

  return (
    <div className="relative">
      <button
        className="flex items-center gap-1 hover:opacity-80"
        onClick={() => setOpen(!open)}
      >
        {selected ? (
          <CategoryBadge name={selected.name} color={selected.color} icon={selected.icon} />
        ) : (
          <span className="text-xs text-muted">Uncategorized</span>
        )}
      </button>
      {open && (
        <div className="absolute left-0 top-6 bg-surface border border-border rounded shadow-xl z-30 w-52 max-h-64 overflow-y-auto">
          {categories.map((cat) => (
            <button
              key={cat.id}
              className="flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-white/5 text-left"
              onClick={() => { onChange(cat.id); setOpen(false); }}
            >
              <CategoryBadge name={cat.name} color={cat.color} icon={cat.icon} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Bulk category dropdown ───────────────────────────────────────────────────

function BulkCategoryDropdown({
  categories,
  onSelect,
}: {
  categories: Category[];
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        className="flex items-center gap-1 text-xs border border-border rounded px-2 py-1 text-text hover:bg-white/5"
        onClick={() => setOpen(!open)}
      >
        Assign Category <ChevronDown size={11} />
      </button>
      {open && (
        <div className="absolute left-0 top-7 bg-surface border border-border rounded shadow-xl z-30 w-52 max-h-64 overflow-y-auto">
          {categories.map((cat) => (
            <button
              key={cat.id}
              className="flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-white/5 text-left"
              onClick={() => { onSelect(cat.id); setOpen(false); }}
            >
              <CategoryBadge name={cat.name} color={cat.color} icon={cat.icon} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

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
    mutationFn: () =>
      transactionsApi.createManual({
        ...form,
        amount: parseFloat(form.amount) || 0,
        original_name: form.merchant_name,
      }),
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
              className="w-full bg-background border border-border rounded px-3 py-2 text-sm text-text font-mono focus:outline-none focus:ring-1 focus:ring-[#4ecba3]/50"
              value={form.date}
              onChange={(e) => setForm({ ...form, date: e.target.value })}
            />
          </div>
          <div>
            <label className="block text-xs text-muted mb-1">Amount</label>
            <input
              type="number"
              step="0.01"
              className="w-full bg-background border border-border rounded px-3 py-2 text-sm text-text font-mono focus:outline-none focus:ring-1 focus:ring-[#4ecba3]/50"
              value={form.amount}
              onChange={(e) => setForm({ ...form, amount: e.target.value })}
              placeholder="0.00"
            />
          </div>
        </div>
        <div>
          <label className="block text-xs text-muted mb-1">Merchant</label>
          <input
            className="w-full bg-background border border-border rounded px-3 py-2 text-sm text-text focus:outline-none focus:ring-1 focus:ring-[#4ecba3]/50"
            value={form.merchant_name}
            onChange={(e) => setForm({ ...form, merchant_name: e.target.value })}
            placeholder="Amazon"
          />
        </div>
        <div>
          <label className="block text-xs text-muted mb-1">Account</label>
          <select
            className="w-full bg-background border border-border rounded px-3 py-2 text-sm text-text focus:outline-none focus:ring-1 focus:ring-[#4ecba3]/50"
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
            className="w-full bg-background border border-border rounded px-3 py-2 text-sm text-text focus:outline-none focus:ring-1 focus:ring-[#4ecba3]/50"
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
            className="w-full bg-background border border-border rounded px-3 py-2 text-sm text-text focus:outline-none focus:ring-1 focus:ring-[#4ecba3]/50"
            value={form.notes}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
            placeholder="Optional"
          />
        </div>
        <div className="flex gap-3 pt-1">
          <button
            className="flex-1 py-2 text-sm bg-[#4ecba3] text-[#0f0f11] font-medium rounded hover:opacity-90"
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

// ─── Filter chip ──────────────────────────────────────────────────────────────

function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="flex items-center gap-1 text-xs bg-border/60 text-text px-2 py-0.5 rounded-full">
      {label}
      <button onClick={onRemove} className="text-muted hover:text-text">
        <X size={10} />
      </button>
    </span>
  );
}

// ─── Main view ────────────────────────────────────────────────────────────────

export function Transactions() {
  const qc = useQueryClient();
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
  });

  const queryFilters = { ...filters, page, limit: PAGE_SIZE };

  const { data: txData, isLoading, isError } = useQuery({
    queryKey: ['transactions', queryFilters],
    queryFn: () => transactionsApi.list(queryFilters),
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

  const rawTxs = txData?.data ?? [];
  const total = txData?.total ?? 0;
  const totalPages = Math.ceil(total / PAGE_SIZE);

  // Client-side sort on current page
  const txs = [...rawTxs].sort((a, b) => {
    let cmp = 0;
    if (sortBy === 'date') {
      cmp = a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
    } else if (sortBy === 'amount') {
      cmp = a.amount - b.amount;
    } else if (sortBy === 'merchant') {
      const am = (a.merchant_name || a.original_name || '').toLowerCase();
      const bm = (b.merchant_name || b.original_name || '').toLowerCase();
      cmp = am < bm ? -1 : am > bm ? 1 : 0;
    }
    return sortDir === 'asc' ? cmp : -cmp;
  });

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
    setFilters((f) => ({ ...f, [key]: key === 'pending' || key === 'recurring' ? undefined : '' }));
    setPage(1);
  };

  const hasSearch = !!filters.search;
  const hasType = !!filters.type;
  const hasPending = filters.pending !== undefined;
  const hasRecurring = filters.recurring !== undefined;
  const isDefaultDateRange = filters.startDate === DEFAULT_START && filters.endDate === DEFAULT_END;
  const hasDateRange = !isDefaultDateRange;

  return (
    <div className="p-6 flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <h1 className="text-xl font-semibold text-text mr-auto">Transactions</h1>
        {/* Active filter chips */}
        {hasDateRange && (
          <FilterChip
            label={`${filters.startDate} → ${filters.endDate}`}
            onRemove={() => { setFilters((f) => ({ ...f, startDate: DEFAULT_START, endDate: DEFAULT_END })); setPage(1); }}
          />
        )}
        {hasSearch && <FilterChip label={`"${filters.search}"`} onRemove={() => clearFilter('search')} />}
        {hasType && <FilterChip label={filters.type as string} onRemove={() => clearFilter('type')} />}
        {hasPending && <FilterChip label={filters.pending ? 'Pending' : 'Posted'} onRemove={() => clearFilter('pending')} />}
        {hasRecurring && <FilterChip label={filters.recurring ? 'Recurring' : 'One-time'} onRemove={() => clearFilter('recurring')} />}

        <button
          className={`flex items-center gap-1.5 text-xs border rounded px-3 py-1.5 transition-colors ${
            showFilters
              ? 'bg-[#4ecba3]/10 text-[#4ecba3] border-[#4ecba3]/40'
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
          className="flex items-center gap-1.5 text-xs bg-[#4ecba3] text-[#0f0f11] font-medium rounded px-3 py-1.5 hover:opacity-90"
          onClick={() => setShowAddModal(true)}
        >
          <Plus size={13} /> Add Transaction
        </button>
      </div>

      {/* Collapsible filter panel */}
      {showFilters && (
        <div className="flex flex-wrap gap-2 mb-4 p-3 bg-surface border border-border rounded">
          <input
            type="date"
            className="bg-background border border-border rounded px-2 py-1 text-xs text-text font-mono focus:outline-none focus:ring-1 focus:ring-[#4ecba3]/50"
            value={filters.startDate ?? ''}
            onChange={(e) => { setFilters({ ...filters, startDate: e.target.value }); setPage(1); }}
          />
          <span className="text-muted text-xs self-center">to</span>
          <input
            type="date"
            className="bg-background border border-border rounded px-2 py-1 text-xs text-text font-mono focus:outline-none focus:ring-1 focus:ring-[#4ecba3]/50"
            value={filters.endDate ?? ''}
            onChange={(e) => { setFilters({ ...filters, endDate: e.target.value }); setPage(1); }}
          />
          <input
            type="text"
            placeholder="Search..."
            className="bg-background border border-border rounded px-2 py-1 text-xs text-text focus:outline-none focus:ring-1 focus:ring-[#4ecba3]/50 flex-1 min-w-[160px]"
            value={filters.search ?? ''}
            onChange={(e) => { setFilters({ ...filters, search: e.target.value }); setPage(1); }}
          />
          <select
            className="bg-background border border-border rounded px-2 py-1 text-xs text-text focus:outline-none focus:ring-1 focus:ring-[#4ecba3]/50"
            value={filters.type ?? ''}
            onChange={(e) => { setFilters({ ...filters, type: e.target.value }); setPage(1); }}
          >
            <option value="">All Types</option>
            <option value="income">Income</option>
            <option value="expense">Expense</option>
          </select>
          <select
            className="bg-background border border-border rounded px-2 py-1 text-xs text-text focus:outline-none focus:ring-1 focus:ring-[#4ecba3]/50"
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
            className="bg-background border border-border rounded px-2 py-1 text-xs text-text focus:outline-none focus:ring-1 focus:ring-[#4ecba3]/50"
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
          {(hasSearch || hasType || hasPending || hasRecurring || hasDateRange) && (
            <button
              className="flex items-center gap-1 text-xs text-muted hover:text-text"
              onClick={() => {
                setFilters({ startDate: DEFAULT_START, endDate: DEFAULT_END, search: '', type: '', pending: undefined, recurring: undefined });
                setPage(1);
              }}
            >
              <X size={12} /> Clear All
            </button>
          )}
        </div>
      )}

      {/* Bulk Action Bar */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-3 mb-3 px-3 py-2 bg-[#4ecba3]/10 border border-[#4ecba3]/30 rounded sticky top-0 z-10">
          <input
            type="checkbox"
            className="accent-[#4ecba3]"
            checked={selectedIds.size === txs.length && txs.length > 0}
            onChange={selectAll}
          />
          <span className="text-xs text-[#4ecba3] font-medium">{selectedIds.size} selected</span>
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
      <div className="bg-surface border border-border rounded flex-1 overflow-hidden flex flex-col">
        <div className="overflow-y-auto flex-1">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-surface border-b border-border z-10">
              <tr>
                <th className="w-8 px-3 py-2.5">
                  <input
                    type="checkbox"
                    className="accent-[#4ecba3]"
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
                  <tr key={tx.id} className={`border-b border-border hover:bg-white/2 group ${selectedIds.has(tx.id) ? 'bg-[#4ecba3]/5' : ''}`}>
                    <td className="px-3 py-2.5">
                      <input
                        type="checkbox"
                        className="accent-[#4ecba3]"
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
                          <span className="w-1.5 h-1.5 rounded-full bg-[#f0c040] flex-shrink-0" title="Pending" />
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
                      <CategoryDropdown
                        value={tx.category_id}
                        categories={categories}
                        onChange={(catId) => updateCatMutation.mutate({ id: tx.id, categoryId: catId })}
                      />
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
                          className="text-muted hover:text-[#e07070] transition-colors opacity-0 group-hover:opacity-100"
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
            <div className="py-16 text-center text-muted text-sm">
              No transactions found
            </div>
          )}
        </div>

        {/* Pagination */}
        <div className="flex items-center justify-between px-4 py-2.5 border-t border-border">
          <span className="text-xs text-muted font-mono">
            {total > 0 ? `${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, total)} of ${total}` : '0 results'}
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
