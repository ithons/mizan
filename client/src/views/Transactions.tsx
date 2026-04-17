import React, { useState, useCallback } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import {
  Plus,
  Download,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  X,
  Check,
  Trash2,
} from 'lucide-react';
import { format, subMonths } from 'date-fns';
import { transactionsApi, accountsApi, categoriesApi, settingsApi, flattenCategories } from '../lib/api';
import { formatDate, formatCurrency } from '../lib/formatters';
import { useAppStore } from '../store';
import { Modal } from '../components/Modal';
import { AmountBadge } from '../components/AmountBadge';
import { CategoryBadge } from '../components/CategoryBadge';
import { PageLoader } from '../components/LoadingSpinner';
import type { TransactionFilters, Category } from '@shared/types';

const PAGE_SIZE = 50;

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
      qc.invalidateQueries({ queryKey: ['transactions'] });
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
            {mutation.isPending ? 'Adding…' : 'Add Transaction'}
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
  const { addToast } = useAppStore();
  const [page, setPage] = useState(1);
  const [showAddModal, setShowAddModal] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [editingNote, setEditingNote] = useState<string | null>(null);
  const [noteValue, setNoteValue] = useState('');

  const [filters, setFilters] = useState<TransactionFilters>({
    startDate: format(subMonths(new Date(), 1), 'yyyy-MM-dd'),
    endDate: format(new Date(), 'yyyy-MM-dd'),
    search: '',
    type: '',
    pending: undefined,
    recurring: undefined,
  });

  const queryFilters = { ...filters, page, limit: PAGE_SIZE };

  const { data: txData, isLoading } = useQuery({
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
    onSuccess: () => qc.invalidateQueries({ queryKey: ['transactions'] }),
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const updateNoteMutation = useMutation({
    mutationFn: ({ id, notes }: { id: string; notes: string }) =>
      transactionsApi.update(id, { notes }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['transactions'] });
      setEditingNote(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => transactionsApi.delete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['transactions'] });
      setSelectedIds(new Set());
      addToast({ type: 'success', message: 'Transaction deleted' });
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const bulkCatMutation = useMutation({
    mutationFn: ({ ids, categoryId }: { ids: string[]; categoryId: string }) =>
      transactionsApi.bulkCategory(ids, categoryId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['transactions'] });
      setSelectedIds(new Set());
      addToast({ type: 'success', message: 'Categories updated' });
    },
  });

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

  return (
    <div className="p-6 flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold text-text">Transactions</h1>
        <div className="flex items-center gap-2">
          <button
            className="flex items-center gap-1.5 text-xs text-muted border border-border rounded px-3 py-1.5 hover:text-text"
            onClick={() => settingsApi.exportCsv().catch((e) => addToast({ type: 'error', message: e.message }))}
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
      </div>

      {/* Filter Bar */}
      <div className="flex flex-wrap gap-2 mb-4 p-3 bg-surface border border-border rounded">
        <input
          type="date"
          className="bg-background border border-border rounded px-2 py-1 text-xs text-text font-mono focus:outline-none focus:ring-1 focus:ring-[#4ecba3]/50"
          value={filters.startDate ?? ''}
          onChange={(e) => setFilters({ ...filters, startDate: e.target.value })}
        />
        <span className="text-muted text-xs self-center">to</span>
        <input
          type="date"
          className="bg-background border border-border rounded px-2 py-1 text-xs text-text font-mono focus:outline-none focus:ring-1 focus:ring-[#4ecba3]/50"
          value={filters.endDate ?? ''}
          onChange={(e) => setFilters({ ...filters, endDate: e.target.value })}
        />
        <input
          type="text"
          placeholder="Search…"
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
        {(filters.search || filters.type || filters.pending !== undefined) && (
          <button
            className="flex items-center gap-1 text-xs text-muted hover:text-text"
            onClick={() => {
              setFilters({ startDate: filters.startDate, endDate: filters.endDate });
              setPage(1);
            }}
          >
            <X size={12} /> Clear
          </button>
        )}
      </div>

      {/* Bulk Action Bar */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-3 mb-3 px-3 py-2 bg-[#4ecba3]/10 border border-[#4ecba3]/30 rounded">
          <span className="text-xs text-[#4ecba3]">{selectedIds.size} selected</span>
          <select
            className="bg-background border border-border rounded px-2 py-1 text-xs text-text"
            defaultValue=""
            onChange={(e) => {
              if (e.target.value) {
                bulkCatMutation.mutate({ ids: Array.from(selectedIds), categoryId: e.target.value });
              }
            }}
          >
            <option value="" disabled>Assign Category…</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <button
            className="text-xs text-muted hover:text-text"
            onClick={() => setSelectedIds(new Set())}
          >
            Clear
          </button>
        </div>
      )}

      {/* Table */}
      {isLoading ? (
        <PageLoader />
      ) : (
        <div className="bg-surface border border-border rounded flex-1 overflow-hidden flex flex-col">
          <div className="overflow-y-auto flex-1">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-surface border-b border-border">
                <tr>
                  <th className="w-8 px-3 py-2">
                    <input
                      type="checkbox"
                      className="accent-[#4ecba3]"
                      checked={selectedIds.size === txs.length && txs.length > 0}
                      onChange={selectAll}
                    />
                  </th>
                  {['Date', 'Account', 'Merchant', 'Category', 'Amount', 'Notes'].map((h) => (
                    <th key={h} className="text-left px-3 py-2 text-muted font-medium">{h}</th>
                  ))}
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {txs.map((tx) => (
                  <tr key={tx.id} className={`border-b border-border hover:bg-white/2 ${selectedIds.has(tx.id) ? 'bg-[#4ecba3]/5' : ''}`}>
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        className="accent-[#4ecba3]"
                        checked={selectedIds.has(tx.id)}
                        onChange={() => toggleSelect(tx.id)}
                      />
                    </td>
                    <td className="px-3 py-2 font-mono text-muted whitespace-nowrap">{formatDate(tx.date)}</td>
                    <td className="px-3 py-2 text-muted max-w-[120px]">
                      <span className="truncate block">{tx.account_name}</span>
                    </td>
                    <td className="px-3 py-2 text-text max-w-[160px]">
                      <div className="flex items-center gap-1">
                        {tx.recurring_id && <RefreshCw size={10} className="text-muted flex-shrink-0" />}
                        <span className="truncate">{tx.merchant_name || tx.original_name}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <CategoryDropdown
                        value={tx.category_id}
                        categories={categories}
                        onChange={(catId) => updateCatMutation.mutate({ id: tx.id, categoryId: catId })}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <AmountBadge amount={tx.amount} />
                    </td>
                    <td className="px-3 py-2 max-w-[160px]">
                      {editingNote === tx.id ? (
                        <div className="flex items-center gap-1">
                          <input
                            autoFocus
                            className="bg-background border border-border rounded px-2 py-0.5 text-xs text-text w-full focus:outline-none"
                            value={noteValue}
                            onChange={(e) => setNoteValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') updateNoteMutation.mutate({ id: tx.id, notes: noteValue });
                              if (e.key === 'Escape') setEditingNote(null);
                            }}
                          />
                          <button onClick={() => updateNoteMutation.mutate({ id: tx.id, notes: noteValue })}>
                            <Check size={11} className="text-[#4ecba3]" />
                          </button>
                          <button onClick={() => setEditingNote(null)}>
                            <X size={11} className="text-muted" />
                          </button>
                        </div>
                      ) : (
                        <button
                          className="text-muted hover:text-text truncate block w-full text-left"
                          onClick={() => { setEditingNote(tx.id); setNoteValue(tx.notes ?? ''); }}
                        >
                          {tx.notes || <span className="opacity-30">Add note…</span>}
                        </button>
                      )}
                    </td>
                    <td className="px-2 py-2">
                      {tx.is_manual && (
                        <button
                          className="text-muted hover:text-[#e07070] transition-colors"
                          onClick={() => deleteMutation.mutate(tx.id)}
                        >
                          <Trash2 size={12} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {txs.length === 0 && (
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
      )}

      <AddTransactionModal
        open={showAddModal}
        onClose={() => setShowAddModal(false)}
        accounts={accounts}
        categories={categories}
      />
    </div>
  );
}
