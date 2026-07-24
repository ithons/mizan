import { useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format, isToday, isYesterday, parseISO, startOfMonth, endOfMonth, subMonths, startOfYear } from 'date-fns';
import type { Transaction } from '@shared/types';
import { categoriesApi, accountsApi, transactionsApi } from '../lib/api';
import { formatCurrency } from '../lib/formatters';
import { invalidateFinancialData } from '../lib/queryInvalidation';
import { parseDecimalInput } from '../lib/numberInput';
import { useAppStore } from '../store';
import { Modal } from '../components/Modal';
import { SkeletonRows } from '../components/SkeletonLoader';
import { Screen, ScreenHeader, CategoryPill, InkButton, Select, TextButton, CategoryPicker } from '../components/balance';

// ─── Date-range presets ───────────────────────────────────────────────────────

const RANGES = [
  { id: 'this-month', label: 'This month' },
  { id: 'last-month', label: 'Last month' },
  { id: 'three-months', label: 'Last 3 months' },
  { id: 'this-year', label: 'This year' },
  { id: 'all', label: 'All time' },
] as const;
type RangeId = (typeof RANGES)[number]['id'];

function rangeDates(id: RangeId): { startDate?: string; endDate?: string } {
  const now = new Date();
  const fmt = (d: Date) => format(d, 'yyyy-MM-dd');
  switch (id) {
    case 'this-month':
      return { startDate: fmt(startOfMonth(now)), endDate: fmt(endOfMonth(now)) };
    case 'last-month': {
      const prev = subMonths(now, 1);
      return { startDate: fmt(startOfMonth(prev)), endDate: fmt(endOfMonth(prev)) };
    }
    case 'three-months':
      return { startDate: fmt(startOfMonth(subMonths(now, 2))), endDate: fmt(endOfMonth(now)) };
    case 'this-year':
      return { startDate: fmt(startOfYear(now)), endDate: fmt(now) };
    case 'all':
      return {};
  }
}

function dayLabel(dateStr: string): string {
  const d = parseISO(dateStr);
  if (isToday(d)) return `Today · ${format(d, 'MMM d')}`;
  if (isYesterday(d)) return `Yesterday · ${format(d, 'MMM d')}`;
  return format(d, 'EEEE · MMM d');
}

function merchantLabel(t: Transaction): string {
  return (t.merchant_name || t.original_name).trim();
}

// ─── Add / edit transaction modals ────────────────────────────────────────────

function AddTransactionModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const { addToast } = useAppStore();
  const { data: accounts } = useQuery({ queryKey: ['accounts'], queryFn: () => accountsApi.list() });
  const { data: categories } = useQuery({ queryKey: ['categories'], queryFn: () => categoriesApi.list() });
  const [form, setForm] = useState({
    date: format(new Date(), 'yyyy-MM-dd'),
    merchant: '',
    amount: '',
    direction: 'expense' as 'expense' | 'income',
    account_id: '',
    category_id: '',
    notes: '',
  });

  const mutation = useMutation({
    mutationFn: () => {
      const parsed = parseDecimalInput(form.amount);
      if (parsed === null || parsed <= 0) throw new Error('Enter a valid amount');
      if (!form.account_id) throw new Error('Pick an account');
      if (!form.merchant.trim()) throw new Error('Enter a merchant');
      return transactionsApi.createManual({
        account_id: form.account_id,
        date: form.date,
        amount: form.direction === 'expense' ? -Math.abs(parsed) : Math.abs(parsed),
        merchant_name: form.merchant.trim(),
        original_name: form.merchant.trim(),
        category_id: form.category_id || undefined,
        notes: form.notes || undefined,
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
    <Modal open={open} onClose={onClose} title="Add transaction">
      <div className="space-y-4">
        <div className="flex gap-4">
          <div className="flex-1">
            <label className="mz-label">Date</label>
            <input type="date" className="mz-field" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
          </div>
          <div className="flex-1">
            <label className="mz-label">Amount</label>
            <div className="flex gap-2">
              <select
                className="mz-field !w-[64px]"
                value={form.direction}
                onChange={(e) => setForm({ ...form, direction: e.target.value as 'expense' | 'income' })}
              >
                <option value="expense">−</option>
                <option value="income">+</option>
              </select>
              <input
                type="number"
                className="mz-field tabular-nums"
                placeholder="0.00"
                value={form.amount}
                onChange={(e) => setForm({ ...form, amount: e.target.value })}
              />
            </div>
          </div>
        </div>
        <div>
          <label className="mz-label">Merchant</label>
          <input
            className="mz-field"
            placeholder="Blue Bottle Coffee"
            value={form.merchant}
            onChange={(e) => setForm({ ...form, merchant: e.target.value })}
          />
        </div>
        <div className="flex gap-4">
          <div className="flex-1">
            <label className="mz-label">Account</label>
            <select className="mz-field" value={form.account_id} onChange={(e) => setForm({ ...form, account_id: e.target.value })}>
              <option value="">Pick an account…</option>
              {(accounts ?? [])
                .filter((a) => !a.is_hidden)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.account_name}
                  </option>
                ))}
            </select>
          </div>
          <div className="flex-1">
            <label className="mz-label">Category</label>
            <CategoryPicker
              variant="field" value={form.category_id} categories={categories ?? []}
              onChange={(v) => setForm({ ...form, category_id: v })} placeholder="Uncategorized"
            />
          </div>
        </div>
        <div>
          <label className="mz-label">Notes</label>
          <input className="mz-field" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
        </div>
        <div className="flex items-center gap-5 pt-1">
          <InkButton onClick={() => mutation.mutate()} disabled={mutation.isPending}>
            {mutation.isPending ? 'Adding…' : 'Add transaction'}
          </InkButton>
          <TextButton onClick={onClose}>Cancel</TextButton>
        </div>
      </div>
    </Modal>
  );
}

