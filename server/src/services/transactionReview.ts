import type Database from 'better-sqlite3';
import type {
  RecurringPattern,
  TransactionReviewQueueSummary,
  TransactionReviewSummary,
} from '../../../shared/types';
import { suggestMerchantRules } from './rules';

interface ReviewCounts {
  uncategorized_count: number;
  pending_count: number;
}

function getCounts(db: Database.Database): ReviewCounts {
  return db.prepare(`
    SELECT
      SUM(CASE WHEN pending = 0 AND category_id IS NULL THEN 1 ELSE 0 END) AS uncategorized_count,
      SUM(CASE WHEN pending = 1 THEN 1 ELSE 0 END) AS pending_count
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

  const queues: TransactionReviewQueueSummary[] = [
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
  ];

  return {
    total_open: queues.reduce((sum, queue) => sum + queue.count, 0),
    queues,
    rule_suggestions: ruleSuggestions,
    recurring_candidates: recurringCandidates,
  };
}
