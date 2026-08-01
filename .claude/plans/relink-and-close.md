# SimpleFIN re-link, and closing what the audit left open

Written 2026-08-01, after the SimpleFIN subscription lapsed (HTTP 402), was renewed, and every
institution was re-added at the provider. Part I is `rebuild.md`, Part II `rebuild-part-2.md`,
Part III `rebuild-part-3.md`. This file is the ordered work that remains.

Every figure below was measured against a `.backup` copy of `.mizan/mizan.db` taken 2026-08-01, never
against the live file. The command is beside each one.

---

## Phase 0: the re-link, and it blocks everything else  [LANDED 2026-08-01]

### What the database actually says right now

Nothing is corrupted and nothing is missing. That is worth stating first, because the failure mode
here is loud and this is not it.

```
sqlite3 copy "SELECT connection_type, COUNT(*), SUM(is_hidden), SUM(current_balance) FROM accounts GROUP BY 1"
  coinbase   1  0     39073
  manual     4  0     38000
  simplefin  9  0   1197941
```

All 9 SimpleFIN accounts still carry their balances, and every `updated_at` is still
`2026-07-30T21:50`, so the empty response on 2026-08-01 did not touch them.
**`zeroAccountsMissingFromResponse` did its job**: it refuses to read absence as "closed" unless the
response is complete, and an empty 200 is not complete. Without that guard the 16:14 sync would have
zeroed all nine accounts and written the result into net-worth history as a MEASURED fact.

What the database also says is that the app has **not** been given the new subscription:

```
sqlite3 copy "SELECT provider, status, accounts_seen, error_message, completed_at
              FROM sync_run_items WHERE provider='simplefin' ORDER BY rowid DESC LIMIT 2"
  simplefin  succeeded  0  (null)                              2026-08-01T16:14:05.336Z
  simplefin  failed     0  Request failed with status code 402  2026-08-01T16:04:22.940Z

stat -f '%Sm' .mizan/credentials.json   ->  2026-06-30T19:15:04
```

The 402 is gone, so the subscription is live again. But `credentials.json` has not been written since
30 June, so the stored access URL is the one from before. A sync that succeeds and sees zero accounts
is what an old access URL looks like after the accounts behind it were re-added elsewhere.

### The hazard, which is real and one paste away

`upsertSimplefinAccount` matches on the provider's id and nothing else
(`server/src/services/simplefin.ts`):

```sql
SELECT id, account_name, current_balance, is_liability, currency, backfill_floor_date, name_source
FROM accounts WHERE simplefin_account_id = ?
```

Re-adding an institution at SimpleFIN Bridge normally mints a new `ACT-` id. If it did, all nine
lookups miss, the `else` branch runs nine times, and the ledger ends up with **18 accounts**: nine
new ones carrying the balances, nine old ones still carrying the same money and never updated again.
Net worth double counts to roughly $23,959 against a true $11,979.

What the nine new rows would NOT inherit, measured on the copy:

| | value |
|---|---|
| `name_source = 'manual'` | **9 of 9**. Every account name is curated. |
| `type_source = 'manual'` | **4 of 9** (BofA Cash Rewards, Discover, Fidelity Individual, Wealthfront Cash). The other five would be re-guessed by `guessAccountTypeAndLiability`. |
| `backfill_floor_date` | **9 of 9**, running 2026-04-08 to 2026-06-22. |
| transactions left behind on the old row | **2,569** |

`backfill_floor_date` is the one that does lasting damage. It is the line below which manually
imported history owns the ledger, and the only thing stopping a deep resync re-serving rows that are
already there. A new account row has no floor, so the provider is free to serve underneath it and
duplicate the entire imported backfill.

### The fix, in the write path

`mergeAccounts` already does the right thing in the right direction: it keeps the **target's** name,
type, `type_source`, `name_source` and `backfill_floor_date`, and takes the **source's**
`simplefin_account_id`, `connection_id` and balance, then reassigns transactions, holdings and
`holdings_history`. So merging each new row into its old counterpart is correct. What is missing is
anything that stops the duplicates being created in the first place, and any help identifying which
new row pairs with which old one.

Build a re-link step, and gate the first sync after a reconnect behind it:

