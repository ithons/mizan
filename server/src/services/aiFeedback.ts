import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import type { RevertableRevision } from './categoryWrites';

/**
 * Where the record of an AI answer being rejected is written (migration 047).
 *
 * Exactly three call sites, and they are the three moments the owner disagrees with the model:
 * `undoAdvisorAction` (reversed a whole action), `updateTransaction` (replaced one row's category
 * by hand, recorded BEFORE `category_action_id` is cleared, which is what used to destroy the
 * evidence) and `dismissAdvisorDraft` (declined a proposal without applying it).
 *
 * This module records. It does not judge: no confidence, no rating, no accuracy figure, nothing
 * out of 100. A row says what was proposed, what the owner did instead, and what the proposal
 * rested on, so a future reader can form its own conclusion from the evidence rather than from a
 * number somebody derived once.
 */

export type AiFeedbackSignal = 'undo' | 'manual_override' | 'draft_dismissed';

/** What the owner put in place of the proposal. Disambiguates a NULL `owner_category_id`. */
export type AiFeedbackOwnerChoice = 'category' | 'uncategorized' | 'declined' | 'mixed';

export interface AiFeedbackRow {
  id: string;
  signal: AiFeedbackSignal;
  proposal_kind: string;
  action_id: string | null;
  draft_id: string | null;
  transaction_id: string | null;
  merchant_name: string | null;
  proposed_category_id: string | null;
  proposed_pattern: string | null;
  proposal_summary: string | null;
  owner_choice: AiFeedbackOwnerChoice;
  owner_category_id: string | null;
  affected_transactions: number;
  /** 1 lapsed, 0 still live, NULL not asked or not answerable. Never defaulted to 0. */
  stale: number | null;
  created_at: string;
}

interface AiFeedbackInsert {
  signal: AiFeedbackSignal;
  proposalKind: string;
  actionId?: string | null;
  draftId?: string | null;
  transactionId?: string | null;
  merchantName?: string | null;
  proposedCategoryId?: string | null;
  proposedPattern?: string | null;
  proposalSummary?: string | null;
  ownerChoice: AiFeedbackOwnerChoice;
  ownerCategoryId?: string | null;
  affectedTransactions: number;
  stale?: number | null;
  now: string;
}

