-- Record WHAT set each transaction's category, on the row itself.
--
-- The AI has categorized 52 transactions and created 23 merchant rules on this database with no
-- human in the loop, against 11 the user confirmed by hand. Afterwards nothing on the row
-- distinguishes an AI guess from a rule hit from a deliberate human decision: the only record is
-- the advisor_actions list in Settings, which is a separate screen from the numbers it affected.
--
-- That was tolerable while auto-apply was gated on a confidence threshold. It is not tolerable
-- now that categorization and rule creation run unattended by design, because a merchant rule
-- applies by substring and 0.86 fuzzy similarity across the whole ledger: one bad rule can
-- relabel an unbounded number of rows. Recoverable is the property that makes that safe, and
-- recoverable requires knowing which rows an action touched and what they were before.
--
--   category_source       'human' | 'rule' | 'heuristic' | 'ai'
--   category_action_id    advisor_actions.id, when an AI action set it
--   category_previous_id  the category displaced by that write, so undo is exact rather than
--                         "revert to uncategorized" (which would silently discard a correction
--                         the AI made to a wrongly-categorized row)
--
-- NULL category_source means "set before provenance was tracked", which is honest: most of the
-- backfilled ledger predates this and we genuinely do not know.

ALTER TABLE transactions ADD COLUMN category_source TEXT;
ALTER TABLE transactions ADD COLUMN category_action_id TEXT;
ALTER TABLE transactions ADD COLUMN category_previous_id TEXT;

-- Undo reads by action id, and the AI paths write by it on every categorization.
CREATE INDEX IF NOT EXISTS idx_transactions_category_action
  ON transactions(category_action_id);

-- Backfill what is actually knowable.
--
-- 1. A row flagged manually_categorized is a deliberate human choice (migration 026).
UPDATE transactions
SET category_source = 'human'
WHERE manually_categorized = 1 AND category_id IS NOT NULL;

-- 2. advisor_actions already records every applied AI categorization with the transaction id in
-- its payload, so the existing audit trail can be reattached to the rows it changed. Skip rows
-- the user has since categorized by hand: their choice is the current truth, and pointing an
-- undo at it would revert a human decision. previous_category_id stays NULL for these: the
-- worker only ever proposes for uncategorized rows, so undo returning them to uncategorized is
-- exactly right.
UPDATE transactions
SET category_source = 'ai',
    category_action_id = (
      SELECT a.id FROM advisor_actions a
      WHERE a.kind = 'categorize_transaction'
        AND json_valid(a.payload)
        AND json_extract(a.payload, '$.transaction_id') = transactions.id
      ORDER BY a.created_at DESC
      LIMIT 1
    )
WHERE manually_categorized = 0
  AND category_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM advisor_actions a
    WHERE a.kind = 'categorize_transaction'
      AND json_valid(a.payload)
      AND json_extract(a.payload, '$.transaction_id') = transactions.id
  );
