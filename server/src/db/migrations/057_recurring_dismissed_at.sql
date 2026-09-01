-- A dismissal is the owner's decision and has to outlive the next detection pass.
--
-- THE DEFECT. `POST /api/recurring/:id/dismiss` did two things: set `is_active = 0,
-- is_confirmed = 0` on the pattern, and NULL `recurring_id` on every transaction linked to it.
-- `detectRecurring` honours that state at services/recurring.ts:440
-- (`if (!existing.is_active && !existing.is_confirmed) continue;`) and then, at the end of the
-- same function, deletes stranded rows:
--
--   DELETE FROM recurring_patterns
--    WHERE is_active = 0 AND is_confirmed = 0
--      AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.recurring_id = recurring_patterns.id)
--
-- That is the guard's own predicate plus a condition the dismiss had just made true by unlinking
-- the transactions. So the row recording the decision was deleted by the very next sync, the
-- merchant was detected fresh on the one after, and the bill the owner dismissed came back with
-- no trace that they had ever said no.
--
-- WHY A COLUMN RATHER THAN A NARROWER DELETE. The delete has a real job, described in its own
-- comment: `merchant_name` is UNIQUE and detection upserts against it, so any change to
-- `normalizeMerchant()` renames the group and strands the old row forever. Migration 029
-- hand-deleted one such row. Narrowing the delete by guessing at merchant names would trade a
-- silent resurrection for a silent accumulation. A dismissal that says so in a column is
-- distinguishable from a rename artifact, which is the actual difference between the two cases.
--
-- Existing rows get NULL, which is correct: nothing in this database recorded a dismissal before
-- now, so there is no dismissal to backfill. Rows currently sitting inactive-and-unconfirmed are
-- indistinguishable from rename strandings and are left as such.

ALTER TABLE recurring_patterns ADD COLUMN dismissed_at TEXT;

CREATE INDEX IF NOT EXISTS idx_recurring_patterns_dismissed_at
  ON recurring_patterns(dismissed_at);
