import React, { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeftRight,
  Check,
  CheckCircle2,
  Clock,
  RefreshCw,
  Sparkles,
  Tag,
  Trash2,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import {
  categoriesApi,
  flattenCategories,
  recurringApi,
  rulesApi,
  transactionsApi,
} from '../lib/api';
import { formatCurrency, formatDate } from '../lib/formatters';
import { AmountBadge } from '../components/AmountBadge';
import { CategoryBadge } from '../components/CategoryBadge';
import { SkeletonList } from '../components/SkeletonLoader';
import { invalidateFinancialData } from '../lib/queryInvalidation';
import { useAppStore } from '../store';
import { CategoryDropdown } from './transactions/TransactionControls';
import { getUncategorizedBatchGroups } from '../lib/reviewGrouping';
import type { ReviewBatchGroup } from '../lib/reviewGrouping';
import type {
  DuplicateCandidateGroup,
  MerchantRuleSuggestion,
  RecurringPattern,
  Transaction,
  TransactionReviewQueueId,
  TransferCandidatePair,
} from '@shared/types';

const queueTone = {
  uncategorized: { color: '#e2a53f', icon: Tag },
  rule_suggestions: { color: '#6487f0', icon: Sparkles },
  pending: { color: '#e2a53f', icon: Clock },
  recurring_candidates: { color: '#32bfa3', icon: RefreshCw },
  duplicate_candidates: { color: '#ef6f8a', icon: Trash2 },
  transfer_candidates: { color: '#6487f0', icon: ArrowLeftRight },
} satisfies Record<TransactionReviewQueueId, { color: string; icon: LucideIcon }>;

const queueOrder: TransactionReviewQueueId[] = [
  'uncategorized',
  'rule_suggestions',
  'pending',
  'recurring_candidates',
  'duplicate_candidates',
  'transfer_candidates',
];

function isQueueId(value: string | null): value is TransactionReviewQueueId {
  return value === 'uncategorized' ||
    value === 'rule_suggestions' ||
    value === 'pending' ||
    value === 'recurring_candidates' ||
    value === 'duplicate_candidates' ||
    value === 'transfer_candidates';
}

function QueueButton({
  id,
  label,
  count,
  active,
  onClick,
}: {
  id: TransactionReviewQueueId;
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  const tone = queueTone[id];
  const Icon = tone.icon;

  return (
    <button
      className={`flex items-center gap-3 border rounded px-3 py-2 text-left transition-colors ${
        active ? 'bg-green/5 border-green/40' : 'bg-surface border-border hover:border-green/40'
      }`}
      onClick={onClick}
    >
      <div
        className="w-8 h-8 rounded flex items-center justify-center flex-shrink-0"
        style={{ backgroundColor: `${tone.color}18` }}
      >
        <Icon size={15} style={{ color: tone.color }} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-xs text-muted truncate">{label}</p>
        <p className="font-mono text-sm text-text">{count}</p>
      </div>
    </button>
  );
}

function TransactionRow({
  transaction,
  selected,
  categories,
  onCategory,
  onReviewed,
  reviewing,
}: {
  transaction: Transaction;
  selected: boolean;
  categories: ReturnType<typeof flattenCategories>;
  onCategory: (transactionId: string, categoryId: string) => void;
  onReviewed?: (transactionId: string) => void;
  reviewing?: boolean;
}) {
  return (
    <div className={`grid grid-cols-[96px_1fr_180px_120px_auto] gap-3 items-center px-3 py-2.5 border-b border-border last:border-0 ${
      selected ? 'bg-green/5' : ''
    }`}>
      <span className="text-xs text-muted font-mono">{formatDate(transaction.date)}</span>
      <div className="min-w-0">
        <p className="text-sm text-text truncate">{transaction.merchant_name || transaction.original_name}</p>
        <p className="text-xs text-muted truncate">{transaction.account_name}</p>
      </div>
      <CategoryDropdown
        value={transaction.category_id}
        categories={categories}
        onChange={(categoryId) => onCategory(transaction.id, categoryId)}
      />
      <AmountBadge amount={transaction.amount} />
      {onReviewed ? (
        <button
          className="flex items-center gap-1.5 text-xs text-muted border border-border rounded px-2 py-1 hover:text-green disabled:opacity-40"
          onClick={() => onReviewed(transaction.id)}
          disabled={reviewing}
        >
          <Check size={12} />
          Done
        </button>
      ) : (
        <span className="w-16" />
      )}
    </div>
  );
}

function RuleSuggestionRow({
  suggestion,
  selected,
  onApply,
  applying,
}: {
  suggestion: MerchantRuleSuggestion;
  selected: boolean;
  onApply: (suggestion: MerchantRuleSuggestion) => void;
  applying: boolean;
}) {
  return (
    <div className={`flex items-center gap-3 px-3 py-3 border-b border-border last:border-0 ${
      selected ? 'bg-green/5' : ''
    }`}>
      <Sparkles size={14} className="text-blue flex-shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 mb-1">
          <p className="text-sm text-text truncate">{suggestion.pattern}</p>
          <CategoryBadge
            name={suggestion.category_name}
            color={suggestion.category_color}
            icon={suggestion.category_icon}
          />
        </div>
        <p className="text-xs text-muted">
          {suggestion.uncategorized_count} uncategorized, {suggestion.categorized_count} already categorized, {Math.round(suggestion.confidence * 100)}% confidence
        </p>
      </div>
      <button
        className="flex items-center gap-1.5 text-xs bg-blue text-white rounded px-2.5 py-1.5 hover:opacity-90 disabled:opacity-40"
        onClick={() => onApply(suggestion)}
        disabled={applying}
      >
        <Check size={12} />
        Apply
      </button>
    </div>
  );
}

function RecurringRow({
  pattern,
  selected,
  onConfirm,
  onDismiss,
  busy,
}: {
  pattern: RecurringPattern;
  selected: boolean;
  onConfirm: (id: string) => void;
  onDismiss: (id: string) => void;
  busy: boolean;
}) {
  return (
    <div className={`flex items-center gap-3 px-3 py-3 border-b border-border last:border-0 ${
      selected ? 'bg-green/5' : ''
    }`}>
      <RefreshCw size={14} className="text-green flex-shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-sm text-text truncate">{pattern.merchant_name}</p>
        <p className="text-xs text-muted">
          {pattern.frequency}, next {formatDate(pattern.next_expected)}, {formatCurrency(pattern.average_amount)}
        </p>
      </div>
      <button
        className="flex items-center gap-1.5 text-xs bg-text text-surface rounded px-2.5 py-1.5 hover:opacity-90 disabled:opacity-40"
        onClick={() => onConfirm(pattern.id)}
        disabled={busy}
      >
        <Check size={12} />
        Confirm
      </button>
      <button
        className="text-xs text-muted border border-border rounded px-2.5 py-1.5 hover:text-text disabled:opacity-40"
        onClick={() => onDismiss(pattern.id)}
        disabled={busy}
      >
        Dismiss
      </button>
    </div>
  );
}

function DuplicateRow({
  group,
  selected,
  onDismiss,
  busy,
}: {
  group: DuplicateCandidateGroup;
  selected: boolean;
  onDismiss: (groupId: string) => void;
  busy: boolean;
}) {
  return (
    <div className={`flex items-center gap-3 px-3 py-3 border-b border-border last:border-0 ${
      selected ? 'bg-green/5' : ''
    }`}>
      <AlertTriangle size={14} className="text-rose flex-shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-sm text-text truncate">{group.merchant_name}</p>
        <p className="text-xs text-muted">
          {group.count} matches in {group.account_name} on {formatDate(group.date)}, {formatCurrency(group.amount)}
        </p>
      </div>
      <button
        className="text-xs text-muted border border-border rounded px-2.5 py-1.5 hover:text-text disabled:opacity-40"
        onClick={() => onDismiss(group.group_id)}
        disabled={busy}
      >
        Dismiss
      </button>
    </div>
  );
}

function TransferRow({
  pair,
  selected,
  onConfirm,
  onDismiss,
  busy,
}: {
  pair: TransferCandidatePair;
  selected: boolean;
  onConfirm: (pairId: string) => void;
  onDismiss: (pairId: string) => void;
  busy: boolean;
}) {
  return (
    <div className={`flex items-center gap-3 px-3 py-3 border-b border-border last:border-0 ${
      selected ? 'bg-green/5' : ''
    }`}>
      <ArrowLeftRight size={14} className="text-blue flex-shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-sm text-text truncate">
          {pair.from_account_name} to {pair.to_account_name}
        </p>
        <p className="text-xs text-muted">
          {formatDate(pair.date)}, {formatCurrency(pair.amount)}
        </p>
      </div>
      <button
        className="flex items-center gap-1.5 text-xs bg-blue text-white rounded px-2.5 py-1.5 hover:opacity-90 disabled:opacity-40"
        onClick={() => onConfirm(pair.pair_id)}
        disabled={busy}
      >
        <Check size={12} />
        Confirm
      </button>
      <button
        className="text-xs text-muted border border-border rounded px-2.5 py-1.5 hover:text-text disabled:opacity-40"
        onClick={() => onDismiss(pair.pair_id)}
        disabled={busy}
      >
        Dismiss
      </button>
    </div>
  );
}

function EmptyQueue() {
  return (
    <div className="h-64 flex flex-col items-center justify-center text-center">
      <CheckCircle2 size={28} className="text-green mb-3" />
      <p className="text-sm text-text">Queue clear</p>
      <p className="text-xs text-muted mt-1">No open items in this queue.</p>
    </div>
  );
}

function BatchGroupRow({
  group,
  categories,
  categoryId,
  busy,
  onCategory,
  onApply,
}: {
  group: ReviewBatchGroup;
  categories: ReturnType<typeof flattenCategories>;
  categoryId: string | null;
  busy: boolean;
  onCategory: (categoryId: string) => void;
  onApply: () => void;
}) {
  return (
    <div className="grid grid-cols-[1fr_180px_auto] gap-3 items-center px-3 py-2 border-b border-border last:border-0">
      <div className="min-w-0">
        <p className="text-sm text-text truncate">{group.merchant_name}</p>
        <p className="text-xs text-muted truncate">
          {group.count} transactions in {group.account_name ?? 'Unknown account'}, {formatCurrency(group.total_amount)}
        </p>
      </div>
      <CategoryDropdown
        value={categoryId}
        categories={categories}
        onChange={onCategory}
      />
      <button
        className="flex items-center gap-1.5 text-xs bg-text text-surface rounded px-2.5 py-1.5 hover:opacity-90 disabled:opacity-40"
        onClick={onApply}
        disabled={busy || !categoryId}
      >
        <Check size={12} />
        Apply
      </button>
    </div>
  );
}

export function ReviewInbox() {
  const qc = useQueryClient();
  const { addToast } = useAppStore();
  const [params, setParams] = useSearchParams();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [batchCategories, setBatchCategories] = useState<Record<string, string>>({});

  const { data: summary } = useQuery({
    queryKey: ['transactions', 'review'],
    queryFn: transactionsApi.review,
  });

  const queueFromUrl = params.get('queue');
  const firstOpenQueue = summary?.queues.find((queue) => queue.count > 0)?.id ?? 'uncategorized';
  const activeQueue: TransactionReviewQueueId = isQueueId(queueFromUrl) ? queueFromUrl : firstOpenQueue;

  const { data: categoriesTree = [] } = useQuery({
    queryKey: ['categories'],
    queryFn: categoriesApi.list,
  });
  const categories = useMemo(() => flattenCategories(categoriesTree), [categoriesTree]);

  const { data: uncategorized, isLoading: uncategorizedLoading } = useQuery({
    queryKey: ['transactions', 'review', 'uncategorized'],
    queryFn: () => transactionsApi.list({
      page: 1,
      limit: 25,
      pending: false,
      uncategorized: true,
      reviewStatus: 'open',
      sortBy: 'date',
      sortDir: 'desc',
    }),
  });

  const { data: pending, isLoading: pendingLoading } = useQuery({
    queryKey: ['transactions', 'review', 'pending'],
    queryFn: () => transactionsApi.list({
      page: 1,
      limit: 25,
      pending: true,
      reviewStatus: 'open',
      sortBy: 'date',
      sortDir: 'desc',
    }),
  });

  const invalidateReview = () => invalidateFinancialData(qc);

  const updateCategoryMutation = useMutation({
    mutationFn: ({ transactionId, categoryId }: { transactionId: string; categoryId: string }) =>
      transactionsApi.update(transactionId, { category_id: categoryId }),
    onSuccess: () => {
      invalidateReview();
      addToast({ type: 'success', message: 'Transaction categorized' });
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const markReviewMutation = useMutation({
    mutationFn: (transactionId: string) => transactionsApi.markReview(transactionId, 'reviewed'),
    onSuccess: () => invalidateReview(),
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const applyRuleMutation = useMutation({
    mutationFn: (suggestion: MerchantRuleSuggestion) => rulesApi.create({
      pattern: suggestion.pattern,
      category_id: suggestion.category_id,
      apply_existing: true,
    }),
    onSuccess: (result) => {
      invalidateReview();
      addToast({
        type: 'success',
        message: result.applied > 0
          ? `Rule saved and applied to ${result.applied} transactions`
          : 'Rule saved',
      });
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const confirmRecurringMutation = useMutation({
    mutationFn: recurringApi.confirm,
    onSuccess: () => invalidateReview(),
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const dismissRecurringMutation = useMutation({
    mutationFn: recurringApi.dismiss,
    onSuccess: () => invalidateReview(),
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const dismissDuplicateMutation = useMutation({
    mutationFn: transactionsApi.dismissDuplicateGroup,
    onSuccess: () => invalidateReview(),
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const confirmTransferMutation = useMutation({
    mutationFn: transactionsApi.confirmTransferPair,
    onSuccess: () => invalidateReview(),
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const dismissTransferMutation = useMutation({
    mutationFn: transactionsApi.dismissTransferPair,
    onSuccess: () => invalidateReview(),
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const bulkCategoryMutation = useMutation({
    mutationFn: ({ ids, categoryId }: { ids: string[]; categoryId: string }) =>
      transactionsApi.bulkCategory(ids, categoryId),
    onSuccess: (_result, variables) => {
      invalidateReview();
      setBatchCategories((existing) => {
        const next = { ...existing };
        for (const group of uncategorizedGroups) {
          if (group.transaction_ids.every((id) => variables.ids.includes(id))) {
            delete next[group.key];
          }
        }
        return next;
      });
      addToast({
        type: 'success',
        message: `Categorized ${variables.ids.length} transaction${variables.ids.length === 1 ? '' : 's'} and saved rule`,
      });
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const activeItems = activeQueue === 'uncategorized'
    ? uncategorized?.data ?? []
    : activeQueue === 'pending'
      ? pending?.data ?? []
      : [];
  const ruleSuggestions = summary?.rule_suggestions ?? [];
  const recurringCandidates = summary?.recurring_candidates ?? [];
  const duplicateCandidates = summary?.duplicate_candidates ?? [];
  const transferCandidates = summary?.transfer_candidates ?? [];
  const activeItemCount = activeQueue === 'uncategorized' || activeQueue === 'pending'
    ? activeItems.length
    : activeQueue === 'rule_suggestions'
      ? ruleSuggestions.length
      : activeQueue === 'recurring_candidates'
        ? recurringCandidates.length
        : activeQueue === 'duplicate_candidates'
          ? duplicateCandidates.length
          : transferCandidates.length;
  const uncategorizedGroups = useMemo(
    () => getUncategorizedBatchGroups(uncategorized?.data ?? []),
    [uncategorized?.data]
  );

  useEffect(() => {
    setSelectedIndex(0);
  }, [activeQueue]);

  useEffect(() => {
    setSelectedIndex((index) => Math.min(index, Math.max(activeItemCount - 1, 0)));
  }, [activeItemCount]);

  const setActiveQueue = (queueId: TransactionReviewQueueId) => {
    setParams({ queue: queueId });
  };

  const runPrimaryAction = () => {
    if (activeQueue === 'pending') {
      const transaction = activeItems[selectedIndex];
      if (transaction && !markReviewMutation.isPending) markReviewMutation.mutate(transaction.id);
      return;
    }

    if (activeQueue === 'rule_suggestions') {
      const suggestion = ruleSuggestions[selectedIndex];
      if (suggestion && !applyRuleMutation.isPending) applyRuleMutation.mutate(suggestion);
      return;
    }

    if (activeQueue === 'recurring_candidates') {
      const pattern = recurringCandidates[selectedIndex];
      if (pattern && !confirmRecurringMutation.isPending) confirmRecurringMutation.mutate(pattern.id);
      return;
    }

    if (activeQueue === 'transfer_candidates') {
      const pair = transferCandidates[selectedIndex];
      if (pair && !confirmTransferMutation.isPending) confirmTransferMutation.mutate(pair.pair_id);
    }
  };

  const runDismissAction = () => {
    if (activeQueue === 'recurring_candidates') {
      const pattern = recurringCandidates[selectedIndex];
      if (pattern && !dismissRecurringMutation.isPending) dismissRecurringMutation.mutate(pattern.id);
      return;
    }

    if (activeQueue === 'duplicate_candidates') {
      const group = duplicateCandidates[selectedIndex];
      if (group && !dismissDuplicateMutation.isPending) dismissDuplicateMutation.mutate(group.group_id);
      return;
    }

    if (activeQueue === 'transfer_candidates') {
      const pair = transferCandidates[selectedIndex];
      if (pair && !dismissTransferMutation.isPending) dismissTransferMutation.mutate(pair.pair_id);
    }
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) return;

      const key = event.key.toLowerCase();

      if (/^[1-6]$/.test(event.key)) {
        const queueId = queueOrder[Number(event.key) - 1];
        if (!queueId) return;
        event.preventDefault();
        setActiveQueue(queueId);
        return;
      }

      if (activeItemCount === 0) return;

      if (event.key === 'ArrowDown' || key === 'j') {
        event.preventDefault();
        setSelectedIndex((index) => Math.min(index + 1, activeItemCount - 1));
        return;
      }
      if (event.key === 'ArrowUp' || key === 'k') {
        event.preventDefault();
        setSelectedIndex((index) => Math.max(index - 1, 0));
        return;
      }
      if (event.key === 'Enter' || key === 'a') {
        event.preventDefault();
        runPrimaryAction();
        return;
      }
      if (key === 'd') {
        event.preventDefault();
        runDismissAction();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeItemCount, runDismissAction, runPrimaryAction, setActiveQueue]);

  const queues = summary?.queues ?? [];
  const totalOpen = summary?.total_open ?? 0;
  const loading = activeQueue === 'uncategorized' ? uncategorizedLoading : activeQueue === 'pending' ? pendingLoading : false;

  return (
    <div className="p-6 h-full flex flex-col gap-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text">Review Inbox</h1>
          <p className="text-sm text-muted font-mono">{totalOpen} open</p>
        </div>
        {totalOpen === 0 && (
          <div className="flex items-center gap-2 text-sm text-green">
            <CheckCircle2 size={16} />
            Review complete
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-6 gap-2">
        {queues.map((queue) => (
          <QueueButton
            key={queue.id}
            id={queue.id}
            label={queue.label}
            count={queue.count}
            active={activeQueue === queue.id}
            onClick={() => setActiveQueue(queue.id)}
          />
        ))}
      </div>

      <div className="bg-surface shadow-sm border border-border rounded flex-1 overflow-hidden">
        {loading ? (
          <SkeletonList rows={10} cols={5} />
        ) : activeQueue === 'uncategorized' ? (
          activeItems.length > 0 ? (
            <>
              {uncategorizedGroups.length > 0 && (
                <div className="border-b border-border bg-background/40">
                  <div className="px-3 py-2 border-b border-border">
                    <p className="text-xs text-muted">Repeated merchants</p>
                  </div>
                  {uncategorizedGroups.slice(0, 4).map((group) => {
                    const categoryId = batchCategories[group.key] ?? null;
                    const busy = bulkCategoryMutation.isPending &&
                      bulkCategoryMutation.variables?.ids.join('|') === group.transaction_ids.join('|');
                    return (
                      <BatchGroupRow
                        key={group.key}
                        group={group}
                        categories={categories}
                        categoryId={categoryId}
                        busy={busy}
                        onCategory={(nextCategoryId) =>
                          setBatchCategories((existing) => ({ ...existing, [group.key]: nextCategoryId }))
                        }
                        onApply={() => {
                          if (!categoryId) return;
                          bulkCategoryMutation.mutate({
                            ids: group.transaction_ids,
                            categoryId,
                          });
                        }}
                      />
                    );
                  })}
                </div>
              )}
              {activeItems.map((transaction, index) => (
                <TransactionRow
                  key={transaction.id}
                  transaction={transaction}
                  selected={index === selectedIndex}
                  categories={categories}
                  onCategory={(transactionId, categoryId) => updateCategoryMutation.mutate({ transactionId, categoryId })}
                />
              ))}
            </>
          ) : <EmptyQueue />
        ) : activeQueue === 'pending' ? (
          activeItems.length > 0 ? (
            activeItems.map((transaction, index) => (
              <TransactionRow
                key={transaction.id}
                transaction={transaction}
                selected={index === selectedIndex}
                categories={categories}
                onCategory={(transactionId, categoryId) => updateCategoryMutation.mutate({ transactionId, categoryId })}
                onReviewed={(transactionId) => markReviewMutation.mutate(transactionId)}
                reviewing={markReviewMutation.isPending}
              />
            ))
          ) : <EmptyQueue />
        ) : activeQueue === 'rule_suggestions' ? (
          ruleSuggestions.length > 0 ? (
            ruleSuggestions.map((suggestion, index) => (
              <RuleSuggestionRow
                key={`${suggestion.pattern}:${suggestion.category_id}`}
                suggestion={suggestion}
                selected={index === selectedIndex}
                onApply={(item) => applyRuleMutation.mutate(item)}
                applying={applyRuleMutation.isPending && applyRuleMutation.variables?.pattern === suggestion.pattern}
              />
            ))
          ) : <EmptyQueue />
        ) : activeQueue === 'recurring_candidates' ? (
          recurringCandidates.length > 0 ? (
            recurringCandidates.map((pattern, index) => (
              <RecurringRow
                key={pattern.id}
                pattern={pattern}
                selected={index === selectedIndex}
                onConfirm={(id) => confirmRecurringMutation.mutate(id)}
                onDismiss={(id) => dismissRecurringMutation.mutate(id)}
                busy={
                  (confirmRecurringMutation.isPending && confirmRecurringMutation.variables === pattern.id) ||
                  (dismissRecurringMutation.isPending && dismissRecurringMutation.variables === pattern.id)
                }
              />
            ))
          ) : <EmptyQueue />
        ) : activeQueue === 'duplicate_candidates' ? (
          duplicateCandidates.length > 0 ? (
            duplicateCandidates.map((group, index) => (
              <DuplicateRow
                key={group.group_id}
                group={group}
                selected={index === selectedIndex}
                onDismiss={(groupId) => dismissDuplicateMutation.mutate(groupId)}
                busy={dismissDuplicateMutation.isPending && dismissDuplicateMutation.variables === group.group_id}
              />
            ))
          ) : <EmptyQueue />
        ) : (
          transferCandidates.length > 0 ? (
            transferCandidates.map((pair, index) => (
              <TransferRow
                key={pair.pair_id}
                pair={pair}
                selected={index === selectedIndex}
                onConfirm={(pairId) => confirmTransferMutation.mutate(pairId)}
                onDismiss={(pairId) => dismissTransferMutation.mutate(pairId)}
                busy={
                  (confirmTransferMutation.isPending && confirmTransferMutation.variables === pair.pair_id) ||
                  (dismissTransferMutation.isPending && dismissTransferMutation.variables === pair.pair_id)
                }
              />
            ))
          ) : <EmptyQueue />
        )}
      </div>
    </div>
  );
}
