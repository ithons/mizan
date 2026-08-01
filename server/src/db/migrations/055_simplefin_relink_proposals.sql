-- simplefin_relink_proposals: the pending question "did the provider re-mint its account ids?",
-- and the audit trail of what was adopted onto which existing row.
--
-- WHAT HAPPENED. On 2026-08-01 the owner's SimpleFIN Bridge subscription lapsed (HTTP 402). They
-- renewed it and re-added every institution at the provider, which minted a new ACT- id for every
-- account. `upsertSimplefinAccount` looks a row up by `simplefin_account_id` and by nothing else, so
-- all nine lookups missed, the INSERT branch ran nine times, and the ledger went to eighteen
-- accounts. The nine originals were then absent from a response carrying no provider errors, so
-- `zeroAccountsMissingFromResponse` read them as closed and zeroed all nine.
--
-- The size of the misstatement is deliberately not restated here. The figure this comment first
-- carried was a raw `SUM(current_balance)` over the SimpleFIN rows, which adds assets to liabilities
-- and is not a net worth; no query reproduces it and it should not be cited. What IS measurable, and
-- what this table exists to prevent, is the shape: nine accounts became eighteen, and the nine that
-- carried the history read zero.
--
-- The nine new rows were new rows, so they inherited nothing. Measured on a copy of the database
-- taken at the time:
--   name_source = 'manual'    9 of 9   every account name was curated and every one was re-guessed
--   type_source = 'manual'    4 of 9   the other FIVE were re-guessed by guessAccountTypeAndLiability,
--                                      which typed two credit cards as checking, so two card
--                                      balances landed as negative ASSETS instead of debts
--   backfill_floor_date       9 of 9   the line below which imported manual history owns the ledger
--   transactions stranded     2,569    on the nine zeroed rows, counted that day. The same query
--                                      now returns 2,581, because the ledger has moved since:
--                                        SELECT COUNT(*) FROM transactions t JOIN accounts a
--                                          ON a.id = t.account_id
--                                         WHERE a.simplefin_account_id IS NOT NULL;
--                                      It is kept as the reading it was, dated, not as a claim
--                                      about today.
--
-- WHY A TABLE AND NOT A FLAG. Two reasons, and both are about the owner being able to act.
--
-- The question outlives the sync that asked it. A sync runs hourly and unattended; the owner
-- answers whenever they next open the app. A pending proposal has to survive with the evidence
-- attached, because the provider response that raised it is gone by then, and asking the owner to
-- confirm a pairing without showing them what was compared is asking them to confirm a guess.
-- `provider_snapshot` is therefore the response as it was read, stored, not re-fetched.
--
-- And the answer has to outlive the question. Adoption writes a new provider id onto an existing
-- account row, which is a change with no other record: the row's own columns look exactly as they
-- did before, which is the entire point of adopting rather than creating. `applied_pairs` is the
-- only place that says which existing account took which new provider id, and when.
--
-- WHY DISMISSAL RECORDS IDS. Dismissing means "these really are new accounts, proceed". If that
-- decision were not recorded, the very next sync would see the same unmatched provider ids, raise
-- the same proposal, and block again: a standing finding the owner has already acted on and cannot
-- get rid of. `acknowledged_provider_ids` is what detection reads to stay silent afterwards.
--
-- Money in this table is INTEGER CENTS, like every other money column in this schema. It travels
-- inside the JSON snapshots rather than in columns of its own, because what is stored is a reading
-- of a whole account list at one instant, not a figure this app computes.
--
-- No foreign keys to `accounts`, deliberately, and for the reason 047 and 050 give: this is
-- evidence about accounts and it has to survive them. A stored account id inside `pairs` names the
-- row the pairing was proposed against at detection time; if that row is later merged or deleted,
-- the record of what was proposed is still true and must not cascade away. Adoption re-reads and
-- re-validates every id at the moment it writes, so a stale id inside the JSON can never reach a
-- write path.

CREATE TABLE simplefin_relink_proposals (
  id TEXT PRIMARY KEY,
  detected_at TEXT NOT NULL,

  -- Only the two outcomes that are worth reporting are ever persisted. 'none' is the silent case
  -- and writing a row for it would be a standing finding on an ordinary healthy sync.
  --   relink   stored SimpleFIN accounts exist, the response carries accounts, and NOT ONE provider
  --            id matches a stored one.
  --   partial  some provider ids match and some do not, AND stored accounts went unmatched. Neither
  --            a clean rotation nor ordinary new accounts, so it is reported and never guessed at.
  outcome TEXT NOT NULL CHECK(outcome IN ('relink', 'partial')),

  status TEXT NOT NULL CHECK(status IN ('pending', 'applied', 'dismissed')),

  -- JSON array of the provider accounts exactly as the response carried them, one entry per
  -- account: {id, name, institutionName, currency, balanceCents}. balanceCents is null when the
  -- provider sent a balance that did not parse as a number; a proposal is still worth raising
  -- without it, because the balance is only ever a tiebreak.
  provider_snapshot TEXT NOT NULL,

  -- JSON array of the stored SimpleFIN accounts as they were when the proposal was raised:
  -- {id, simplefinAccountId, accountName, institutionName, currency, type, balanceCents,
  -- isLiability}. Kept alongside the provider side so a reader months later can see both halves of
  -- the comparison rather than one half and today's database.
  stored_snapshot TEXT NOT NULL,

  -- JSON array of proposed pairs: {storedAccountId, providerAccountId, strength, evidence[],
  -- reason}. `reason` is the sentence the owner confirms against, and it names what was compared.
  -- A proposal is never applied by writing it; adoption is a separate, explicit call.
  pairs TEXT NOT NULL,

  -- JSON arrays of what did not pair, on BOTH sides, each entry carrying why. An account the owner
  -- genuinely closed at the bank has no partner and never will, and that has to be sayable without
  -- blocking the pairs that are real. An ambiguous candidate set is recorded as ambiguous rather
  -- than resolved by picking one.
  unpaired_stored TEXT NOT NULL,
  unpaired_provider TEXT NOT NULL,

  resolved_at TEXT,

  -- JSON array, NULL until applied: {storedAccountId, providerAccountId, previousSimplefinAccountId,
  -- outcome} for every adoption this proposal actually performed. The only record that a given
  -- existing account took a given new provider id.
  applied_pairs TEXT,

  -- JSON array of provider account ids this proposal's resolution settles. Detection treats these
  -- as answered and stays silent about them on later syncs. Written on dismissal (the owner said
  -- these are new accounts) and on application (the adopted ids are now stored ids anyway, and the
  -- ids deliberately left unpaired have been ruled on).
  acknowledged_provider_ids TEXT,

  dismissed_reason TEXT,

  -- 'pending' is exactly the unresolved state. A resolved row without a timestamp, or a pending row
  -- with one, would make "is the sync blocked?" a question with two answers.
  CHECK ((status = 'pending') = (resolved_at IS NULL)),
  CHECK (status <> 'applied' OR applied_pairs IS NOT NULL),
  CHECK (status <> 'pending' OR (applied_pairs IS NULL AND acknowledged_provider_ids IS NULL))
);

-- At most one unresolved proposal. Two would mean two answers to "what is the sync waiting on",
-- and the sync guard would have to pick one, which is a silent decision of exactly the kind that
-- caused this table to exist.
CREATE UNIQUE INDEX idx_simplefin_relink_pending
  ON simplefin_relink_proposals(status) WHERE status = 'pending';

CREATE INDEX idx_simplefin_relink_detected_at
  ON simplefin_relink_proposals(detected_at DESC);
