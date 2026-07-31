-- Let the rule revision log record a RESTORE.
--
-- Migration 042 gave `merchant_rule_revisions.operation` four values: create, recategorize, rename,
-- retire. There was no way back, because nothing un-retired a rule: migration 045 retired two AI
-- rules by hand and that was the whole story.
--
-- `retire_merchant_rule` is now an autonomous draft kind, and autonomy in this codebase means undo
-- by action id. Undo of a retirement is an un-retire, and it has to leave a row saying so. Writing
-- it as 'create' was the alternative and it is a false statement: a reader of the history would see
-- a rule appear that already existed, on a date it was not written, and the rule's own created_at
-- would disagree with its first 'create' revision.
--
-- SQLite cannot ALTER a CHECK, so this is the create-new/copy/drop/rename pattern migration 014
-- established. Nothing else about the table changes: same columns, same types, same indexes.
--
-- Row count is preserved rather than asserted at a figure here. A migration header that names a
-- count only re-states what the copy already guarantees, and it goes stale the moment anything
-- writes between the measurement and the run.

CREATE TABLE merchant_rule_revisions_new (
  id TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL,
  pattern TEXT NOT NULL,
  from_category_id TEXT,
  to_category_id TEXT,
  source TEXT NOT NULL,
  action_id TEXT,
  operation TEXT NOT NULL CHECK(operation IN ('create','recategorize','rename','retire','unretire')),
  created_at TEXT NOT NULL
);

INSERT INTO merchant_rule_revisions_new
  (id, rule_id, pattern, from_category_id, to_category_id, source, action_id, operation, created_at)
SELECT id, rule_id, pattern, from_category_id, to_category_id, source, action_id, operation, created_at
FROM merchant_rule_revisions;

DROP TABLE merchant_rule_revisions;
ALTER TABLE merchant_rule_revisions_new RENAME TO merchant_rule_revisions;

CREATE INDEX idx_merchant_rule_revisions_rule ON merchant_rule_revisions(rule_id, created_at);
CREATE INDEX idx_merchant_rule_revisions_action ON merchant_rule_revisions(action_id);
