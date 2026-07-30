-- Data repair, and labelled as one. The write-path fixes are what stop this recurring:
-- `applyMerchantRulesToExistingTransactions` now resolves overlaps human-first with a total order,
-- and `checkRuleDoesNotContradictOwnerRule` refuses an AI rule that contends with an owner rule.
-- Neither of those unwrites the two rules already sitting in the table, so this removes them once.
--
-- What they were: "Spotify" -> Subscriptions [ai] against the owner's "SPOTIFY 877-778-1161, NY"
-- and "Spotify USA" -> Streaming, and "Backblaze" -> Subscriptions [ai] against the owner's
-- "BACKBLAZE INC" -> Software. Under the old `ORDER BY created_at DESC` (236 live rules, 41
-- distinct timestamps, ties broken by the sorter) the model's rule won, and one press of
-- "Re-check all transactions" relabelled 41 rows. With the ordering fixed but these rules still
-- live, 7 Spotify rows the owner's patterns do not reach still flip; retiring them takes it to 2,
-- and both of those are pre-existing owner-rule effects.
--
-- Retired, not deleted: `merchant_rule_revisions` has to keep explaining what happened, and the
-- partial unique index only frees the pattern once `retired_at` is set. This mirrors the two writes
-- `retireMerchantRule` performs, because migrations here are SQL and cannot call it.
--
-- The predicate is the contention itself rather than two hardcoded ids, so an install that grew a
-- different pair of these gets repaired too. Containment is `instr`, a literal substring test, and
-- not LIKE: to LIKE, `%` and `_` inside the AI pattern are wildcards, so an AI-authored pattern such
-- as `AMZN_MKTP` would match owner patterns it does not contend with and retire a live owner rule.
-- No AI pattern here contains either character, so this changes nothing on this database; it stops
-- the migration over-reaching on an install whose AI rules do.
--
-- It is deliberately narrower than the runtime guard, which can run the fuzzy matcher and SQL
-- cannot. What it therefore does NOT retire: an AI pattern that only reaches an owner rule through
-- 0.86 similarity rather than containment, an owner pattern contained in the AI pattern instead of
-- the other way round, and two patterns that never touch each other but both match one transaction.
-- Those stay live until `checkRuleDoesNotContradictOwnerRule` refuses their next re-proposal, and
-- the rule ordering keeps the owner's rule winning meanwhile.

INSERT INTO merchant_rule_revisions
  (id, rule_id, pattern, from_category_id, to_category_id, source, action_id, operation, created_at)
SELECT
  lower(hex(randomblob(16))),
  ai.id,
  ai.pattern,
  ai.category_id,
  NULL,
  'human',
  NULL,
  'retire',
  strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
FROM merchant_rules ai
WHERE ai.retired_at IS NULL
  AND ai.source = 'ai'
  AND EXISTS (
    SELECT 1 FROM merchant_rules owner
    WHERE owner.retired_at IS NULL
      AND owner.source <> 'ai'
      AND owner.category_id <> ai.category_id
      AND trim(ai.pattern) <> ''
      AND instr(lower(owner.pattern), lower(ai.pattern)) > 0
  );

UPDATE merchant_rules
SET retired_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
    updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
WHERE retired_at IS NULL
  AND source = 'ai'
  AND EXISTS (
    SELECT 1 FROM merchant_rules owner
    WHERE owner.retired_at IS NULL
      AND owner.source <> 'ai'
      AND owner.category_id <> merchant_rules.category_id
      AND trim(merchant_rules.pattern) <> ''
      AND instr(lower(owner.pattern), lower(merchant_rules.pattern)) > 0
  );
