-- Record when the model's answer was rejected.
--
-- THE HOLE THIS FILLS. Nothing in this database records an AI outcome. `undoAdvisorAction` reverts
-- categories and writes no note that a reversal happened; `updateTransaction` sets
-- `category_action_id = NULL` on a hand edit, which is correct (undo must not reach back through a
-- human decision) and simultaneously destroys the only evidence that the model's answer was
-- replaced; `dismissAdvisorDraft` flips a status and keeps no trace of what was declined once the
-- worker deletes the draft row on its next pass (`aiWorker.ts`, `DELETE FROM advisor_drafts`).
--
-- Measured on a copy of .mizan/mizan.db, 2026-07-31, with the queries beside them:
--   SELECT COUNT(*) FROM advisor_actions;                                -> 140
--   SELECT COUNT(*) FROM advisor_drafts;                                 -> 251
--   SELECT COUNT(*) FROM advisor_drafts WHERE status = 'dismissed';      ->   3
--   SELECT COUNT(*) FROM transactions WHERE category_action_id IS NOT NULL; ->  86
-- 140 applied actions, and the model has never been shown one outcome.
--
-- WHAT A USEFUL ROW LOOKS LIKE. "The AI was wrong" is worth almost nothing on its own. The row has
-- to answer three questions: what did I propose, what did the owner do instead, and on what
-- evidence did I propose it. So the merchant, the proposed category, the proposed pattern, the
-- owner's replacement and the model's own summary are all recorded on the row itself.
--
-- THIS IS EVIDENCE, NOT A GRADE. No confidence, no rating, no accuracy percentage, no score. A
-- self-reported confidence gate was already removed from the autonomy boundary once (f61109b); a
-- derived accuracy figure would be the same mistake in a different column.
--
-- NO FOREIGN KEYS, DELIBERATELY. Every reference here is a recorded historical value rather than a
-- live pointer, because the evidence has to outlive the thing it describes: the worker deletes
-- drafts it regenerates, migration 036 deleted a category three drafts still pointed at, and a
-- manual transaction can be deleted outright. A CASCADE or a RESTRICT would either erase the
-- record of a mistake or block an ordinary delete. Joins to advisor_actions and transactions are
-- still available where those rows survive; per-row detail for a multi-row action lives in
-- transaction_category_revisions keyed by the same action_id, so it is not duplicated here.
--
-- `stale` separates "you were wrong" from "you were late". Fourteen open drafts on the live ledger
-- point at transactions that already have a category (the case `isDraftStillActionable` exists
-- for); dismissing one of those is not the model being wrong about the merchant, and a reader that
-- cannot tell the two apart learns a false lesson from its own history. Measured 2026-07-31:
--   SELECT COUNT(*) FROM advisor_drafts d
--   JOIN transactions t ON t.id = json_extract(d.payload, '$.transaction_id')
--   WHERE d.status = 'open' AND d.kind = 'categorize_transaction'
--     AND t.category_id IS NOT NULL;                                     ->  14
CREATE TABLE ai_feedback (
  id TEXT PRIMARY KEY,

  -- How the disagreement reached us. One value per call site, and there are exactly three.
  signal TEXT NOT NULL CHECK(signal IN ('undo', 'manual_override', 'draft_dismissed')),

  -- The advisor_drafts / advisor_actions kind the proposal was, e.g. 'categorize_transaction'.
  proposal_kind TEXT NOT NULL,

  action_id TEXT,
  draft_id TEXT,

  -- Populated only when the disagreement is about exactly one transaction. A merchant rule undo
  -- covers many rows and leaves these NULL rather than naming an arbitrary one.
  transaction_id TEXT,
  merchant_name TEXT,

  proposed_category_id TEXT,
  proposed_pattern TEXT,
  proposal_summary TEXT,

  -- What the owner did instead. `owner_choice` exists because a NULL owner_category_id is
  -- otherwise ambiguous between "put it back to uncategorized", "declined without replacing" and
  -- "restored several different categories across a multi-row undo".
  owner_choice TEXT NOT NULL CHECK(owner_choice IN ('category', 'uncategorized', 'declined', 'mixed')),
  owner_category_id TEXT,

  -- Rows the reversal actually touched. 0 for a dismissal: nothing was applied.
  affected_transactions INTEGER NOT NULL DEFAULT 0,

  -- 1 when the proposal's premise had already lapsed before the owner acted on it, 0 when it was
  -- still live. NULL means the question was not asked or could not be answered: it is not a
  -- meaningful question for an undo or an override, both of which act on something already
  -- applied, and a draft whose stored payload no longer parses cannot be judged either way.
  -- Defaulting that to 0 would assert a check the code did not perform.
  stale INTEGER CHECK(stale IS NULL OR stale IN (0, 1)),

  created_at TEXT NOT NULL
);

CREATE INDEX idx_ai_feedback_created_at ON ai_feedback(created_at DESC);
CREATE INDEX idx_ai_feedback_merchant ON ai_feedback(merchant_name);
CREATE INDEX idx_ai_feedback_action ON ai_feedback(action_id);
