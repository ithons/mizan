import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format, isToday, isYesterday, parseISO, startOfMonth, endOfMonth, subMonths, startOfYear } from 'date-fns';
import type {
  AdvisorDraftAction,
  Category,
  DuplicateCandidateGroup,
  MerchantRuleSuggestion,
  RecurringPattern,
  Transaction,
  TransferCandidatePair,
} from '@shared/types';
import { aiApi, categoriesApi, accountsApi, flattenCategories, recurringApi, rulesApi, transactionsApi } from '../lib/api';
import { formatCurrency } from '../lib/formatters';
import { invalidateFinancialData } from '../lib/queryInvalidation';
import { parseDecimalInput } from '../lib/numberInput';
import { useAppStore } from '../store';
import { Modal } from '../components/Modal';
import { Screen, ScreenHeader, CategoryPill, InkButton, TextButton } from '../components/balance';

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

function categoryOptions(categories: Category[]) {
  return flattenCategories(categories).map((c) => (
    <option key={c.id} value={c.id}>
      {c.parent_id ? `· ${c.name}` : c.name}
    </option>
  ));
}

// ─── Review queue model ───────────────────────────────────────────────────────

interface QueueItem {
  key: string;
  kind: string;
  title: string;
  sub: string;
  primaryLabel: string;
  onPrimary: () => void;
  /** Set for uncategorized transactions: Confirm needs a category picked inline. */
  needsCategory?: boolean;
  onPickCategory?: (categoryId: string) => void;
  secondaryLabel?: string;
  onSecondary?: () => void;
}

