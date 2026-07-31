-- Field-level provenance for date, amount and merchant_name, shaped like migration 042.
--
-- WHAT THIS IS NOT. It is not a pin. Nothing here lets an owner-authored `amount` or `date` win
-- against the institution, and that refusal is the design. An institution revises a posted row for
-- ordinary reasons (a tip adjustment, a partial reversal, a corrected post date), and a pinned
-- money field would leave the ledger permanently disagreeing with the balance it reconciles
-- against, with nothing on screen saying so. The requirement is the other one: when the provider
-- and the owner disagree about a field, that disagreement is recorded and knowable rather than
-- silently resolved in either direction.
--
-- THE ONE FIELD ALREADY PROTECTED, AND WHY IT STAYS PROTECTED THE OLD WAY TOO. Today
-- `upsertSimplefinTransaction` keeps a hand-edited `merchant_name` using the row's own pending
-- state: once a row has posted, the payee does not change at the institution, so a divergence from
-- that point is the owner's. That heuristic is all there was, because no provenance existed. It is
-- kept, and `merchant_name_source = 'human'` is added ON TOP of it rather than in place of it.
-- Replacing it would be a silent widening: every row written before this migration has a NULL
-- source, so a provenance-only test would hand the provider back the right to overwrite merchant
-- names it has been leaving alone, and the owner's older corrections are exactly the ones no
-- backfill can identify.
--
--   SELECT COUNT(*) FROM transactions;  -> 2579   (measured 2026-07-31 on a copy of mizan.db)
--
-- All 2579 start at NULL here. NULL means "authored before provenance was tracked", the same
-- honest gap `category_source` NULL carries from migration 041, and it must never be read as
-- 'provider'.
--
-- SIGN AND UNITS ARE UNCHANGED. `to_value`/`from_value` are TEXT because one column has to hold a
-- date, an integer-cent amount and a merchant string. An amount recorded here is the same integer
-- cents the column holds; nothing in this table passes through services/money.ts, and a reader
-- must cast rather than assume.

ALTER TABLE transactions ADD COLUMN date_source TEXT
  CHECK(date_source IS NULL OR date_source IN ('provider', 'human', 'ai'));
ALTER TABLE transactions ADD COLUMN amount_source TEXT
  CHECK(amount_source IS NULL OR amount_source IN ('provider', 'human', 'ai'));
ALTER TABLE transactions ADD COLUMN merchant_name_source TEXT
  CHECK(merchant_name_source IS NULL OR merchant_name_source IN ('provider', 'human', 'ai'));

-- The revision log. Append-only, one row per authored change, so a value's author is knowable and
-- the change is reversible by reading rather than by guessing.
--
-- `from_value` is the value the row held; `to_value` is the value the event is about. `origin` is
-- what says which of the two the row holds afterwards:
--   'owner_edit'        the owner set this field by hand. The row now holds to_value.
--   'provider_revision' the provider reported a different value for a field the owner had
--                       authored, and the provider's value was written. The row now holds
--                       to_value, and this row is the only remaining record of the owner's.
--   'provider_rejected' the provider reported a different value for a field the owner had
--                       authored, and the owner's value was kept (merchant_name only). The row
--                       still holds from_value; to_value is what the provider offered.
--
-- WHY THIS CANNOT BECOME AN HOURLY DRIP. Sync runs hourly and the provider re-sends the same
-- payload every pass. 'provider_revision' is self-limiting because the write it records makes the
-- stored value equal the provider's, so the second pass sees no difference. 'provider_rejected'
-- has no such write behind it, so it is deduped explicitly on (transaction_id, field, from_value,
-- to_value) by the writer: a standing disagreement is one row, not one row per hour. The failure
-- being avoided is the one recorded in `upsertSimplefinTransaction`'s own docstring, where every
-- row in the payload was reported as modified on a ledger that had not moved.
CREATE TABLE transaction_field_revisions (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  field TEXT NOT NULL CHECK(field IN ('date', 'amount', 'merchant_name')),
  from_value TEXT,
  to_value TEXT,
  from_source TEXT,
  to_source TEXT,
  origin TEXT NOT NULL CHECK(origin IN ('owner_edit', 'provider_revision', 'provider_rejected')),
  created_at TEXT NOT NULL
);

CREATE INDEX idx_txn_field_revisions_txn ON transaction_field_revisions(transaction_id, field, created_at);
CREATE INDEX idx_txn_field_revisions_origin ON transaction_field_revisions(origin, created_at);