function insertFeedback(db: Database.Database, row: AiFeedbackInsert): string {
  const id = uuidv4();
  db.prepare(`
    INSERT INTO ai_feedback
      (id, signal, proposal_kind, action_id, draft_id, transaction_id, merchant_name,
       proposed_category_id, proposed_pattern, proposal_summary, owner_choice, owner_category_id,
       affected_transactions, stale, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    row.signal,
    row.proposalKind,
    row.actionId ?? null,
    row.draftId ?? null,
    row.transactionId ?? null,
    row.merchantName ?? null,
    row.proposedCategoryId ?? null,
    row.proposedPattern ?? null,
    row.proposalSummary ?? null,
    row.ownerChoice,
    row.ownerCategoryId ?? null,
    row.affectedTransactions,
    row.stale ?? null,
    row.now
  );
  return id;
}

interface ActionEvidence {
  kind: string;
  summary: string | null;
  pattern: string | null;
}

/**
 * The proposal an action id stands for.
 *
 * `json_valid` guards the extract because `advisor_actions.payload` is free TEXT and a malformed
 * blob would otherwise throw out of a path whose whole job is to not lose the record.
 */
function actionEvidence(db: Database.Database, actionId: string): ActionEvidence | undefined {
  return db.prepare(`
    SELECT kind,
           summary,
           CASE WHEN json_valid(payload) THEN json_extract(payload, '$.pattern') END AS pattern
    FROM advisor_actions
    WHERE id = ?
  `).get(actionId) as ActionEvidence | undefined;
}

function merchantOf(db: Database.Database, transactionId: string): string | null {
  const row = db.prepare(
    'SELECT merchant_name, original_name FROM transactions WHERE id = ?'
  ).get(transactionId) as { merchant_name: string | null; original_name: string } | undefined;
  if (!row) return null;
  return row.merchant_name ?? row.original_name;
}

/** The single value shared by every element, or undefined when they disagree. */
function unanimous<T>(values: readonly T[]): { value: T } | undefined {
  const distinct = new Set(values);
  if (distinct.size !== 1) return undefined;
  return { value: values[0] };
}

export interface UndoFeedback {
  actionId: string;
  /** The revisions the undo consumed. They carry what the model chose and what it displaced. */
  revisions: readonly RevertableRevision[];
  /** Rows whose category actually changed, as `revertRevisions` measured it. */
  reverted: number;
}

/**
 * The owner reversed an action wholesale.
 *
 * Reads the revisions the undo consumed rather than the action's payload, so every field describes
 * what was really on the ledger. A single-row action names its transaction and merchant; a
 * merchant rule that swept many rows leaves those NULL rather than picking one to stand for the
 * rest, and the per-row detail stays joinable in `transaction_category_revisions` by action_id.
 *
 * `affected_transactions` is the caller's measured count, not `revisions.length`. A revision whose
 * row already held the value being restored is consumed without changing anything, and reporting
 * it as a reverted row would overstate the blast radius.
 */
export function recordUndoFeedback(
  db: Database.Database,
  params: UndoFeedback,
  now = new Date().toISOString()
): string | null {
  const { actionId, revisions } = params;
  if (revisions.length === 0) return null;

  const evidence = actionEvidence(db, actionId);
  if (!evidence) return null;

  const proposed = unanimous(revisions.map((r) => r.to_category_id));
  const restored = unanimous(revisions.map((r) => r.from_category_id));

  let ownerChoice: AiFeedbackOwnerChoice = 'mixed';
  let ownerCategoryId: string | null = null;
  if (restored) {
    ownerChoice = restored.value === null ? 'uncategorized' : 'category';
    ownerCategoryId = restored.value;
  }

  const single = revisions.length === 1 ? revisions[0] : undefined;

  return insertFeedback(db, {
    signal: 'undo',
    proposalKind: evidence.kind,
    actionId,
    transactionId: single?.transaction_id ?? null,
    merchantName: single ? merchantOf(db, single.transaction_id) : null,
    proposedCategoryId: proposed?.value ?? null,
    proposedPattern: evidence.pattern,
    proposalSummary: evidence.summary,
    ownerChoice,
    ownerCategoryId,
    affectedTransactions: params.reverted,
    now,
  });
}

export interface ManualOverrideFeedback {
  transactionId: string;
  /** The action that owned the row's category, read before `category_action_id` is cleared. */
  actionId: string;
  /** The category the model had put on the row. */
  proposedCategoryId: string | null;
  /** The category the owner put there instead; null when the owner cleared it. */
  ownerCategoryId: string | null;
  merchantName: string | null;
}

/**
 * The owner replaced one row's category by hand.
 *
 * Only a genuine disagreement reaches here. An edit that lands on the same category the model
 * chose is agreement, and recording it as feedback would teach the model the opposite of what
 * happened; `updateTransaction` makes that call, not this function.
 */
export function recordManualOverrideFeedback(
  db: Database.Database,
  params: ManualOverrideFeedback,
  now = new Date().toISOString()
): string | null {
  const evidence = actionEvidence(db, params.actionId);
  if (!evidence) return null;

  return insertFeedback(db, {
    signal: 'manual_override',
    proposalKind: evidence.kind,
    actionId: params.actionId,
    transactionId: params.transactionId,
    merchantName: params.merchantName,
    proposedCategoryId: params.proposedCategoryId,
    proposedPattern: evidence.pattern,
    proposalSummary: evidence.summary,
    ownerChoice: params.ownerCategoryId === null ? 'uncategorized' : 'category',
    ownerCategoryId: params.ownerCategoryId,
    affectedTransactions: 1,
    now,
  });
}

export interface DraftDismissalFeedback {
  draftId: string;
  kind: string;
  summary: string | null;
  proposedCategoryId: string | null;
  proposedPattern: string | null;
  transactionId: string | null;
  /**
   * 1 the premise had lapsed, 0 it was still live, null nothing judged it: either the payload no
   * longer parses or the kind has no liveness check. Passing 0 for an unjudged draft would assert
   * a check that never ran.
   */
  stale: number | null;
}

/**
 * The owner declined a proposal without applying it.
 *
 * `stale` is the field that keeps this honest. A dismissal of a draft whose premise had already
 * lapsed says the model was late, not that it was wrong about the merchant, and a reader that
 * cannot separate the two draws a false lesson from its own history. The caller decides it,
 * because the liveness rule lives with the drafts, and it must pass NULL rather than 0 for a draft
 * nothing judged: "still live" is a conclusion, not a default.
 */
export function recordDraftDismissalFeedback(
  db: Database.Database,
  params: DraftDismissalFeedback,
  now = new Date().toISOString()
): string {
  return insertFeedback(db, {
    signal: 'draft_dismissed',
    proposalKind: params.kind,
    draftId: params.draftId,
    transactionId: params.transactionId,
    merchantName: params.transactionId ? merchantOf(db, params.transactionId) : null,
    proposedCategoryId: params.proposedCategoryId,
    proposedPattern: params.proposedPattern,
    proposalSummary: params.summary,
    ownerChoice: 'declined',
    affectedTransactions: 0,
    stale: params.stale,
    now,
  });
}

export function listAiFeedback(db: Database.Database, limit = 50): AiFeedbackRow[] {
  return db.prepare(`
    SELECT * FROM ai_feedback
    ORDER BY created_at DESC, rowid DESC
    LIMIT ?
  `).all(limit) as AiFeedbackRow[];
}
