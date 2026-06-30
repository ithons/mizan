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
import type {
  DuplicateCandidateGroup,
  MerchantRuleSuggestion,
  RecurringPattern,
  Transaction,
  TransactionReviewQueueId,
  TransferCandidatePair,
} from '@shared/types';

const queueTone = {
  uncategorized: { color: '#d4a44c', icon: Tag },
  rule_suggestions: { color: '#5b8dee', icon: Sparkles },
  pending: { color: '#f0c040', icon: Clock },
  recurring_candidates: { color: '#4ecba3', icon: RefreshCw },
  duplicate_candidates: { color: '#e07070', icon: Trash2 },
  transfer_candidates: { color: '#5b8dee', icon: ArrowLeftRight },
} satisfies Record<TransactionReviewQueueId, { color: string; icon: LucideIcon }>;

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
        active ? 'bg-white/5 border-[#4ecba3]/40' : 'bg-surface border-border hover:border-white/20'
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
      selected ? 'bg-[#4ecba3]/5' : ''
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
          className="flex items-center gap-1.5 text-xs text-muted border border-border rounded px-2 py-1 hover:text-[#4ecba3] disabled:opacity-40"
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
  onApply,
  applying,
}: {
  suggestion: MerchantRuleSuggestion;
  onApply: (suggestion: MerchantRuleSuggestion) => void;
  applying: boolean;
}) {
  return (
    <div className="flex items-center gap-3 px-3 py-3 border-b border-border last:border-0">
      <Sparkles size={14} className="text-[#5b8dee] flex-shrink-0" />
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
        className="flex items-center gap-1.5 text-xs bg-[#5b8dee] text-white rounded px-2.5 py-1.5 hover:opacity-90 disabled:opacity-40"
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
  onConfirm,
  onDismiss,
  busy,
}: {
  pattern: RecurringPattern;
  onConfirm: (id: string) => void;
  onDismiss: (id: string) => void;
  busy: boolean;
}) {
  return (
    <div className="flex items-center gap-3 px-3 py-3 border-b border-border last:border-0">
      <RefreshCw size={14} className="text-[#4ecba3] flex-shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-sm text-text truncate">{pattern.merchant_name}</p>
        <p className="text-xs text-muted">
          {pattern.frequency}, next {formatDate(pattern.next_expected)}, {formatCurrency(pattern.average_amount)}
        </p>
      </div>
      <button
        className="flex items-center gap-1.5 text-xs bg-[#4ecba3] text-[#0f0f11] rounded px-2.5 py-1.5 hover:opacity-90 disabled:opacity-40"
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
  onDismiss,
  busy,
}: {
  group: DuplicateCandidateGroup;
  onDismiss: (groupId: string) => void;
  busy: boolean;
}) {
  return (
    <div className="flex items-center gap-3 px-3 py-3 border-b border-border last:border-0">
      <AlertTriangle size={14} className="text-[#e07070] flex-shrink-0" />
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
  onConfirm,
  onDismiss,
  busy,
}: {
  pair: TransferCandidatePair;
  onConfirm: (pairId: string) => void;
  onDismiss: (pairId: string) => void;
  busy: boolean;
}) {
  return (
    <div className="flex items-center gap-3 px-3 py-3 border-b border-border last:border-0">
      <ArrowLeftRight size={14} className="text-[#5b8dee] flex-shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-sm text-text truncate">
          {pair.from_account_name} to {pair.to_account_name}
        </p>
        <p className="text-xs text-muted">
          {formatDate(pair.date)}, {formatCurrency(pair.amount)}
        </p>
      </div>
      <button
        className="flex items-center gap-1.5 text-xs bg-[#5b8dee] text-white rounded px-2.5 py-1.5 hover:opacity-90 disabled:opacity-40"
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
      <CheckCircle2 size={28} className="text-[#4ecba3] mb-3" />
      <p className="text-sm text-text">Queue clear</p>
      <p className="text-xs text-muted mt-1">No open items in this queue.</p>
    </div>
  );
}

export function ReviewInbox() {
  const qc = useQueryClient();
  const { addToast } = useAppStore();
  const [params, setParams] = useSearchParams();
  const [selectedIndex, setSelectedIndex] = useState(0);

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

  const activeItems = activeQueue === 'uncategorized'
    ? uncategorized?.data ?? []
    : activeQueue === 'pending'
      ? pending?.data ?? []
      : [];

  useEffect(() => {
    setSelectedIndex(0);
  }, [activeQueue]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) return;
      if (activeItems.length === 0) return;

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSelectedIndex((index) => Math.min(index + 1, activeItems.length - 1));
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSelectedIndex((index) => Math.max(index - 1, 0));
      }
      if (event.key === 'Enter' && activeQueue === 'pending') {
        event.preventDefault();
        const transaction = activeItems[selectedIndex];
        if (transaction) markReviewMutation.mutate(transaction.id);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeItems, activeQueue, markReviewMutation, selectedIndex]);

  const setActiveQueue = (queueId: TransactionReviewQueueId) => {
    setParams({ queue: queueId });
  };

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
          <div className="flex items-center gap-2 text-sm text-[#4ecba3]">
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

      <div className="bg-surface border border-border rounded flex-1 overflow-hidden">
        {loading ? (
          <SkeletonList rows={10} cols={5} />
        ) : activeQueue === 'uncategorized' ? (
          activeItems.length > 0 ? (
            activeItems.map((transaction, index) => (
              <TransactionRow
                key={transaction.id}
                transaction={transaction}
                selected={index === selectedIndex}
                categories={categories}
                onCategory={(transactionId, categoryId) => updateCategoryMutation.mutate({ transactionId, categoryId })}
              />
            ))
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
          (summary?.rule_suggestions.length ?? 0) > 0 ? (
            summary!.rule_suggestions.map((suggestion) => (
              <RuleSuggestionRow
                key={`${suggestion.pattern}:${suggestion.category_id}`}
                suggestion={suggestion}
                onApply={(item) => applyRuleMutation.mutate(item)}
                applying={applyRuleMutation.isPending && applyRuleMutation.variables?.pattern === suggestion.pattern}
              />
            ))
          ) : <EmptyQueue />
        ) : activeQueue === 'recurring_candidates' ? (
          (summary?.recurring_candidates.length ?? 0) > 0 ? (
            summary!.recurring_candidates.map((pattern) => (
              <RecurringRow
                key={pattern.id}
                pattern={pattern}
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
          (summary?.duplicate_candidates.length ?? 0) > 0 ? (
            summary!.duplicate_candidates.map((group) => (
              <DuplicateRow
                key={group.group_id}
                group={group}
                onDismiss={(groupId) => dismissDuplicateMutation.mutate(groupId)}
                busy={dismissDuplicateMutation.isPending && dismissDuplicateMutation.variables === group.group_id}
              />
            ))
          ) : <EmptyQueue />
        ) : (
          (summary?.transfer_candidates.length ?? 0) > 0 ? (
            summary!.transfer_candidates.map((pair) => (
              <TransferRow
                key={pair.pair_id}
                pair={pair}
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