function EditTransactionModal({ transaction, onClose }: { transaction: Transaction | null; onClose: () => void }) {
  const qc = useQueryClient();
  const { addToast } = useAppStore();
  const { data: categories } = useQuery({ queryKey: ['categories'], queryFn: () => categoriesApi.list() });
  const [categoryId, setCategoryId] = useState('');
  const [notes, setNotes] = useState('');

  useEffect(() => {
    if (transaction) {
      setCategoryId(transaction.category_id ?? '');
      setNotes(transaction.notes ?? '');
    }
  }, [transaction]);

  const save = useMutation({
    mutationFn: () =>
      transactionsApi.update(transaction!.id, {
        category_id: categoryId || null,
        notes: notes || null,
      }),
    onSuccess: () => {
      invalidateFinancialData(qc);
      addToast({ type: 'success', message: 'Transaction updated' });
      onClose();
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const remove = useMutation({
    mutationFn: () => transactionsApi.delete(transaction!.id),
    onSuccess: () => {
      invalidateFinancialData(qc);
      addToast({ type: 'success', message: 'Transaction deleted' });
      onClose();
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  if (!transaction) return null;

  return (
    <Modal open onClose={onClose} title={merchantLabel(transaction)}>
      <div className="space-y-4">
        <div className="flex items-baseline justify-between">
          <span className="text-[13px] text-muted">
            {format(parseISO(transaction.date), 'MMM d, yyyy')} · {transaction.account_name}
          </span>
          <span className={`font-serif text-[22px] tabular-nums ${transaction.amount > 0 ? 'text-sage-deep' : 'text-ink'}`}>
            {formatCurrency(transaction.amount, { showSign: transaction.amount > 0 })}
          </span>
        </div>
        <div>
          <label className="mz-label">Category</label>
          <CategoryPicker
            variant="field" value={categoryId} categories={categories ?? []}
            onChange={setCategoryId} placeholder="Uncategorized"
          />
        </div>
        <div>
          <label className="mz-label">Notes</label>
          <input className="mz-field" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
        <div className="flex items-center gap-5 pt-1">
          <InkButton onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </InkButton>
          <TextButton onClick={onClose}>Cancel</TextButton>
          {transaction.is_manual && (
            <TextButton onClick={() => remove.mutate()} disabled={remove.isPending} className="ml-auto hover:!text-clay">
              Delete
            </TextButton>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ─── Main view ────────────────────────────────────────────────────────────────

export function Transactions() {
  const qc = useQueryClient();
  const { addToast } = useAppStore();

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [accountFilter, setAccountFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [range, setRange] = useState<RangeId>('this-month');
  const [reviewOnly, setReviewOnly] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [editing, setEditing] = useState<Transaction | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkCategory, setBulkCategory] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  // Selection doesn't survive a filter change; the visible set is different.
  useEffect(() => {
    setSelectedIds(new Set());
  }, [range, debouncedSearch, accountFilter, categoryFilter, reviewOnly]);

  // Command palette "Add transaction" action
  useEffect(() => {
    const open = () => setShowAddModal(true);
    window.addEventListener('mizan:add-transaction', open);
    return () => window.removeEventListener('mizan:add-transaction', open);
  }, []);

  const filters = useMemo(
    () => ({
      ...rangeDates(range),
      search: debouncedSearch || undefined,
      accountId: accountFilter ? [accountFilter] : undefined,
      categoryId: categoryFilter ? [categoryFilter] : undefined,
      uncategorized: reviewOnly || undefined,
      reviewStatus: reviewOnly ? ('open' as const) : undefined,
      limit: 100,
    }),
    [range, debouncedSearch, accountFilter, categoryFilter, reviewOnly]
  );

  const {
    data: pages,
    isLoading,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  } = useInfiniteQuery({
    queryKey: ['transactions', filters],
    queryFn: ({ pageParam }) => transactionsApi.list({ ...filters, page: pageParam }),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.page * last.limit < last.total ? last.page + 1 : undefined),
  });
  const { data: reviewSummary } = useQuery({ queryKey: ['transactions', 'review'], queryFn: () => transactionsApi.review() });
  const { data: accounts } = useQuery({ queryKey: ['accounts'], queryFn: () => accountsApi.list() });
  const { data: categories } = useQuery({ queryKey: ['categories'], queryFn: () => categoriesApi.list() });

  const transactions = useMemo(() => pages?.pages.flatMap((p) => p.data) ?? [], [pages]);
  const totalCount = pages?.pages[0]?.total ?? 0;
  const reviewCount = reviewSummary?.total_open ?? 0;

  const dayGroups = useMemo(() => {
    const map = new Map<string, Transaction[]>();
    for (const t of transactions) {
      const list = map.get(t.date) ?? [];
      list.push(t);
      map.set(t.date, list);
    }
    return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [transactions]);

  const onError = (err: Error) => addToast({ type: 'error', message: err.message });

  const bulkCategorize = useMutation({
    mutationFn: ({ ids, categoryId }: { ids: string[]; categoryId: string }) => transactionsApi.bulkCategory(ids, categoryId),
    onSuccess: (_, { ids }) => {
      invalidateFinancialData(qc);
      addToast({ type: 'success', message: `Categorized ${ids.length} transaction${ids.length === 1 ? '' : 's'}` });
      setSelectedIds(new Set());
      setBulkCategory('');
    },
    onError,
  });
  const toggleSelected = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });


  return (
    <Screen size="wide">
      <ScreenHeader
        title="Transactions"
        sub={
          <>
            <span className="tabular-nums">{totalCount.toLocaleString()}</span> transaction{totalCount === 1 ? '' : 's'} ·{' '}
            {RANGES.find((r) => r.id === range)?.label.toLowerCase()}
          </>
        }
        actions={
          <button type="button" onClick={() => setShowAddModal(true)} className="text-[13.5px] text-ink transition-opacity hover:opacity-75">
            + Add transaction
          </button>
        }
        className="mb-6"
      />

      {/* Controls row */}
      <div className="mb-6 flex flex-shrink-0 flex-wrap items-center gap-5">
        <div className="flex max-w-[420px] flex-1 items-center gap-2.5 border-b border-line-3 px-0.5 py-2">
          <span className="text-sm text-muted-2">⌕</span>
          <input
            className="w-full border-none bg-transparent p-0 text-sm text-ink placeholder:text-muted-2 focus:outline-none focus:ring-0"
            placeholder="Search merchant, note, or amount"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Select
          value={accountFilter}
          onChange={setAccountFilter}
          placeholder="All accounts"
          options={(accounts ?? [])
            .filter((a) => !a.is_hidden)
            .map((a) => ({ value: a.id, label: a.account_name }))}
        />
        <CategoryPicker
          value={categoryFilter}
          onChange={setCategoryFilter}
          placeholder="Category"
          categories={categories ?? []}
        />
        <Select
          value={range}
          onChange={(v) => setRange(v as RangeId)}
          placeholder="This month"
          clearable={false}
          options={RANGES.map((r) => ({ value: r.id, label: r.label }))}
        />
        <button
          type="button"
          onClick={() => setReviewOnly((v) => !v)}
          className={`text-[13.5px] text-review-text transition-colors ${
            reviewOnly ? 'rounded-md bg-review-active px-2.5 py-1' : 'hover:opacity-75'
          }`}
        >
          Needs review · {reviewCount}
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="min-w-0 flex-1">
          {/* Column header, swapped for a bulk action bar while rows are selected */}
          {selectedIds.size > 0 ? (
            <div className="mz-rise-fast flex flex-wrap items-center gap-4 rounded-lg bg-rail px-3 py-2">
              <span className="text-[13px] text-ink">
                {selectedIds.size} selected
              </span>
              <CategoryPicker
                value={bulkCategory}
                onChange={setBulkCategory}
                placeholder="Set category…"
                clearable={false}
                categories={categories ?? []}
              />
              <button
                type="button"
                disabled={!bulkCategory || bulkCategorize.isPending}
                onClick={() => bulkCategorize.mutate({ ids: [...selectedIds], categoryId: bulkCategory })}
                className="border-b border-ink pb-0.5 text-[13.5px] text-ink transition-opacity disabled:opacity-40"
              >
                {bulkCategorize.isPending ? 'Applying…' : 'Apply'}
              </button>
              <TextButton onClick={() => setSelectedIds(new Set())} className="ml-auto">
                Clear
              </TextButton>
            </div>
          ) : (
            <div className="flex items-center px-3 pb-2 text-[11px] uppercase tracking-[0.1em] text-muted-2">
              <span className="w-[26px]" />
              <span className="flex-1">Merchant</span>
              <span className="w-[130px]">Account</span>
              <span className="w-[110px] text-right">Amount</span>
            </div>
          )}

          {isLoading && <SkeletonRows rows={6} />}

          {!isLoading && dayGroups.length === 0 && (
            <div className="px-3 py-10 text-[14px] text-muted">
              {debouncedSearch || accountFilter || categoryFilter || reviewOnly
                ? 'Nothing matches these filters.'
                : 'No transactions in this period.'}
            </div>
          )}

          {dayGroups.map(([date, rows]) => (
            <div key={date}>
              <div className="px-1 pb-1 pt-5 text-[11px] uppercase tracking-[0.18em] text-muted-2 first:pt-0">{dayLabel(date)}</div>
              {rows.map((t) => (
                <div
                  key={t.id}
                  onClick={() => setEditing(t)}
                  className="group flex cursor-pointer items-center rounded-lg border-b border-line px-3 py-3 transition-colors hover:bg-rail"
                >
                  <button
                    type="button"
                    aria-label={selectedIds.has(t.id) ? 'Deselect transaction' : 'Select transaction'}
                    aria-pressed={selectedIds.has(t.id)}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleSelected(t.id);
                    }}
                    className={`mr-3 h-[14px] w-[14px] flex-shrink-0 rounded-full border transition-all ${
                      selectedIds.has(t.id)
                        ? 'border-sage bg-sage'
                        : `border-line-3 ${selectedIds.size > 0 ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`
                    }`}
                  />
                  <div className="min-w-0 flex-1 pr-3">
                    <div className="truncate text-[15px] text-ink">{merchantLabel(t)}</div>
                    <div className="mt-1">
                      <CategoryPill name={t.category_name} />
                    </div>
                  </div>
                  <span className="w-[130px] truncate text-[13px] text-muted">{t.account_name}</span>
                  <span className={`w-[110px] text-right font-serif text-[18px] tabular-nums ${t.amount > 0 ? 'text-sage-deep' : 'text-ink'}`}>
                    {formatCurrency(t.amount, { showSign: t.amount > 0 })}
                  </span>
                </div>
              ))}
            </div>
          ))}

          {hasNextPage && (
            <div className="flex justify-center py-6">
              <TextButton onClick={() => fetchNextPage()} disabled={isFetchingNextPage}>
                {isFetchingNextPage ? 'Loading…' : `Load more · ${(totalCount - transactions.length).toLocaleString()} remaining`}
              </TextButton>
            </div>
          )}
        </div>
      </div>

      <AddTransactionModal open={showAddModal} onClose={() => setShowAddModal(false)} />
      <EditTransactionModal transaction={editing} onClose={() => setEditing(null)} />
    </Screen>
  );
}