1. **Detect the condition rather than assume it.** After a reconnect, before writing any balance,
   compare the provider's account ids against the stored ones. When the response carries accounts and
   **none** of their ids match a stored `simplefin_account_id` while stored SimpleFIN accounts exist,
   that is a re-link, not nine new accounts. A partial overlap is neither and must be reported rather
   than guessed at.
2. **Propose a pairing, never apply one silently.** Match on the evidence the provider actually gives:
   institution name, account name, currency, and the balance as a tiebreak. Present it as a
   confirmable mapping in Settings, with the unmatched rows on both sides shown explicitly. An
   account the owner closed at the bank genuinely will not pair, and that has to be sayable.
3. **Adopt, do not create.** On confirmation, write the new `simplefin_account_id` onto the existing
   row inside one transaction. Nothing else about the row moves.
4. **Refuse to sync balances until the mapping is settled.** A sync that runs mid-decision is what
   creates the duplicates this exists to prevent.

Proves it worked: a test that drives a full sync with every provider id rotated, and asserts the
account count is unchanged, all nine `backfill_floor_date` values survive, all nine curated names
survive, and the 2,569 transactions still hang off the same rows.

### Until that ships

Do not paste the new setup token into Settings. If it is already pasted and duplicates exist, the
recovery is nine merges in Accounts with the **old** account as the target and the new one as the
source, in that direction; getting it backwards keeps the empty row and discards the curation.

---

### Phase 0, landed 2026-08-01

Shipped as migration 055 plus `services/simplefinRelink.ts`, the sync gate in `applySimplefinResponse`,
three routes, and the Settings surface. 1,641 tests, three typechecks, vite build, all green.

Verified by replaying the incident against a copy of the live ledger: all nine `ACT-` ids rotated,
driven through the real sync path. The guard blocked and the ledger came out byte identical, SHA-256
over `accounts`, `transactions`, `holdings` and `net_worth_snapshots` matching before and after.
14 accounts stayed 14, nothing was zeroed, all nine pairs mapped to the right account. After adoption:
still 14 accounts rather than 23, every curated name, type, `type_source`, `name_source` and
`backfill_floor_date` unmoved, only `simplefin_account_id` and `updated_at` changed. Eighteen
adversarial scenarios held, including the two same-institution pairs this ledger actually contains
(two Chase cards, two Fidelity accounts): where names collide and balances cannot separate them it
pairs NEITHER and says why. Silence was proved by mutation rather than by reading test names: forcing
the detector to always fire failed 16 tests including every healthy case.

Three things had to be fixed after the build, and the first is the important one:

- **The server would not boot.** Migration 055 threw `left 228 foreign-key violation(s)`. The manual
  incident repair earlier that day deleted 118 transactions through the `sqlite3` CLI, which defaults
  to `foreign_keys=OFF`, so the cascade never fired and 228 `transaction_category_revisions` rows were
  orphaned. `runMigrationsOn` runs a database-WIDE `foreign_key_check`, so every future migration
  would have failed too. This is rule 1 biting inside the same day: a defect fixed in the database
  decayed, and it decayed into a boot failure.
- **Three figures did not reproduce**, all three supplied in the brief rather than measured. The worst
  described the misstatement as "$2,470.92 against a true $11,979.41", where $11,979.41 was a raw
  `SUM(current_balance)` over the SimpleFIN rows, which adds assets to liabilities and is not a net
  worth. Removed rather than restated, with a note saying it should not be cited.
- **The panel was undiscoverable.** A condition that blocks every sync sat inside a collapsed Settings
  row that still read "Connected".

### Carried forward from Phase 0

