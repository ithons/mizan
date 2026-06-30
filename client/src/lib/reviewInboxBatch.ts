import type { TransactionReviewQueueId } from '@shared/types';

export const REVIEW_QUEUE_ORDER: TransactionReviewQueueId[] = [
  'ai_insights',
  'uncategorized',
  'rule_suggestions',
  'pending',
  'recurring_candidates',
  'duplicate_candidates',
  'transfer_candidates',
];

export type ReviewBatchActionId = 'primary' | 'dismiss';

export interface ReviewBatchAction {
  id: ReviewBatchActionId;
  label: string;
}

export function nextReviewQueue(
  current: TransactionReviewQueueId,
  direction: 1 | -1
): TransactionReviewQueueId {
  const index = REVIEW_QUEUE_ORDER.indexOf(current);
  const safeIndex = index >= 0 ? index : 0;
  const nextIndex = (safeIndex + direction + REVIEW_QUEUE_ORDER.length) % REVIEW_QUEUE_ORDER.length;
  return REVIEW_QUEUE_ORDER[nextIndex];
}

export function reviewBatchActions(
  queueId: TransactionReviewQueueId,
  itemCount: number
): ReviewBatchAction[] {
  if (itemCount <= 0) return [];

  switch (queueId) {
    case 'ai_insights':
      return [
        { id: 'primary', label: 'Approve All' },
        { id: 'dismiss', label: 'Dismiss All' },
      ];
    case 'rule_suggestions':
      return [{ id: 'primary', label: 'Apply All' }];
    case 'pending':
      return [{ id: 'primary', label: 'Mark All Reviewed' }];
    case 'recurring_candidates':
      return [
        { id: 'primary', label: 'Confirm All' },
        { id: 'dismiss', label: 'Dismiss All' },
      ];
    case 'duplicate_candidates':
      return [{ id: 'dismiss', label: 'Dismiss All' }];
    case 'transfer_candidates':
      return [
        { id: 'primary', label: 'Confirm All' },
        { id: 'dismiss', label: 'Dismiss All' },
      ];
    case 'uncategorized':
      return [];
  }
}
