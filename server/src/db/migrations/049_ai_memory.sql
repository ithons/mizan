-- ai_memory: durable statements about how the owner runs their money, which the ledger cannot hold.
--
-- WHAT IT IS FOR. Everything else the advisor is told is measured: balances, category totals,
-- reconciliation residuals, provenance counts. None of it can express "funds the taxable brokerage
-- before the Roth" or "treats the grocery budget as a floor rather than a ceiling". Those are
-- dispositions. They stay true while every number around them changes, and without somewhere to
-- keep them the advisor re-derives them from scratch each conversation, or guesses.
--
-- THE TWO WAYS THIS GOES WRONG. The schema answers the first one. It deliberately does not answer
-- the second, and says below why nothing can.
--
-- 1. A memory the owner cannot audit is a rumour the model repeats forever. `evidence` is NOT NULL
--    with a minimum length, so no row can exist that does not say what was observed to conclude it,
--    and the owner reads that text beside the statement in Settings. `superseded_by` means a belief
--    that changed keeps its history instead of being overwritten in place, for the same reason
--    merchant_rule_revisions and transaction_category_revisions exist: one slot cannot record a
--    history, and the thing you most want to see is what the belief used to be.
--
-- 2. A memory holding a derived number goes stale silently and is then repeated as current.
--    "spends $412 a month on groceries" is a measurement with an expiry date that nothing will ever
--    check; "treats the grocery budget as a floor" is durable. THIS SCHEMA DOES NOT ENFORCE THAT
--    DISTINCTION, and nothing else does either, because no pattern can draw it. `401(k)`, `529`,
--    `1099`, `403(b)`, `the 1st of each month` and `the 15th` are digits inside durable sentences;
--    "four hundred dollars a month" and "twelve thousand in the checking buffer" are measurements
--    carrying no digit at all. An earlier build put a figure rule on the write path and a CHECK on
--    the dollar sign here; both were wrong in both directions at once, and a refusal the owner
--    trusts and that is wrong in both directions is worse than no refusal.
--
--    What holds instead is that a stale figure is HARMLESS. Every statement reaches the prompt with
--    the date it was recorded and the observation count behind it (`pushMemory` in
--    services/aiContext.ts), under a heading that says to read each line as of that date. A figure
--    inside a dated statement is not a current figure whatever shape it took.
--
--    `kind` still has four members and every one of them is dispositional. That is what the store is
--    FOR, not a guard: a number can sit inside a 'preference' sentence like any other word.
--
--    `evidence` is under no rule at all beyond length. An observation is allowed to carry the
--    numbers that were observed, because it is explicitly a record of one moment. It is shown to the
--    owner, and services/aiContext.ts does not render it into the prompt, so it does not enter every
--    future conversation as an undated measurement. That is a prompt-omission, NOT secrecy: this
--    table is enumerated from sqlite_master by describe_schema and run_sql_query has no table
--    allowlist, so a model that asks for this column gets the text back verbatim.
--
-- SCOPE AND SUBJECT. `scope` says what class of thing the statement is about and `subject` names it.
-- The CHECK ties them together: household statements carry no subject, and every other scope must
-- name one. `subject` is a label rather than a foreign key because the four scopes point at four
-- different tables and one of them (merchant) is not a table at all.
--
-- DELETION IS A DELETE. Superseding records how a belief changed; the owner striking one is not a
-- belief that changed, it is a belief that was wrong, and a tombstone would leave the model able to
-- read a statement its owner rejected through run_sql_query. ON DELETE CASCADE runs the whole
-- supersede chain out with it.
--
-- NOTHING IN THIS BUILD WRITES source = 'ai'. The column exists because the author of a statement
-- decides how the prompt marks it, and because the write path this table was designed for is the
-- background worker. Whether the model may write here at all is a separate decision that depends on
-- a guard harness that does not exist yet.

CREATE TABLE ai_memory (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK(scope IN ('household','account','category','merchant','goal')),
  subject TEXT,
  statement TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('preference','constraint','intent','interpretation')),
  evidence TEXT NOT NULL,
  evidence_count INTEGER NOT NULL DEFAULT 1 CHECK(evidence_count >= 1),
  source TEXT NOT NULL DEFAULT 'owner' CHECK(source IN ('owner','ai')),
  -- DEFERRED because superseding has to mark the old row before inserting the new one: the unique
  -- index below covers live rows only, and a revision that keeps the statement and restates the
  -- evidence would collide with itself for the length of the transaction otherwise. The reference
  -- it points at is checked at COMMIT, so the order is free without the constraint being weaker.
  superseded_by TEXT REFERENCES ai_memory(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  superseded_at TEXT,
  created_at TEXT NOT NULL,

  CHECK (length(trim(statement)) BETWEEN 12 AND 400),
  CHECK (length(trim(evidence)) BETWEEN 12 AND 600),
  CHECK (
    (scope = 'household' AND subject IS NULL)
    OR (scope <> 'household' AND subject IS NOT NULL AND length(trim(subject)) > 0)
  ),
  CHECK (superseded_by IS NULL OR superseded_by <> id),
  CHECK ((superseded_by IS NULL) = (superseded_at IS NULL))
);

-- Live entries are the ones read into the prompt and the ones the owner acts on, so they are what
-- gets indexed. The unique index is the reason evidence_count exists: seeing the same thing twice
-- raises the count on one statement rather than storing the statement twice.
CREATE INDEX idx_ai_memory_live ON ai_memory(created_at) WHERE superseded_by IS NULL;
CREATE UNIQUE INDEX idx_ai_memory_statement_live
  ON ai_memory(lower(trim(statement))) WHERE superseded_by IS NULL;