**`strength: 'exact'` overstates a balance-decided pair.** `simplefinRelink.ts` computes `strength`
from match rank alone, so a pair that only the balance tiebreak could decide is still labelled
`exact`. The `reason` sentence beside it is honest ("More than one provider account matched that
well, and this is the only one whose balance matches"), so an owner reading the evidence is not
misled, but the one-word label is, and the label is what a hurried owner reads. Correctness is
unaffected: both the realistic ambiguous case (balances moved) and the worst case (balances
identical) correctly refuse to pair. Fix by deriving `strength` from which evidence actually decided
the pair rather than from its rank, and prove it with a test that a balance-decided pair is not
labelled `exact`. Small, and it belongs with Phase 3.

## Phase 1: the mis-signed brokerage transfers  [LANDED 2026-08-01]

The oldest unclosed defect in the repo. **All 14** Fidelity "Electronic Funds Transfer Received" rows
carry the provider's wrong sign, $1,100.00 of ledger error. It was deliberately never corrected,
for a good structural reason: `upsertSimplefinTransaction` compares and overwrites `amount`, so any
repair reverts within the hour. That is the self-reverting repair trap.

Migration 048 built `amount_source` and `transaction_field_revisions` precisely so a disagreement
between the provider and the owner could be **recorded** rather than silently resolved either way,
and **nothing has ever used it**. The mechanism exists and is idle.

Close it by making the recorded correction real:

- An owner correction writes a `transaction_field_revisions` row and sets `amount_source = 'human'`.
- `upsertSimplefinTransaction` stops overwriting `amount` when `amount_source = 'human'`, and instead
  records that the provider still disagrees. The disagreement is surfaced, not resolved.
- Every reader that sums money uses the effective amount, so the correction is visible everywhere at
  once rather than on one screen.

Proves it worked: a sync run over a corrected row leaves the amount alone and appends a disagreement
record; a second sync appends nothing new, because a standing disagreement is not a new event. And
the healthy case: a row nobody corrected syncs exactly as it does today and writes no revision.

Do NOT bulk-correct the 14 rows in a migration. That is the repair-the-database failure this codebase
is built against. Ship the mechanism, then correct them through it.

### Phase 1, landed 2026-08-01

Shipped with no migration: 048 already had everything. `upsertSimplefinTransaction` keeps an
`amount_source = 'human'` amount and files the provider's competing figure as `provider_rejected`;
`releaseAmountToProvider` + `POST /api/transactions/:id/amount/release` is the exit; `provider_amount`
rides on every transaction row so both figures are readable; the Ledger's entry sheet edits the
amount, flips its sign, states what the institution still says, and hands the field back. 1,675 tests
pass, three typechecks and the vite build are clean. The one failure in the suite is
`tests/plan.test.ts` over `ProgressBar.tsx`, which is the Phase 3 bar-fill work and not this.

Silence was proved by mutation rather than by reading test names: forcing `ownerOwnsAmount` to be
unconditionally true fails six tests, every one of them a healthy case (an untouched row resyncing, a
pending row settling, a category-only edit, a pre-048 NULL source, and the release path).

**Two figures in the brief above did not reproduce, and both are corrected in place.** It is 14 of
14, not 12 of 14, and $1,100.00, not $1,800. Re-derived 2026-08-01 on a `.backup` copy at migration
055, query beside the number in `tests/amountCorrection.test.ts`. The "12" appears to have been read
off `SELECT COALESCE(amount_source,'NULL'), COUNT(*) FROM transactions GROUP BY 1` (provider 12, NULL
2588), which counts rows written since 048 and has nothing to do with Fidelity.

The brief also said `amount_source = 'owner'`. Migration 048's CHECK allows only NULL, 'provider',
'human' and 'ai', so the value is `'human'` and 'owner' would have been rejected at write time.

**The 14 rows are NOT corrected.** The mechanism is the deliverable; applying it is fourteen clicks
in the Ledger, one entry at a time, which is what "ship the mechanism, then correct them through it"
asks for. No script and no migration touches them.

Two things worth carrying:

- **Migration 048's header said the opposite and now says so.** Its "WHAT THIS IS NOT. It is not a
  pin." paragraph is the design of the code, not of the schema, and half of it stopped being true.
  A dated amendment sits above it pointing at the argument in `simplefin.ts`; no SQL moved.
- **`amount_source` NULL is 2,588 of 2,600 rows.** Every one of them is unpinned and stays that way:
  NULL means the author was never recorded, and reading it as a claim would freeze most of the ledger
  against its own provider. There is a test for exactly that.

---

## Phase 2: freeze investment history at write time  [LANDED 2026-08-01]

`/api/reports/investments` resolves the portfolio account set from **today's** `accounts` table and
applies it to every past snapshot breakdown. The screen stays internally consistent while being
historically false. Reproduced during Phase 9; the route comment states the limitation rather than
claiming the set is right.

The honest fix is to stop deriving membership after the fact:

- `takeSnapshot` records the portfolio subtotal, or the covered account set, at write time.
- The route reads what the snapshot recorded instead of intersecting with today's accounts.
- A migration plus a backfill for existing rows, which must mark reconstructed rows as reconstructed
  rather than presenting them as measured.

This is the largest of the remaining items and the only one needing a migration. It is also the one
that silently rewrites history, so it outranks the two cosmetic ones below.

### The figure above was wrong about its own trigger

"Retyping one brokerage to `savings` moves the same two snapshots from $2,445.89 to $505.92" is two
correct numbers attached to an edit that does not produce them. Both reproduce on a `.backup` copy of
`.mizan/mizan.db` taken 2026-08-01 at migration 055: the 2026-07-30 point reads $2,445.89 over the
portfolio and $505.92 without Fidelity Individual. But the portfolio predicate has two arms, and the
second re-admits **any account holding a position**:

```
a.type IN ('brokerage','ira_traditional','ira_roth','crypto_wallet')
  OR EXISTS (SELECT 1 FROM holdings h2 WHERE h2.account_id = a.id)
```

All three portfolio accounts on this ledger hold positions, so retyping Fidelity Individual to
`savings` leaves it in the set and moves nothing. Re-measured, the edits that do move history:

```
retype Wealthfront Cash (savings, $1,001.70) to `brokerage`  ->  2026-07-30 goes $2,445.89 -> $3,447.59
hide Coinbase (routes/coinbase.ts disconnect, is_hidden = 1) ->  2026-07-30 goes $2,445.89 -> $2,045.04
delete a portfolio account                                   ->  same shape, permanently
```

The defect is the same size, and the trigger is an edit that changes the **set**, not the type.

### Phase 2, landed 2026-08-01

Migration 056 adds `net_worth_snapshots.portfolio_accounts` (JSON array of ids) and
`portfolio_accounts_source` (`recorded` / `reconstructed`).

**The set, not a subtotal.** A subtotal is cheaper and answers one question; the endpoint asks three
(the value, how many accounts it covers, and whether two consecutive points sum the same set), and
only the set answers all three. It also keeps the money in one place: the value stays a sum over
`breakdown`, and the new column carries only the classification. That is the same division
`deriveAssetBuckets` argued from the other side, and the counter-example is migration 002's
`investment_assets`, which froze an interpretation as a number and could never be recomputed.

`takeSnapshot` and `backfillSnapshots` both write the set alongside the balances, from
`readPortfolioAccounts` in `netWorthHistory.ts`, which is now the one definition the writer, the
reader and migration 056 all follow (056 pins it in SQL on purpose, so a clone reproduces).
`backfillSnapshots` narrows it to the accounts each month could account for, so a month below an
account's own floor does not name it. For a reconstructed row, `recorded` means recorded at
DERIVATION time (`created_at`), not observed on the row's `date`: both halves of such a row come from
the same instant and are rewritten together, and `is_estimated` stays on it to say so.

**The backfill says what it is.** All 33 existing rows come out `reconstructed`, because the set they
were summed over was never stored and today's accounts table is the only evidence left. The 16
estimated ones become `recorded` on the next reconstruction run, which rewrites them anyway; the 17
measured ones stay `reconstructed` forever, because nothing can go back and observe what the
portfolio was on a day that has passed. A row whose breakdown is not readable JSON is left NULL on
both columns rather than given an invented set, and the endpoint already drops that point.

Verified against a copy of the live ledger: 33 rows, 0 NULL sets, 2026-07-30 still $2,445.89 to the
cent, and after retyping Wealthfront Cash to `brokerage` it stays $2,445.89 where the old read-time
derivation gives $3,447.59.

Ten tests in `tests/investmentHistoryMembership.test.ts`, and silence proved by mutation rather than
by reading test names: forcing the route back onto today's set fails six of them, including all three
the phase required. `remapAccountIdInSnapshots` remaps the frozen set alongside the breakdown keys it
renames, or a merge would have taken the merged account's balance out of every historical point.

Two things deliberately not done, so they are not read as oversights:

- **The chart is not marked.** Seventeen measured rows will carry a reconstructed membership for as
  long as they exist, so painting them would be a permanent mark on the one thing the owner cannot
  act on. The marking is per-point and self-clearing instead: the delta under the headline says so
  when its own baseline is such a point, and goes quiet once the baseline is a snapshot taken after
  056.
- **Two consecutive points with the same-size, different-member set still join.** `TrendChart`
  compares counts. The ids are on the row now so it is answerable, but answering it means changing
  what `TrendChart` consumes, and no claim is made that it is handled.

---

## Phase 3: three small closures

**`deriveAssetBuckets` has no production caller.** `reports.ts` was the last one. It survives only
because `tests/creditPosition.test.ts` is the sole remaining assertion that a card in credit carries
as a negative liability through that path. Either re-home that assertion onto a live path and delete
the function, or give the function a caller. Leaving a shared definition that backs no surface is how
a future change cites it as authoritative.

**Refused advisor draft rows accumulate unbounded.** When the model re-proposes a category the owner
declined, the write guard correctly refuses, but a hidden `advisor_drafts` row is written on every
pass. Nothing bounds it. `ai_feedback` had zero rows at the time the decline path shipped, so there
was no size to measure and no cap was invented. Measure it now, and if it grows, either dedupe on the
proposal identity or retire refused rows on a schedule.

**`strength: 'exact'` overstates a balance-decided pair.** Carried forward from Phase 0, described
above. Derive `strength` from the evidence that decided the pair, not from its rank.

**Bar fills are structurally weak.** `track` buys 1.19 to 1.55 against every ground a bar renders on
and clears `line` on paper by 0.02, so every `ProgressBar` and allocation bar is close to invisible
against its own track. This is a token problem, not prose. It should be solved with whatever palette
direction lands rather than patched twice.

---

## Phase 4: `ai_observations` and `ai_briefs` are dropped  [DECIDED 2026-08-01]

**Both are dropped. Neither will be built.** The line is struck from `rebuild.md` Phase 6. This is a
decision, not a deferral: anyone who wants either table back is proposing new work and owes the
argument below a rebuttal.

Every figure here was measured against a `.backup` copy of `.mizan/mizan.db` taken 2026-08-01 at
migration 055, with the command beside it. The reason recorded in `rebuild-part-3.md` Decision 6 is
**partly wrong** and is corrected below; see the last section.

### What the plan said each one was for: nothing

Establish this first, because the phase was written assuming a purpose had been recorded somewhere
and only the decision was missing. It had not. Before this edit,
`grep -rn "ai_observations\|ai_briefs" . --exclude-dir=node_modules --exclude-dir=.git` returned four
locations: two that specify them as work, one that already argues for dropping them
(`rebuild-part-3.md` Decision 6, corrected at the end of this phase), and this phase's own heading.
Here are both specifying lines in full, because their full text is this short:

```
rebuild.md:184         - [ ] **Migration: `ai_runs`, `ai_incidents`, `ai_observations`, `ai_briefs`**

rebuild-part-2.md:338  - [ ] **Migrations `ai_runs`, `ai_incidents`, `ai_observations`, `ai_briefs`.**
                             Moved to 6.3: they only earn their place alongside the job framework and
                             the guard harness that write them.
```

(`rebuild.md:184` is quoted as it stood on 2026-08-01 before this decision was written into it. That
line now records the drop; `rebuild-part-2.md:338` still reads as open work and was outside this
pass's file set.)

That is the complete design record. No column list, no writer, no reader, no surface, not one
sentence of prose. Their two line-mates each arrived with a stated argument when they landed (the
header comments on migrations 050 and 051 run to 42 and 35 lines and each names the hole it fills
with a measured query;
`awk '/^--/{n++} !/^--/ && NF {exit} END{print n}' server/src/db/migrations/05{0,1}_*.sql`); these two
never had a design to build. A name inside a list is not a requirement.
What is written down is consistent with a guess at a shape that was never returned to, and there is
no surviving evidence of anything more.

```
grep -rn "ai_observations\|ai_briefs" server client shared tests | wc -l        ->  0
sqlite3 copy "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'ai_%'"
  ->  ai_feedback, ai_incidents, ai_memory, ai_runs
```

### What `ai_memory` actually stores, and what reads it

`ai_memory` (migration 049) holds **dispositions**, not observations: statements about how the owner
runs their money that stay true while every number around them changes, of four kinds (`preference`,
`constraint`, `intent`, `interpretation`), each carrying `evidence` under a NOT NULL length CHECK, and
revised by `superseded_by` rather than overwritten.

- Read by two things. `listMemories` serves `GET /api/ai/memory`, which Settings renders with each
  statement's evidence and the statements it replaced. `pushMemory` in `services/aiContext.ts:778`
  renders the live rows into **every** prompt, each tagged with the date it was recorded and its
  observation count, under a heading telling the model to read each line as of that date.
- Written by `createMemory`, `supersedeMemory` and `deleteMemory`. Every production caller is a route
  in `routes/ai.ts`, and all three pass the literal `'owner'`.

So the correction that matters to this decision: **`ai_memory` is an owner-authored store in this
build.** `createMemory` takes a `source` of `'owner' | 'ai'` and nothing outside tests ever passes
`'ai'`; migration 049 says so in its own comment, and gives the reason (whether the model may write
there depends on a guard harness that did not exist when it was written). It also holds nothing yet:

```
sqlite3 copy "SELECT COUNT(*) FROM ai_memory"   ->  0
```

An empty owner-authored store is not "the thing that absorbed an observation log". Something else is,
and it is worth naming precisely, because the precision is the whole argument.

### What the digest computes, when, and from what

`GET /api/ai/digest?since=&limit=` (`services/aiDigest.ts`, 640 lines) is computed **on demand, per
request**, and stored nowhere.

- **From:** `advisor_actions`, `transaction_category_revisions`, `merchant_rules`,
  `merchant_rule_revisions`, `ai_feedback`, and `schema_migrations` (to learn when migration 042
  created the revision log, so an action that predates it is reported `unrecorded` rather than as
  having changed nothing). It reads the **revision logs**, never `advisor_actions.payload`, so it
  reports the write rather than the proposal.
- **When:** whenever the Cmd+K digest panel opens or its window changes. The window is 7 days,
  30 days (the default) or everything, and `since` is pinned once per window so the panel, the button
  copy and the revert all name the same instant.
- **What:** a diff, row by row, with each row's status as `standing`, `superseded` or `reverted`,
  whether a revert-since would restore it, and if not, which of `already_reverted`, `changed_since`
  or `replaced_by_same_action` is why. It does not read `ai_runs`.

### The one capability nothing provides, stated concretely

Two candidate capabilities, tested rather than asserted.

**"The model cannot tell whether it already said this."** False. It can, and the mechanism is the
write record itself, not a parallel log.

- Per row: `refilableTransactions` in `services/aiWorker.ts` excludes any transaction carrying a
  `transaction_category_revisions` row with `to_source = 'ai'`. That is deliberately stronger than
  reading `category_source`, because two ordinary owner actions ("Re-check all transactions", and
  undo) put the model's own answer back into the pool wearing a machine's label, and under
  `category_source` alone the next pass would refile it within the hour.
- Per proposal: `retirableOwnRules` excludes any rule the owner declined to retire, matched on
  `rule_id` read out of the dismissed draft's payload, through `ai_feedback` joined to
  `advisor_drafts`. `refilableTransactions` names, per row, the categories already declined **for
  that row**, rather than dropping the row, so declining "file this as Food" does not also withdraw
  "file this as Groceries".

**"Nothing keeps what the model noticed but could not act on."** True, and this is the real gap. The
worker's output contract (`AiWorkerDraftSchema`, `shared/schemas/index.ts:247`) accepts drafts only.
It does carry free text, in `summary`, but every field of it hangs off a `payload` that must parse as
an `AdvisorDraftPayloadSchema`, under a refinement that `kind` must equal `payload.kind`; and a kind
outside the job's declared `writes` is counted into `ai_runs.refused_out_of_scope` and dropped. There
is no shape for a sentence that proposes nothing. So an observation of the form "the Fidelity transfer
rows have been arriving with the provider's sign wrong since April", cannot be emitted at all, and
"when did it first think the brokerage was being drained" is unanswerable.

### Why that gap is a reason to drop, not to build

**The missing part is upstream of any table.** `ai_observations` does not create that capability.
Creating it means adding a free-text field to the worker's output contract, inviting it in the prompt,
and then storing an unvalidated model sentence durably and showing it to the owner. That is a claim
the code did not check, on a standing panel, with nothing to act on: rule 2 and rule 3 in one feature.
The table is the easy fifth of the work and the only fifth that was ever written down. If that
question is ever asked in earnest, the answer is a provenance column and a guarded write route on
`ai_memory`, which is one store gaining an author, not a second store.

**A stored brief can disagree with the ledger; the digest cannot.** Undo an action after a brief is
written and the brief still says twelve rows were refiled. The digest recomputes from the revision
logs and reports those rows as `reverted`, and reports which of them a further revert would and would
not restore. A periodic written summary is a cached derivation of a log that is already durable, and
the cache is exactly what goes stale. This is the same failure as the four hand-maintained copies of
the autonomy set that `DRAFT_KIND_AUTONOMY` exists to prevent, in data rather than in code.

**Rule 3, on accumulation.** A briefs table is a standing artifact whose rows accrue and which the
owner cannot act on: nothing can be done about a brief from three weeks ago. This plan already
carries one unbounded-accumulation defect of that shape, still open in Phase 3, and it is measurably
growing:

```
sqlite3 copy "SELECT status, COUNT(*) FROM advisor_drafts GROUP BY 1"
  ->  confirmed 265, dismissed 5, open 8   (278 total, against 251 on 2026-07-31)
sqlite3 copy "SELECT COUNT(*) FROM advisor_actions"                     ->  172
sqlite3 copy "SELECT COUNT(*) FROM ai_runs"                             ->  12
sqlite3 copy "SELECT COUNT(*) FROM ai_incidents"                        ->  0
sqlite3 copy "SELECT COUNT(*) FROM ai_feedback"                          ->  3
```

Adding a second accumulating store before the first one is bounded is not a trade worth making. (The
27 drafts added on 2026-08-01 are all `confirmed`; no claim is made here that the day's growth was
refusals, which is Phase 3's question and not this one.)

### What the drop costs, so it is not rediscovered as a surprise

There is no durable record of what the model *noticed* on a given run. `advisor_actions` records what
it did, `ai_runs` records that a pass happened and what it proposed, refused and cost, `ai_incidents`
records what a guard caught, `ai_feedback` records it being wrong. None of them records a thought that
produced no proposal. That is accepted.

One smaller thing, noted because it is adjacent and is genuinely unfinished rather than decided:
`ai_runs` is write-mostly. It is read by exactly one query, `MAX(started_at)` in `aiWorker.ts:172`,
used as the watermark for how far back a pass looks. No screen renders it and the digest does not read
it. That is a surfacing question about a table that exists, which is a different and much smaller
thing than the two that do not, and it is not scheduled here.

### Correction to `rebuild-part-3.md` Decision 6

That file already records this drop, and its conclusion is right, but two of its sentences are
inference stated as fact and should be read with this phase beside them.

1. "`ai_observations` was a store for standing notes about the ledger; `ai_briefs` was a store for
   periodic written summaries." Nothing establishes that. As shown above, the plan text never said
   what either was for, so this is a reconstruction of intent from two table names.
2. "`ai_memory` exists and does that." Not as written. `ai_memory` holds owner-authored dispositions,
   has no model write route in this build, and holds 0 rows. What actually carries the
   already-said-this job is `transaction_category_revisions` with `to_source = 'ai'`, plus
   `ai_feedback` joined to `advisor_drafts`.

The verified part of Decision 6 stands: zero references in `server/`, `client/`, `shared/` and
`tests/`, re-derived 2026-08-01 with the grep above, and the stated cost is accurate.

---

## Order, and why

0. **Re-link.** It blocks the ledger being correct at all, and every day it waits is a day of stale
   balances. Nothing else matters while net worth can double on one paste.
1. **Mis-signed transfers.** $1,800 of wrong money on screen, and the mechanism to fix it properly has
   been sitting unused since migration 048.
2. **Investment history.** Silently false history is worse than a visibly missing feature.
3. **The three small closures.** Real, bounded, none of them urgent.
4. ~~**The AI store decision.**~~ Done 2026-08-01. Both tables dropped; see Phase 4. The line is
   struck from `rebuild.md` Phase 6, so the only remaining copy of it is `rebuild-part-2.md:338`,
   which was out of scope for that pass and should be struck the next time that file is touched.

Out of scope, deliberately: `CLAUDE.md` stays gitignored. The owner's position is that it should
never be committed, which settles the question Part III left open.
