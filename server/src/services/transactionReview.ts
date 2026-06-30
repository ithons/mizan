import type Database from 'better-sqlite3';
import type {
  RecurringPattern,
  TransactionReviewQueueSummary,
  TransactionReviewSummary,
} from '../../../shared/types';
import { suggestMerchantRules } from './rules';
import {
  getDuplicateCandidateGroups,
  getTransferCandidatePairs,
} from './transactionIntegrity';

interface ReviewCounts {
  uncategorized_count: number;
  pending_count: number;
  duplicate_candidate_count: number;
  transfer_candidate_count: number;
}

function getCounts(db: Database.Database): ReviewCounts {
  return db.prepare(`
    SELECT
      SUM(CASE WHEN pending = 0 AND category_id IS NULL AND review_status = 'open' THEN 1 ELSE 0 END) AS uncategorized_count,
      SUM(CASE WHEN pending = 1 AND review_status = 'open' THEN 1 ELSE 0 END) AS pending_count,
      SUM(CASE WHEN duplicate_status = 'candidate' THEN 1 ELSE 0 END) AS duplicate_candidate_count,
      SUM(CASE WHEN transfer_status = 'candidate' AND amount < 0 THEN 1 ELSE 0 END) AS transfer_candidate_count
    FROM transactions
  `).get() as ReviewCounts;
}

function getRecurringCandidates(db: Database.Database): RecurringPattern[] {
  return db.prepare(`
    SELECT
      rp.*,
      c.name AS category_name,
      c.color AS category_color
    FROM recurring_patterns rp
    LEFT JOIN categories c ON c.id = rp.category_id
    WHERE rp.is_active = 1
      AND rp.is_confirmed = 0
      AND rp.transaction_count >= 3
    ORDER BY rp.transaction_count DESC, rp.next_expected ASC
    LIMIT 10
  `).all() as RecurringPattern[];
}

export function getTransactionReviewSummary(db: Database.Database): TransactionReviewSummary {
  const counts = getCounts(db);
  const ruleSuggestions = suggestMerchantRules(db);
  const recurringCandidates = getRecurringCandidates(db);
  const duplicateCandidates = getDuplicateCandidateGroups(db);
  const transferCandidates = getTransferCandidatePairs(db);
  
  const aiDraftsRaw = db.prepare(`
    SELECT * FROM advisor_drafts WHERE status = 'open' ORDER BY created_at DESC
  `).all() as Array<any>;
  
  const aiDrafts = aiDraftsRaw.map(row => ({
    ...row,
    payload: JSON.parse(row.payload),
    changes: JSON.parse(row.changes),
    citations: JSON.parse(row.citations),
    confirmation_required: true,
  }));

  const queues: TransactionReviewQueueSummary[] = [
    {
      id: 'ai_insights',
      label: 'AI Insights',
      count: aiDrafts.length,
      action_label: 'Review',
      severity: 'info',
    },
    {
      id: 'uncategorized',
      label: 'Needs category',
      count: counts.uncategorized_count ?? 0,
      action_label: 'Review',
      severity: 'attention',
      filters: {
        startDate: '',
        endDate: '',
        pending: false,
        uncategorized: true,
      },
    },
    {
      id: 'rule_suggestions',
      label: 'Rule suggestions',
      count: ruleSuggestions.length,
      action_label: 'Apply',
      severity: 'info',
    },
    {
      id: 'pending',
      label: 'Pending',
      count: counts.pending_count ?? 0,
      action_label: 'Review',
      severity: 'warning',
      filters: {
        startDate: '',
        endDate: '',
        pending: true,
      },
    },
    {
      id: 'recurring_candidates',
      label: 'Recurring candidates',
      count: recurringCandidates.length,
      action_label: 'Confirm',
      severity: 'info',
    },
    {
      id: 'duplicate_candidates',
      label: 'Possible duplicates',
      count: counts.duplicate_candidate_count ?? 0,
      action_label: 'Review',
      severity: 'warning',
    },
    {
      id: 'transfer_candidates',
      label: 'Detected transfers',
      count: counts.transfer_candidate_count ?? 0,
      action_label: 'Review',
      severity: 'info',
      filters: {
        startDate: '',
        endDate: '',
      },
    },
  ];

  return {
    total_open: queues.reduce((sum, queue) => sum + queue.count, 0),
    queues,
    rule_suggestions: ruleSuggestions,
    recurring_candidates: recurringCandidates,
    duplicate_candidates: duplicateCandidates,
    transfer_candidates: transferCandidates,
    ai_drafts: aiDrafts,
  };
}
