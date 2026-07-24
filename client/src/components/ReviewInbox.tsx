import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format, parseISO } from 'date-fns';
import type {
  AdvisorDraftAction,
  Category,
  DuplicateCandidateGroup,
  MerchantRuleSuggestion,
  RecurringPattern,
  Transaction,
  TransferCandidatePair,
} from '@shared/types';
import { aiApi, categoriesApi, recurringApi, rulesApi, transactionsApi } from '../lib/api';
import { formatCurrency } from '../lib/formatters';
import { invalidateFinancialData } from '../lib/queryInvalidation';
import { useAppStore } from '../store';
import { Screen, ScreenHeader, CategoryPicker } from './balance';

function merchantLabel(t: Transaction): string {
  return (t.merchant_name || t.original_name).trim();
}

interface QueueItem {
  key: string;
  kind: string;
  title: string;
  sub: string;
  primaryLabel: string;
  onPrimary: () => void;
  needsCategory?: boolean;
  defaultCategory?: string;
  onPickCategory?: (categoryId: string) => void;
  secondaryLabel?: string;
  onSecondary?: () => void;
}

function ReviewPanel({
  totalOpen,
  items,
  categories,
  leavingKey,
  batchCount,
  onBatchConfirm,
  batchPending,
}: {
  totalOpen: number;
  items: QueueItem[];
  categories: Category[];
  leavingKey: string | null;
  batchCount: number;
  onBatchConfirm: () => void;
  batchPending: boolean;
}) {
  const [pickedCategory, setPickedCategory] = useState('');
  const focus = items[0];
  const rest = items.slice(1, 6);
  const leaving = focus != null && leavingKey === focus.key;

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setPickedCategory(focus?.defaultCategory ?? ''), [focus?.key]);

  return (
    <div className="w-full max-w-[560px]">
      <div className="mb-4 flex items-baseline justify-between">
        <span className="font-serif text-xl text-ink">Inbox</span>
        <span className="text-xs text-muted">
          {totalOpen} item{totalOpen === 1 ? '' : 's'}
        </span>
      </div>

      {focus ? (
        <>
          <div
            key={focus.key}
            className={`mz-rise-fast border-l-2 border-sage-soft pl-[18px] transition-all duration-150 ${
              leaving ? '-translate-y-1 opacity-0' : ''
            }`}
          >
            <div className="mb-1.5 text-[11px] uppercase tracking-[0.15em] text-muted-2">{focus.kind}</div>
            <div className="mb-0.5 text-[15.5px] text-ink">{focus.title}</div>
            <div className="text-[13px] leading-normal text-muted">{focus.sub}</div>
            {focus.needsCategory && (
              <CategoryPicker
                className="mt-3"
                value={pickedCategory}
                onChange={setPickedCategory}
                placeholder="Pick a category…"
                categories={categories}
              />
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
              className="mt-6 rounded-md border border-sage-tint-border bg-sage-tint px-3 py-1.5 text-xs text-sage-text transition-opacity hover:opacity-80 disabled:opacity-50"
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

export function ReviewInbox() {
  const qc = useQueryClient();
  const { addToast } = useAppStore();

  const [hiddenKeys, setHiddenKeys] = useState<Set<string>>(new Set());
  const [leavingKey, setLeavingKey] = useState<string | null>(null);

  const { data: reviewSummary } = useQuery({ queryKey: ['transactions', 'review'], queryFn: () => transactionsApi.review() });
  const { data: uncategorizedPage } = useQuery({
    queryKey: ['transactions', 'review', 'uncategorized'],
    queryFn: () => transactionsApi.list({ uncategorized: true, reviewStatus: 'open', limit: 10 }),
  });
  const { data: categories } = useQuery({ queryKey: ['categories'], queryFn: () => categoriesApi.list() });

  const reviewCount = reviewSummary?.total_open ?? 0;

  const invalidateReview = () => {
    qc.invalidateQueries({ queryKey: ['transactions'] });
    qc.invalidateQueries({ queryKey: ['recurring'] });
  };
  const onError = (err: Error) => addToast({ type: 'error', message: err.message });

  const unhide = (key: string) =>
    setHiddenKeys((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  const resolve = (key: string, run?: (onErrorRestore: () => void) => void) => {
    setLeavingKey(key);
    window.setTimeout(() => {
      setHiddenKeys((prev) => new Set(prev).add(key));
      setLeavingKey((k) => (k === key ? null : k));
    }, 160);
    run?.(() => unhide(key));
  };

  const confirmDraft = useMutation({ mutationFn: (d: AdvisorDraftAction) => aiApi.confirmDraft(d), onSuccess: invalidateReview, onError });
  const dismissDraft = useMutation({ mutationFn: (id: string) => aiApi.dismissDraft(id), onSuccess: invalidateReview, onError });
  const categorize = useMutation({
    mutationFn: ({ id, categoryId }: { id: string; categoryId: string }) => transactionsApi.update(id, { category_id: categoryId }),
    onSuccess: () => invalidateFinancialData(qc),
    onError,
  });
  const createRule = useMutation({
    mutationFn: ({ suggestion, categoryId }: { suggestion: MerchantRuleSuggestion; categoryId: string }) =>
      rulesApi.create({ pattern: suggestion.pattern, category_id: categoryId, apply_existing: true }),
    onSuccess: () => invalidateFinancialData(qc),
    onError,
  });
  const dismissTransaction = useMutation({
    mutationFn: (id: string) => transactionsApi.markReview(id, 'dismissed'),
    onSuccess: invalidateReview,
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

  const allQueueItems = useMemo<QueueItem[]>(() => {
    const items: QueueItem[] = [];

    for (const draft of reviewSummary?.ai_drafts ?? []) {
      const key = `draft:${draft.id}`;
      items.push({
        key,
        kind: 'Suggestion',
        title: draft.label,
        sub: draft.summary,
        primaryLabel: 'Confirm',
        onPrimary: () => resolve(key, (restore) => confirmDraft.mutate(draft, { onError: restore })),
        secondaryLabel: 'Dismiss',
        onSecondary: () => resolve(key, (restore) => dismissDraft.mutate(draft.id, { onError: restore })),
      });
    }
    for (const t of uncategorizedPage?.data ?? []) {
      const key = `categorize:${t.id}`;
      items.push({
        key,
        kind: 'Categorize',
        title: `${merchantLabel(t)} · ${formatCurrency(t.amount)}`,
        sub: `${format(parseISO(t.date), 'MMM d')} · ${t.account_name ?? 'unknown account'}`,
        primaryLabel: 'Confirm',
        onPrimary: () => {},
        needsCategory: true,
        onPickCategory: (categoryId) => resolve(key, (restore) => categorize.mutate({ id: t.id, categoryId }, { onError: restore })),
        secondaryLabel: 'Skip',
        onSecondary: () => resolve(key, (restore) => dismissTransaction.mutate(t.id, { onError: restore })),
      });
    }
    for (const s of reviewSummary?.rule_suggestions ?? []) {
      const key = `rule:${s.pattern}:${s.category_id}`;
      items.push({
        key,
        kind: 'New rule',
        title: `${s.pattern} → always categorize as…`,
        sub: `applies to ${s.affected_transaction_ids.length} transaction${s.affected_transaction_ids.length === 1 ? '' : 's'} · suggested: ${s.category_name}`,
        primaryLabel: 'Confirm',
        onPrimary: () => {},
        needsCategory: true,
        defaultCategory: s.category_id,
        onPickCategory: (categoryId) => resolve(key, (restore) => createRule.mutate({ suggestion: s, categoryId }, { onError: restore })),
        secondaryLabel: 'Skip',
        onSecondary: () => resolve(key),
      });
    }
    for (const p of reviewSummary?.recurring_candidates ?? []) {
      const key = `recurring:${p.id}`;
      items.push({
        key,
        kind: 'Confirm recurring',
        title: `${p.merchant_name} · ${formatCurrency(p.average_amount)}`,
        sub: `${p.frequency} · seen ${p.transaction_count} times`,
        primaryLabel: 'Confirm',
        onPrimary: () => resolve(key, (restore) => confirmRecurring.mutate(p, { onError: restore })),
        secondaryLabel: 'Not recurring',
        onSecondary: () => resolve(key, (restore) => dismissRecurring.mutate(p, { onError: restore })),
      });
    }
    for (const g of reviewSummary?.duplicate_candidates ?? []) {
      const key = `dupe:${g.group_id}`;
      items.push({
        key,
        kind: 'Possible duplicate',
        title: `${g.merchant_name} · ${formatCurrency(g.amount)}`,
        sub: `${format(parseISO(g.date), 'MMM d')} · ${g.count} identical charges on ${g.account_name}`,
        primaryLabel: 'Keep both',
        onPrimary: () => resolve(key, (restore) => dismissDuplicate.mutate(g, { onError: restore })),
        secondaryLabel: 'Skip',
        onSecondary: () => resolve(key),
      });
    }
    for (const p of reviewSummary?.transfer_candidates ?? []) {
      const key = `transfer:${p.pair_id}`;
      items.push({
        key,
        kind: 'Transfer pair',
        title: `${formatCurrency(Math.abs(p.amount))} · ${p.from_account_name} → ${p.to_account_name}`,
        sub: `${format(parseISO(p.date), 'MMM d')} · looks like a transfer, not spending`,
        primaryLabel: 'Confirm',
        onPrimary: () => resolve(key, (restore) => confirmTransfer.mutate(p, { onError: restore })),
        secondaryLabel: 'Not a transfer',
        onSecondary: () => resolve(key, (restore) => dismissTransfer.mutate(p, { onError: restore })),
      });
    }

    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewSummary, uncategorizedPage]);

  const queueItems = useMemo(() => allQueueItems.filter((i) => !hiddenKeys.has(i.key)), [allQueueItems, hiddenKeys]);
  const displayedReviewCount = Math.max(0, reviewCount - (allQueueItems.length - queueItems.length));

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
        title="Review"
        sub="Categorizations, rules, recurring bills, duplicates, and transfers to confirm"
        className="mb-6"
      />
      <ReviewPanel
        totalOpen={displayedReviewCount}
        items={queueItems}
        categories={categories ?? []}
        leavingKey={leavingKey}
        batchCount={highConfidenceRules.length}
        onBatchConfirm={() => batchConfirm.mutate()}
        batchPending={batchConfirm.isPending}
      />
    </Screen>
  );
}
