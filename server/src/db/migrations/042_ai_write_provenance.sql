-- AI write provenance: make repeated autonomous writes reversible, and stop a merchant rule's
-- category from being silently rewritten.
--
-- THE BUG THIS EXISTS FOR. The background worker proposes merchant rules without ever being shown
-- the rules that already exist, so it re-proposes the same merchant every sync. `upsertMerchantRule`
-- matched on lower(pattern) and UPDATEd `category_id` in place, so each re-proposal could silently
-- move a rule to a different category and re-sweep every matching transaction. On 2026-07-29 the
-- worker set Spotify -> cat_ent_streaming at 18:04 and Spotify -> cat_subscriptions at 20:04:
-- one rule row, two categories, every matching row relabelled twice in two hours with nothing in
-- the UI saying a category had changed. advisor_actions holds 7 create_merchant_rule rows for
-- Spotify, 8 for Trupanion and 7 for Backblaze; merchant_rules holds exactly one row for each,
-- with a created_at from the first write and a category from the last.
--
-- WHY UNDO COULD NOT SAVE IT. Undo restored transactions.category_previous_id, a single slot.
-- Each pass set category_previous_id = category_id before writing, so the second pass overwrote
-- the first pass's memory of the truth: "previous" came to mean "what the AI guessed last time",
-- and the earlier action had zero rows still pointing at it and became permanently un-undoable.
-- One slot cannot record a history. These two append-only tables can.
--
-- The unique index is the point of this migration as much as the tables are. The case-insensitive
-- dedup rule lived only in application code; here it becomes something the engine enforces.

ALTER TABLE merchant_rules ADD COLUMN source TEXT NOT NULL DEFAULT 'human';
ALTER TABLE merchant_rules ADD COLUMN action_id TEXT;
ALTER TABLE merchant_rules ADD COLUMN updated_at TEXT;
ALTER TABLE merchant_rules ADD COLUMN retired_at TEXT;

-- Retired rules keep their row so their revisions stay meaningful, so the uniqueness that matters
-- is over live rules only.
CREATE UNIQUE INDEX idx_merchant_rules_pattern_live
  ON merchant_rules(lower(pattern)) WHERE retired_at IS NULL;

CREATE TABLE merchant_rule_revisions (
  id TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL,
  pattern TEXT NOT NULL,
  from_category_id TEXT,
  to_category_id TEXT,
  source TEXT NOT NULL,
  action_id TEXT,
  operation TEXT NOT NULL CHECK(operation IN ('create','recategorize','rename','retire')),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_merchant_rule_revisions_rule ON merchant_rule_revisions(rule_id, created_at);
CREATE INDEX idx_merchant_rule_revisions_action ON merchant_rule_revisions(action_id);

-- One row per category write, so undo walks back to the last value a given action displaced
-- instead of reading a single slot that the next write clobbers.
-- `revert_of` and `reverted_at` are what make undo a stack rather than a one-shot.
--
-- A revert is itself a category write, so it appends a row like any other. Without marking it, that
-- row becomes the newest revision for the transaction and buries the action underneath, so undoing
-- action B would leave action A permanently unreachable: exactly the failure this table exists to
-- end, reintroduced by the fix for it. A revert therefore stamps `reverted_at` on the revision it
-- consumes and records itself with `revert_of` set, and "the newest revision for this transaction"
-- means the newest row with neither field set. Peeling B off makes A the newest again.
CREATE TABLE transaction_category_revisions (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  from_category_id TEXT,
  to_category_id TEXT,
  from_source TEXT,
  to_source TEXT,
  action_id TEXT,
  revert_of TEXT,
  reverted_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_txn_category_revisions_txn ON transaction_category_revisions(transaction_id, created_at);
CREATE INDEX idx_txn_category_revisions_action ON transaction_category_revisions(action_id);

-- Attribute existing rules to the AI action that last wrote them, so the audit trail is complete
-- from today rather than from the next write.
UPDATE merchant_rules
SET source = 'ai',
    action_id = (
      SELECT a.id FROM advisor_actions a
      WHERE a.kind = 'create_merchant_rule'
        AND lower(json_extract(a.payload, '$.pattern')) = lower(merchant_rules.pattern)
      ORDER BY a.created_at DESC LIMIT 1
    )
WHERE EXISTS (
  SELECT 1 FROM advisor_actions a
  WHERE a.kind = 'create_merchant_rule'
    AND lower(json_extract(a.payload, '$.pattern')) = lower(merchant_rules.pattern)
);

-- Seed the transaction revision log from the single-slot columns so the 140 existing actions stay
-- undoable after undo switches to reading revisions. Only rows still pointing at an action can be
-- recovered; rows whose action was already clobbered by a later pass are gone either way.
INSERT INTO transaction_category_revisions
  (id, transaction_id, from_category_id, to_category_id, from_source, to_source, action_id, revert_of, reverted_at, created_at)
SELECT
  lower(hex(randomblob(16))),
  id,
  category_previous_id,
  category_id,
  NULL,
  category_source,
  category_action_id,
  NULL,
  NULL,
  updated_at
FROM transactions
WHERE category_action_id IS NOT NULL;
