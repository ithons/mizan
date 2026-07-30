import type Database from 'better-sqlite3';
import type { AdvisorDraftPayload } from '../../../shared/types';
import type {
  RecurringPattern,
  TransactionReviewQueueSummary,
  TransactionReviewSummary,
} from '../../../shared/types';
import { suggestMerchantRules } from './rules';
import { isDraftStillActionable } from './advisorDrafts';
import { safeJsonParse } from './jsonSafe';
import {
  getDuplicateCandidateGroups,
  getTransferCandidatePairs,
} from './transactionIntegrity';
import { toDollars } from './money';

interface ReviewCounts {
  uncategorized_count: number;
  pending_count: number;
}

// A transaction "needs a category" whenever it has none and the user hasn't explicitly dismissed it.
// It deliberately does NOT require review_status='open': categorization side-effects set 'reviewed'
// (rules.ts, bulk categorize, transfer confirm), and a bulk pass once marked 1,735 imported rows
// 'reviewed' — which made 432 uncategorized rows invisible here while routes/insights.ts still
// counted them, so the app contradicted itself. This predicate is the single source of truth and
// must stay in sync with the uncategorized count in routes/insights.ts.
function getCounts(db: Database.Database): ReviewCounts {
  return db.prepare(`
    SELECT
      SUM(CASE WHEN pending = 0 AND category_id IS NULL AND review_status <> 'dismissed' THEN 1 ELSE 0 END) AS uncategorized_count,
      SUM(CASE WHEN pending = 1 AND review_status = 'open' THEN 1 ELSE 0 END) AS pending_count
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
  // average_amount is integer cents from recurring_patterns; dollarize for the client.
  const recurringCandidates = getRecurringCandidates(db).map((rp) => ({
    ...rp,
    average_amount: toDollars(rp.average_amount),
  }));
  // transactionIntegrity returns candidate amounts in integer cents. This summary is served
  // straight through to the client (routes/transactions.ts) and its other consumers
  // (aiContext/advisorTools/dataQuality/aiWorker) read only counts, never these amounts —
  // so dollarizing the candidate `amount` here is the single, safe conversion point.
  const duplicateCandidates = getDuplicateCandidateGroups(db).map((group) => ({
    ...group,
    amount: toDollars(group.amount),
  }));
  const transferCandidates = getTransferCandidatePairs(db).map((pair) => ({
    ...pair,
    amount: toDollars(pair.amount),
  }));

  const aiDraftsRaw = db.prepare(`
    SELECT * FROM advisor_drafts WHERE status = 'open' ORDER BY created_at DESC
  `).all() as Array<any>;
  
  const aiDrafts = aiDraftsRaw
    .map(row => {
      const payload = safeJsonParse<unknown>(row.payload, null, `advisor_draft ${row.id} payload`);
      const changes = safeJsonParse<unknown>(row.changes, null, `advisor_draft ${row.id} changes`);
      const citations = safeJsonParse<unknown>(row.citations, null, `advisor_draft ${row.id} citations`);
      // A draft with an unreadable payload cannot be applied — drop it rather
      // than surface a broken card.
      if (payload === null) return null;
      // A draft whose premise no longer holds is not work; showing it as work pins the review
      // count and the data-quality penalty on nothing. See isDraftStillActionable.
      if (!isDraftStillActionable(db, payload as AdvisorDraftPayload)) return null;
      return { ...row, payload, changes: changes ?? [], citations: citations ?? [], confirmation_required: true };
    })
    .filter((d): d is NonNullable<typeof d> => d !== null);

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
      // Counted per GROUP, matching how the inbox renders them. Counting the underlying
      // transactions instead made the badge ~2x the number of actionable rows.
      id: 'duplicate_candidates',
      label: 'Possible duplicates',
      count: duplicateCandidates.length,
      action_label: 'Review',
      severity: 'warning',
    },
    {
      // Counted per PAIR, matching the rendered rows.
      id: 'transfer_candidates',
      label: 'Detected transfers',
      count: transferCandidates.length,
      action_label: 'Review',
      severity: 'info',
      filters: {
        startDate: '',
        endDate: '',
      },
    },
  ];

  // 'pending' is reported in `queues` (it drives a Transactions filter) but excluded from the
  // headline total: a pending authorization isn't actionable — it posts on its own — and counting
  // it produced the "N items to review / nothing to review" mismatch.
  const actionableTotal = queues
    .filter((queue) => queue.id !== 'pending')
    .reduce((sum, queue) => sum + queue.count, 0);

  return {
    total_open: actionableTotal,
    queues,
    rule_suggestions: ruleSuggestions,
    recurring_candidates: recurringCandidates,
    duplicate_candidates: duplicateCandidates,
    transfer_candidates: transferCandidates,
    ai_drafts: aiDrafts,
  };
}
