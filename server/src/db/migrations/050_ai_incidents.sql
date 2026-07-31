-- ai_incidents: what an autonomous batch broke, and what happened when the harness undid it.
--
-- WHAT BREACHES, AND WHY "ANY FIGURE MOVED" IS NOT IT. Recategorizing is what per-category totals
-- are FOR: a batch that files six uncategorized rows moves six category lines by construction. A
-- guard that fired on that would fire on every healthy pass and be switched off inside a week. The
-- property that is actually true is a conservation one. A batch that only rewrites `category_id`
-- reshuffles the ledger; it does not change its magnitude. So the month's spend and income may move
-- only by exactly what the rewritten rows account for, and net worth and the scheduled forecast may
-- not move at all.
--
-- Crossing a boundary is the interesting case and it is NOT a breach. cat_xfer, cat_inv and
-- cat_crypto are outside report scope, and `is_income` / `is_investment` decide which side of the
-- ledger a row lands on, so filing a row into a transfer category legitimately lowers the month's
-- spend. What makes it a breach is the total moving by an amount the batch's own rewrites cannot
-- explain, to the cent. services/aiGuards.ts computes that expectation from each rewritten row's
-- before-amount and its before/after classification, and both are read through the same predicates
-- the Reports page uses, never a second copy of them.
--
-- `breaches` therefore carries, per entry, which headline moved, by how much, and how much of that
-- movement the rewrites accounted for. A reader that only knows "something broke" cannot act.
--
-- THE ROW OUTLIVES THE REVERT, AND THAT IS THE POINT. Auto-revert is all-or-nothing: either every
-- action in the batch is undone or none of it is. The undo runs in its own transaction and rolls
-- back if any part of it fails or if the headlines do not land back exactly where they started, and
-- a rolled-back transaction takes everything written inside it with it. So this row is INSERTed with
-- revert_status = 'pending' BEFORE the revert is attempted and UPDATEd afterwards. Writing it inside
-- the revert would mean the one outcome most worth recording, a revert that failed, is the one
-- outcome that erases itself.
--
-- A REVERT THAT FAILED IS THE WORST STATE THIS SYSTEM CAN REACH. It means a batch that broke a
-- headline is still applied and the harness could not take it back. It is recorded as 'failed' with
-- the reason in `revert_error`, never swallowed, and `unrevertable_rows` counts category writes the
-- batch made that carry no action id this harness can revert, which is the reason it refuses to
-- start a partial undo.
--
-- NO FOREIGN KEYS, for the same reason ai_feedback (047) declares none: this is evidence about
-- actions, and it has to survive them. `action_ids` and `reverted_action_ids` are JSON arrays of
-- recorded advisor_actions ids, not live pointers. Per-row detail for every id here already lives in
-- transaction_category_revisions keyed by the same action_id, so it is not duplicated.
--
-- NOTHING HERE IS A GRADE. No score, no severity number, no accuracy rate. The columns say what
-- moved and what was done about it.

CREATE TABLE ai_incidents (
  id TEXT PRIMARY KEY,

  -- The pass the harness was guarding, e.g. 'worker_autonomous_pass'. Names the job, not the model.
  batch_name TEXT NOT NULL,
  detected_at TEXT NOT NULL,

  -- The headline month the snapshot covered, and its resolved bounds. Stored rather than derived:
  -- 'yyyy-MM' plus local month boundaries is exactly the calculation SQLite's UTC date('now')
  -- disagrees with, and a reader re-deriving it months later would not reproduce the window.
  -- The forecast window the scheduled-net headline covers is pinned the same way and travels inside
  -- before_headlines/after_headlines, so a reader can see both captures asked about the same days.
  month TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,

  -- JSON array. One entry per breached headline: {headline, policy, before, after, moved,
  -- explained, unit, detail}. `moved` is after - before, `explained` is what the batch's own
  -- rewrites accounted for, and the gap between them is the finding.
  breaches TEXT NOT NULL,

  -- The full headline set on both sides, so a reverted batch still teaches something. Without these
  -- the incident says a number moved and the number is already gone.
  before_headlines TEXT NOT NULL,
  after_headlines TEXT NOT NULL,

  -- JSON array of advisor_actions ids the batch created.
  action_ids TEXT NOT NULL,

  -- 'reverted' means every category write the batch made was taken back. 'failed' means none of it
  -- was: the undo runs in one transaction and rolls back whole, so there is no partial state to name.
  revert_status TEXT NOT NULL CHECK(revert_status IN ('pending', 'reverted', 'failed')),
  -- JSON array, NULL until the revert resolves. Equal to action_ids on success: a partial revert is
  -- never a resolved state here.
  reverted_action_ids TEXT,
  -- Category writes taken back, not distinct transactions. The undo iterates until the batch's
  -- writes are all consumed, so a transaction one action wrote twice contributes two.
  reverted_rows INTEGER,
  -- Category writes the batch made that no action id in `action_ids` can revert. Non-zero is why a
  -- revert was refused before it started.
  unrevertable_rows INTEGER NOT NULL DEFAULT 0,

  -- Whether the headline set came back to its pre-batch values after the revert, which is a
  -- SEPARATE question from whether the revert worked. Reverting category writes cannot take back an
  -- amount the batch changed or a row it inserted, and those are what a breach implicates: the
  -- conservation rule is built so that rewriting categories alone cannot breach it. A revert that
  -- succeeds and leaves the headline still moved is recorded as exactly that, with the residue named
  -- in revert_error, rather than as a clean recovery.
  headlines_restored INTEGER CHECK(headlines_restored IS NULL OR headlines_restored IN (0, 1)),
  revert_error TEXT,
  resolved_at TEXT,

  -- 'pending' is the state between the INSERT and the revert attempt. A row still pending after the
  -- process that wrote it exited means the revert never returned at all, which is itself a finding.
  CHECK ((revert_status = 'pending') = (resolved_at IS NULL)),
  CHECK (revert_status <> 'failed' OR (revert_error IS NOT NULL AND length(trim(revert_error)) > 0)),
  CHECK (revert_status <> 'reverted' OR (reverted_action_ids IS NOT NULL AND headlines_restored IS NOT NULL)),
  CHECK (unrevertable_rows >= 0)
);

CREATE INDEX idx_ai_incidents_detected_at ON ai_incidents(detected_at DESC);
-- Unresolved and failed reverts are what a reader comes here for; neither should ever be common.
CREATE INDEX idx_ai_incidents_unresolved ON ai_incidents(detected_at DESC) WHERE revert_status <> 'reverted';