function ReviewPanel({
  totalOpen,
  items,
  categories,
  batchCount,
  onBatchConfirm,
  batchPending,
}: {
  totalOpen: number;
  items: QueueItem[];
  categories: Category[];
  batchCount: number;
  onBatchConfirm: () => void;
  batchPending: boolean;
}) {
  const [pickedCategory, setPickedCategory] = useState('');
  const focus = items[0];
  const rest = items.slice(1, 4);

  useEffect(() => setPickedCategory(''), [focus?.key]);

  return (
    <div className="w-[300px] flex-shrink-0">
      <div className="mb-4 flex items-baseline justify-between">
        <span className="font-serif text-xl text-ink">Review</span>
        <span className="text-[12.5px] text-muted">
          {totalOpen} item{totalOpen === 1 ? '' : 's'}
        </span>
      </div>

      {focus ? (
        <>
          <div className="border-l-2 border-sage-soft pl-[18px]">
            <div className="mb-1.5 text-[11px] uppercase tracking-[0.15em] text-muted-2">{focus.kind}</div>
            <div className="mb-0.5 text-[15.5px] text-ink">{focus.title}</div>
            <div className="text-[13px] leading-normal text-muted">{focus.sub}</div>
            {focus.needsCategory && (
              <select
                className="mz-field mt-3 !py-1.5 text-[13px]"
                value={pickedCategory}
                onChange={(e) => setPickedCategory(e.target.value)}
              >
                <option value="">Pick a category…</option>
                {categoryOptions(categories)}
              </select>
            )}
            <div className="mt-3.5 flex items-center gap-5 text-[13.5px]">
              <button
                type="button"
                disabled={focus.needsCategory && !pickedCategory}
                onClick={() => {
                  if (focus.needsCategory) {
                    if (pickedCategory) focus.onPickCategory?.(pickedCategory);
                  } else {
                    focus.onPrimary();
                  }
                }}
                className="border-b border-ink pb-0.5 text-ink transition-opacity disabled:opacity-40"
              >
                {focus.primaryLabel}
              </button>
              {focus.secondaryLabel && focus.onSecondary && (
                <button type="button" onClick={focus.onSecondary} className="text-muted transition-colors hover:text-ink">
                  {focus.secondaryLabel}
                </button>
              )}
            </div>
          </div>

          {rest.length > 0 && (
            <div className="mt-6 flex flex-col">
              {rest.map((item) => (
                <div key={item.key} className="border-t border-line px-0.5 py-3">
                  <div className="text-sm text-ink">
                    {item.kind} · {item.title}
                  </div>
                  <div className="mt-0.5 text-xs text-muted-2">{item.sub}</div>
                </div>
              ))}
            </div>
          )}

          {batchCount > 0 && (
            <button
              type="button"
              onClick={onBatchConfirm}
              disabled={batchPending}
              className="mt-6 rounded-md border border-sage-tint-border bg-sage-tint px-3 py-1.5 text-[12.5px] text-sage-text transition-opacity hover:opacity-80 disabled:opacity-50"
            >
              {batchPending ? 'Applying…' : `Confirm all high-confidence (${batchCount})`}
            </button>
          )}
        </>
      ) : (
        <div className="border-l-2 border-sage-soft pl-[18px]">
          <div className="font-serif text-[19px] font-light text-sage">All caught up.</div>
          <div className="mt-1.5 text-[13px] text-muted-2">Nothing left to review.</div>
        </div>
      )}
    </div>
  );
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
            <select className="mz-field" value={form.category_id} onChange={(e) => setForm({ ...form, category_id: e.target.value })}>
              <option value="">Uncategorized</option>
              {categoryOptions(categories ?? [])}
            </select>
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
          <select className="mz-field" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">Uncategorized</option>
            {categoryOptions(categories ?? [])}
          </select>
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
  const [skippedKeys, setSkippedKeys] = useState<Set<string>>(new Set());

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const filters = useMemo(
    () => ({
      ...rangeDates(range),
      search: debouncedSearch || undefined,
      accountId: accountFilter ? [accountFilter] : undefined,
      categoryId: categoryFilter ? [categoryFilter] : undefined,
      uncategorized: reviewOnly || undefined,
      reviewStatus: reviewOnly ? ('open' as const) : undefined,
      limit: 200,
    }),
    [range, debouncedSearch, accountFilter, categoryFilter, reviewOnly]
  );

  const { data: page, isLoading } = useQuery({
    queryKey: ['transactions', filters],
    queryFn: () => transactionsApi.list(filters),
  });
  const { data: reviewSummary } = useQuery({ queryKey: ['transactions', 'review'], queryFn: () => transactionsApi.review() });
  const { data: uncategorizedPage } = useQuery({
    queryKey: ['transactions', 'review', 'uncategorized'],
    queryFn: () => transactionsApi.list({ uncategorized: true, reviewStatus: 'open', limit: 10 }),
  });
  const { data: accounts } = useQuery({ queryKey: ['accounts'], queryFn: () => accountsApi.list() });
  const { data: categories } = useQuery({ queryKey: ['categories'], queryFn: () => categoriesApi.list() });

  const transactions = page?.data ?? [];
  const totalCount = page?.total ?? 0;
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

  // ── Review mutations ──
  const invalidateReview = () => {
    qc.invalidateQueries({ queryKey: ['transactions'] });
    qc.invalidateQueries({ queryKey: ['recurring'] });
  };
  const skip = (key: string) => setSkippedKeys((prev) => new Set(prev).add(key));
  const onError = (err: Error) => addToast({ type: 'error', message: err.message });

  const confirmDraft = useMutation({ mutationFn: (d: AdvisorDraftAction) => aiApi.confirmDraft(d), onSuccess: invalidateReview, onError });
  const dismissDraft = useMutation({ mutationFn: (id: string) => aiApi.dismissDraft(id), onSuccess: invalidateReview, onError });
  const categorize = useMutation({
    mutationFn: ({ id, categoryId }: { id: string; categoryId: string }) => transactionsApi.update(id, { category_id: categoryId }),
    onSuccess: () => invalidateFinancialData(qc),
    onError,
  });
  const createRule = useMutation({
    mutationFn: (s: MerchantRuleSuggestion) => rulesApi.create({ pattern: s.pattern, category_id: s.category_id, apply_existing: true }),
    onSuccess: () => invalidateFinancialData(qc),
    onError,
  });
  const confirmRecurring = useMutation({ mutationFn: (p: RecurringPattern) => recurringApi.confirm(p.id), onSuccess: invalidateReview, onError });
  const dismissRecurring = useMutation({ mutationFn: (p: RecurringPattern) => recurringApi.dismiss(p.id), onSuccess: invalidateReview, onError });
  const dismissDuplicate = useMutation({
    mutationFn: (g: DuplicateCandidateGroup) => transactionsApi.dismissDuplicateGroup(g.group_id),
    onSuccess: invalidateReview,
    onError,
  });
  const confirmTransfer = useMutation({
    mutationFn: (p: TransferCandidatePair) => transactionsApi.confirmTransferPair(p.pair_id),
    onSuccess: invalidateReview,
    onError,
  });
  const dismissTransfer = useMutation({
    mutationFn: (p: TransferCandidatePair) => transactionsApi.dismissTransferPair(p.pair_id),
    onSuccess: invalidateReview,
    onError,
  });

  const queueItems = useMemo<QueueItem[]>(() => {
    const items: QueueItem[] = [];

    for (const draft of reviewSummary?.ai_drafts ?? []) {
      items.push({
        key: `draft:${draft.id}`,
        kind: 'Suggestion',
        title: draft.label,
        sub: draft.summary,
        primaryLabel: 'Confirm',
        onPrimary: () => confirmDraft.mutate(draft),
        secondaryLabel: 'Dismiss',
        onSecondary: () => dismissDraft.mutate(draft.id),
      });
    }
    for (const t of uncategorizedPage?.data ?? []) {
      items.push({
        key: `categorize:${t.id}`,
        kind: 'Categorize',
        title: `${merchantLabel(t)} · ${formatCurrency(t.amount)}`,
        sub: `${format(parseISO(t.date), 'MMM d')} · ${t.account_name ?? 'unknown account'}`,
        primaryLabel: 'Confirm',
        onPrimary: () => {},
        needsCategory: true,
        onPickCategory: (categoryId) => categorize.mutate({ id: t.id, categoryId }),
        secondaryLabel: 'Skip',
        onSecondary: () => skip(`categorize:${t.id}`),
      });
    }
    for (const s of reviewSummary?.rule_suggestions ?? []) {
      const key = `rule:${s.pattern}:${s.category_id}`;
      items.push({
        key,
        kind: 'New rule',
        title: `${s.pattern} → ${s.category_name}`,
        sub: `applies to ${s.affected_transaction_ids.length} transaction${s.affected_transaction_ids.length === 1 ? '' : 's'}`,
        primaryLabel: 'Confirm',
        onPrimary: () => createRule.mutate(s),
        secondaryLabel: 'Skip',
        onSecondary: () => skip(key),
      });
    }
    for (const p of reviewSummary?.recurring_candidates ?? []) {
      items.push({
        key: `recurring:${p.id}`,
        kind: 'Confirm recurring',
        title: `${p.merchant_name} · ${formatCurrency(p.average_amount)}`,
        sub: `${p.frequency} · seen ${p.transaction_count} times`,
        primaryLabel: 'Confirm',
        onPrimary: () => confirmRecurring.mutate(p),
        secondaryLabel: 'Not recurring',
        onSecondary: () => dismissRecurring.mutate(p),
      });
    }
    for (const g of reviewSummary?.duplicate_candidates ?? []) {
      items.push({
        key: `dupe:${g.group_id}`,
        kind: 'Possible duplicate',
        title: `${g.merchant_name} · ${formatCurrency(g.amount)}`,
        sub: `${format(parseISO(g.date), 'MMM d')} · ${g.count} identical charges on ${g.account_name}`,
        primaryLabel: 'Keep both',
        onPrimary: () => dismissDuplicate.mutate(g),
        secondaryLabel: 'Skip',
        onSecondary: () => skip(`dupe:${g.group_id}`),
      });
    }
    for (const p of reviewSummary?.transfer_candidates ?? []) {
      items.push({
        key: `transfer:${p.pair_id}`,
        kind: 'Transfer pair',
        title: `${formatCurrency(Math.abs(p.amount))} · ${p.from_account_name} → ${p.to_account_name}`,
        sub: `${format(parseISO(p.date), 'MMM d')} · looks like a transfer, not spending`,
        primaryLabel: 'Confirm',
        onPrimary: () => confirmTransfer.mutate(p),
        secondaryLabel: 'Not a transfer',
        onSecondary: () => dismissTransfer.mutate(p),
      });
    }

    return items.filter((i) => !skippedKeys.has(i.key));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewSummary, uncategorizedPage, skippedKeys]);

  // Batch: apply all high-confidence rule suggestions in one go.
  const highConfidenceRules = (reviewSummary?.rule_suggestions ?? []).filter((s) => s.confidence >= 0.9);
  const batchConfirm = useMutation({
    mutationFn: async () => {
      await Promise.allSettled(
        highConfidenceRules.map((s) => rulesApi.create({ pattern: s.pattern, category_id: s.category_id, apply_existing: true }))
      );
    },
    onSuccess: () => {
      invalidateFinancialData(qc);
      addToast({ type: 'success', message: `Applied ${highConfidenceRules.length} rule${highConfidenceRules.length === 1 ? '' : 's'}` });
    },
    onError,
  });

  return (
    <Screen>
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
        <select
          className="cursor-pointer border-none bg-transparent p-0 pr-7 text-[13.5px] text-muted transition-colors hover:text-ink focus:ring-0"
          value={accountFilter}
          onChange={(e) => setAccountFilter(e.target.value)}
        >
          <option value="">All accounts</option>
          {(accounts ?? [])
            .filter((a) => !a.is_hidden)
            .map((a) => (
              <option key={a.id} value={a.id}>
                {a.account_name}
              </option>
            ))}
        </select>
        <select
          className="cursor-pointer border-none bg-transparent p-0 pr-7 text-[13.5px] text-muted transition-colors hover:text-ink focus:ring-0"
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
        >
          <option value="">Category</option>
          {categoryOptions(categories ?? [])}
        </select>
        <select
          className="cursor-pointer border-none bg-transparent p-0 pr-7 text-[13.5px] text-muted transition-colors hover:text-ink focus:ring-0"
          value={range}
          onChange={(e) => setRange(e.target.value as RangeId)}
        >
          {RANGES.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </select>
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

      {/* Two-pane: ledger + review */}
      <div className="flex min-h-0 flex-1 gap-12">
        <div className="min-w-0 max-w-[640px] flex-1 overflow-y-auto">
          {/* Column header */}
          <div className="flex items-center px-3 pb-2 text-[11px] uppercase tracking-[0.1em] text-faint">
            <span className="flex-1">Merchant</span>
            <span className="w-[130px]">Account</span>
            <span className="w-[110px] text-right">Amount</span>
          </div>

          {isLoading && (
            <div className="space-y-2">
              {[0, 1, 2, 3, 4].map((i) => (
                <div key={i} className="h-14 animate-pulse rounded-lg bg-line/60" />
              ))}
            </div>
          )}

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
                  className="flex cursor-pointer items-center rounded-lg border-b border-line px-3 py-3.5 transition-colors hover:bg-rail"
                >
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
        </div>

        <ReviewPanel
          totalOpen={reviewCount}
          items={queueItems}
          categories={categories ?? []}
          batchCount={highConfidenceRules.length}
          onBatchConfirm={() => batchConfirm.mutate()}
          batchPending={batchConfirm.isPending}
        />
      </div>

      <AddTransactionModal open={showAddModal} onClose={() => setShowAddModal(false)} />
      <EditTransactionModal transaction={editing} onClose={() => setEditing(null)} />
    </Screen>
  );
}
