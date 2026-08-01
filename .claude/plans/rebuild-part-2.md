# mizān rebuild — part II

Written 2026-07-30, after Phases 0–5 (partial) and 7 (partial) landed across 14 commits.
Part I is `rebuild.md`; it stays the record of what was found and what shipped. This file is the
plan for everything still open, in the order it should be done.

Basis: a 10-agent diagnostic pass (5 independent traces, each adversarially refuted by a second
agent that had to reproduce the figures itself before accepting them). Every number below was
computed by running the real services against a copy of the live `.mizan/mizan.db`.

The governing rule from Part I is unchanged and still the thing this plan is organised around:

> A defect is not fixed by repairing the database. It is fixed by putting the invariant in the
> write path, with a regression test. Migrations 033/039/040 each repaired data and left the
> service alone, and each decayed. Migration 020 got a guard and it held.

---

## What the diagnostic pass found

Three defects were carried into this pass as "the audit missed these". All three are still live.
Two of them turned out to be larger than recorded, and one of them turned out to be a different
defect than the one named.

| | recorded as | actually |
|---|---|---|
| Chase Checking short $544.18 | a missing payroll row | a **reconciliation horizon artifact** — no payroll is missing — sitting on top of a **separate, unrecorded defect that understates net worth by $1,705.78 today** |
| Brokerage contribution sign | 4 rows, $400/mo | **12 of 14 rows, $1,800 of ledger error**, and it is the provider's sign, not ours |
| One AI merchant rule contradicting a human rule | Spotify | **two** rules (Spotify **and** Backblaze), and the AI rule **wins** the resolution today |

### 1. A credit card in credit is stored as debt (net worth understated $1,705.78)

Three cards are currently in a credit position — the bank owes the owner money — and all three are
stored as owing the same amount. The residual is exactly `-2 ×` the stored balance in each case:

| account | ledger implies | stored | net worth error |
|---|---|---|---|
| Discover | −$563.26 (they owe you) | +$563.26 (you owe them) | $1,126.52 |
| Chase Freedom Flex | −$283.81 | +$283.81 | $567.62 |
| BofA Cash Rewards | −$5.82 | +$5.82 | $11.64 |

The ledger is right and the balance is wrong, proved independently of the reconciliation check:
Freedom Flex owed $1,235.95 on 06-30, an Amazon refund of $955.19 posted on 07-13 leaving $280.76,
and the autopay on 07-26 is **exactly $280.76**. An autopay that lands exactly on the ledger's
implied balance is not a coincidence. Then a $283.81 statement credit on 07-27 pushes the card into
credit, and the stored balance reads $283.81 owed.

Two independent bugs stack here:

- **The provider's sign is dropped.** `liabilityAdjustedCents` (`simplefin.ts:16-27`) negates
  unconditionally, on the documented assumption "SimpleFIN sends credit balances as negatives". For
  a card in credit the provider sends a negative too, so negation produces debt. The existing guard
  only fires on the opposite case (`isLiability && balanceMagnitude > 0`), so it is silent here.
- **A credit position is unrepresentable in three readers even if the sign were right.**
  `safeToSpend.ts:72`, `aiContext.ts:266` and `netWorthHistory.ts:184` all `Math.abs()` the
  liability balance; `snapshot.ts:415` clamps a negative liability to zero in the estimated series.
  `snapshot.ts:158` does **not** abs. So fixing the sign alone makes the app disagree with itself
  across screens, which is worse than being uniformly wrong. **Order matters: readers first.**

### 2. Brokerage contributions arrive as withdrawals

12 of the 14 `Electronic Funds Transfer Received` rows on Fidelity Individual are stored negative;
the owner's own `data/fidelity/Accounts_History.csv` shows them positive. The 2 that are negative in
the DB are the `... as of <date>` reversal rows, and those are **correct**. $1,800 of ledger error.

The app is not negating. `simplefin.ts:556` is a verbatim passthrough, and the same pass on the same
account preserves positive dividends (+$0.02, +$0.06, +$4.50, +$0.05) and negative reinvestments
(−$0.02, −$0.05) that match the CSV exactly. The provider's sign is wrong.

Blast radius, measured: the estimated net-worth chart is overstated by up to $1,800 and the
2026-01-01 point **flips sign** (+$228.70 drawn where the ledger supports −$1,571.30); the
reconciliation residual reads +$783.89 against a true −$16.11; and the AI is told
`investments: 8 transactions, net -$800.00` where the truth is $0.00 — it thinks the owner is
withdrawing $800/month from the brokerage their own stored profile says they deliberately fund.

Spend and income totals are **not** affected, and not for the reason recorded: `excludedFromTotalsSql`
passes these rows straight through. What neutralises them is the category class (`cat_inv_transfer`
carries `is_investment = 1`). Any query that applies only `excludedFromTotalsSql` would pick them up.

**This one must be detected, not corrected.** `upsertSimplefinTransaction` compares and overwrites
`amount`, so any repair reverts on the next hourly sync — the self-reverting repair trap, in its
purest form. There is also no `amount_source` or amount-revision table, so a corrected amount would
be indistinguishable from a reported one to every future reader.

### 3. An AI merchant rule outranks the owner's own rules

Rule resolution is `Array.prototype.find` over `ORDER BY created_at DESC` (`rules.ts:273`, `:311`).
No specificity, no source precedence, no tiebreak. 236 live rules share only 41 distinct
`created_at` values, so ties are broken by SQLite's temp b-tree, which is not stable.

Today the AI rule `"Spotify" → cat_subscriptions` sorts ahead of both human rules
`"SPOTIFY 877-778-1161, NY"` and `"Spotify USA"` (both → `cat_ent_streaming`) and wins for **all 32**
Spotify rows. Same shape for `"Backblaze" → cat_subscriptions` beating the human
`"BACKBLAZE INC" → cat_sub_software` for all 7 rows. One press of "Re-check all transactions"
relabels 41 rows, 39 of them AI-driven, $325.84 absolute.

The Phase 1 guards do not close this. `checkRuleAgreesWithHistory` is a **creation-time** check
called only from `advisorDrafts.ts:816`; nothing on any apply path consults it, so rules already
stored re-apply unguarded. And it reads only `transactions`, so a human rule for a merchant with no
settled history is invisible to it.

### Corrections to Part I

- The Chase Checking $544.18 is **not** a missing payroll. The ledger holds 20 payroll rows with no
  gap over 8 days, and all four in-horizon payrolls are present. The residual is exactly
  `SUM(amount on first_date) − SUM(amount on last_date)`: `reconciliation.ts:111` uses
  `date > first AND date <= last`, so a row dated on the first snapshot's own date is excluded from
  `explained` forever while its balance effect sits inside the horizon. One payroll of $544.18 is
  dated 2026-06-30, the horizon's first date. Chase Sapphire has the same artifact at −$13.26.
- The crypto cost basis item is mis-framed in Part I. It says the work "needs a stated lot policy".
  The binding constraint is that **the ledger has no units at all**: `transactions` has no `quantity`
  and no `security_id`, so FIFO, LIFO, average and specific-ID are equally un-executable. The units
  exist and are discarded at `coinbase.ts:511-523`, having been parsed at `:428-438`.
- `rules.ts:266-270` carries a comment claiming no row has `manually_categorized = 1` or
  `category_source = 'human'`. There are **62**. The comment is stale and load-bearing enough that
  one diagnostic agent copied it instead of querying.
- `tests/budgetProjection.test.ts:238-243` **asserts** that reading the rollover ledger writes to it.
  Making the read pure breaks that test by design; the assertion has to be replaced, not added to.

---

## Order, and why

1. **Phase 5b first.** It is wrong money on screen right now — $1,705.78 of it — and it is small and
   self-contained. Every later phase reads these numbers.
2. **Phase 5c next**, because Phase 6 hands the AI more authority over exactly these surfaces, and
   authority over a wrong number is worse than no authority.
3. **Phase 6** is the largest block and the point of the whole exercise, but it goes third because
   its own inputs are what 5b and 5c make true.
4. **Phase 7b/8** last among the building work: the screens should render numbers that are already
   correct, and consolidating views that earlier phases keep touching means editing them twice.
5. **Phase 9** verifies the whole thing against the real database.

---

## Phase 5b — The three defects the audit missed

**5b.1 Make a credit position representable.** Readers first, or the app disagrees with itself.

- [x] `safeToSpend.ts:72` — drop `Math.abs`; a negative card balance reduces what is owed. Rewrite
      the comment on `:71`, which currently asserts the thing being removed.
- [x] `aiContext.ts:266` — drop `Math.abs`, and branch the label so a negative renders as
      "$X.XX credit balance" and never as "owed".
- [x] `netWorthHistory.ts:184` — `deriveAssetBuckets` must not abs a liability into the liabilities
      bucket.
- [x] `snapshot.ts:415` — the clamp that says "neither a market-driven account nor a liability can
      sensibly go negative" is wrong for liabilities and must stop applying to them.
- [x] Test: one liability fixture at −$563.26 must produce `netWorth = assets + 56326`,
      `cardBalances = -56326`, and an `aiContext` line containing "credit", in all four services.

**5b.2 Put the sign invariant in the write path.** Exact-magnitude only.

- [x] A new sync stage that runs **after** transactions are written and **before** the snapshot, so
      net worth is written from a corrected balance rather than corrected afterwards. Per liability
      account: `expected_owed = owed_at_newest_measured_snapshot − SUM(amount since that date)`.
      Adopt `expected` **only** when `expected < 0`, `stored > 0`, and `|expected| === |stored|`
      exactly, to the cent. No tolerance.
- [x] Exactness is the safety property, and it is why this is not a heuristic: the rule can only
      fire when the provider's own transactions agree with the provider's own magnitude and disagree
      only about direction. An incomplete feed (Discover's backfill floor is 2026-06-16, Coinbase's
      is 2025-09-04) cannot trigger it, because then the magnitudes will not match to the cent.
- [x] Every adoption writes a `sync_changes` row naming both values, so a corrected balance is never
      silently different from what the provider said.
- [x] Widen the `liabilityAdjustedCents` guard so it is not one-sided: it should fire whenever the
      provider's sign disagrees with the ledger's, not only when the magnitude is positive.
- [x] Tests, driven through a real payload: BofA's exact shape (previous 0, one +$5.82 row, provider
      −$5.82) must store −582 and emit an advisory. Capital One's shape (previous 0, one −$8.88 row,
      provider −$8.88) must store +888 untouched. A deliberately mismatched magnitude must store the
      provider's value untouched.

**5b.3 Stop reconciliation reporting a boundary artifact as a ledger gap.**

- [x] `AccountReconciliation` gains `boundary_amount` = `SUM(amount on first_date) − SUM(amount on
      last_date)` and `adjusted_residual` = `residual − boundary_amount`, using the same
      `pending = 0` filter as `sumBetween`.
- [x] `unreconciled` filters on `adjusted_residual`; the row keeps reporting `residual` and
      `boundary_amount` separately, so the uncertainty is surfaced rather than hidden. Bounded by one
      calendar day of activity at each end, so it cannot mask a mid-horizon gap.
- [x] Test: one +$544.18 row dated exactly on `first_date` must give residual 54418,
      boundary_amount 54418, adjusted_residual 0, and must not appear in `unreconciled`; the same row
      dated one day inside the horizon must still appear.
- [x] Expected result after 5b.1–5b.3: `unreconciled` is empty and `total_residual` is $40.13
      (Coinbase $41.06 + Roth IRA −$0.93, both market-driven price drift).

**5b.4 Brokerage sign: detect and surface, never rewrite.**

- [x] `reconciliation.ts` gains `direction_conflict`, set when `sign(observed_delta) !==
      sign(explained_delta)` and `|explained_delta| > RESIDUAL_TOLERANCE_CENTS`. The market-driven
      early-return at `:184` becomes `if (is_market_driven && !direction_conflict) return false`.
      A price move can change the magnitude of a brokerage's residual; it cannot make the ledger's
      own external-flow direction disagree with the balance.
- [x] An ingest-time advisory in the existing `errors[]` channel (the one `triageSimplefinErrors`
      already classifies as advisory rather than reauth), gated to the whole-pass case — every row in
      the pass same-signed, balance moved the other way — so posting lag on a busy checking account
      cannot re-noise the sync panel.
- [x] `simplefin.ts:556` stays exactly as it is. The passthrough is the invariant being protected.
- [x] Test: `tests/reconciliation.test.ts`'s existing market-driven case must still pass (that
      brokerage has no transactions, so `explained_delta = 0` and the guard cannot fire).

**5b.5 Merchant rule precedence.**

- [x] `rules.ts:272-274` — make the order total and human-first:
      `ORDER BY (source = 'ai') ASC, length(pattern) DESC, created_at DESC, id ASC`.
      `id ASC` is the load-bearing part: without a total order the winner among 41 tied `created_at`
      groups is whatever the sorter emits. `MerchantRule` gains `source`.
- [x] `aiWriteGuards.ts` gains `checkRuleDoesNotContradictOwnerRule(db, pattern, categoryId)`,
      wired into `confirmMerchantRule` **before** `checkRuleAgreesWithHistory`. Contention means
      either pattern matches the other, or the two share a matching transaction. This is the guard
      that closes the hole: `checkRuleAgreesWithHistory` reads only `transactions`, so an owner rule
      for a merchant with no history is invisible to it.
- [x] Retire the two contradicting AI rules (`"Spotify"`, `"Backblaze"`) through `retireMerchantRule`
      so the retirement is itself recorded, not deleted.
- [x] Fix the stale comment at `rules.ts:266-270` (62 human rows, not 0).
- [x] `routes/rules.ts:230-232` calls `applyMerchantRulesToExistingTransactions` with no
      `skipManual`, so `POST /api/rules/apply {only_uncategorized:false}` can overwrite
      `category_source = 'human'` rows. It writes 0 today only because none of the 62 human rows
      happens to contend. That is luck, not a guard.
- [x] Tests: three rules with **identical** `created_at` (human streaming, human streaming, ai
      subscriptions) then `recategorizeAll`, asserting streaming wins — the identical timestamps are
      the point. And an owner rule with **zero** matching transactions must still block a
      contradicting AI rule — zero transactions is the case the existing guard waves through.
- [x] Expected result: `recategorizeAll` goes from 41 changes to 2, and both survivors are
      pre-existing human-rule effects present in the baseline.

---

## Phase 5c — The rest of Phase 5

- [x] **Rollover ledger stops writing on read.** `getBudgetRolloverLedger` (`budgetProjection.ts:316`,
      upsert at `:374`) is the only writer of `budget_rollover_ledger`, and it runs on
      `GET /api/budgets/rollover-ledger` (`routes/budgets.ts:275`) and from the Cmd+K heuristic path
      (`advisorTools.ts:270`). `localGuard.ts:65` exempts GET from the origin check precisely because
      GETs were assumed not to mutate. Split into a pure `computeBudgetRolloverLedger` and a
      `recordBudgetRolloverLedger` called from the sync path and the budget POST/PUT handlers. The
      writer must land in the same commit or the panel renders empty.
      Live impact: the stored July row records `budget_amount 40000` from before the budget was
      raised; a GET today rewrites it to 50000 with `actual_spend −120363`, swinging
      `ending_rollover` by $1,812.79. Replace `tests/budgetProjection.test.ts:238-243`, which
      currently asserts the write-on-read.
- [x] **Ledger-derived daily balance history.** New `services/balanceHistory.ts`. Reverse-replay
      `accounts.current_balance` through `transactions` to one point per calendar day, each tagged
      `source: 'ledger' | 'measured'`, with measured snapshots carried through as anchors. Route by
      account type at `routes/accounts.ts:46`; market-driven types keep the documented reverse-replay.
      Today every account gets exactly 19 points over 179 days regardless of how much ledger it has.
      Ledger-derived gives BofA Cash Rewards 1,049 daily points from 2023-09-16. The invented cliff
      this kills, from the live breakdowns: Wealthfront Cash reads $1,517.30 → $0.00 → $1.70 →
      $1,001.70, drawn as measured history, on an account whose 12 real transactions reconcile
      exactly to zero residual.
- [x] **Surface the data-quality layer.** `getDataQualitySummary` is composed, served at
      `routes/insights.ts:98`, has a client fetcher, and renders nowhere. Render the issue list with
      each issue's `route` as its link target. Drop `score` entirely — a number out of 100 is the
      derived-as-fact failure this whole rebuild is about.
- [x] **Crypto units before crypto basis.** Migration: `transactions` gains `quantity REAL` and
      `security_id TEXT` (nullable, non-money, outside `money.ts`'s remit). Populate at the write
      path in `coinbase.ts:511-523` from `order.filled_size` / `order.product_id` and in
      `classifyCoinbaseLedgerTx` (`coinbase.ts:116`), both already parsed and discarded. Only then is
      `deriveCryptoCostBasis` writable: FIFO, leaving `cost_basis` NULL for any holding whose
      replayed units do not match `holdings.quantity`. **That refusal is the feature.** On today's
      data it will refuse BTC, ETH and POL, because the disposals that zero the pre-2026 lots
      (24 Convert, 7 Send, 6 Receive, 1 Dust) exist only in `data/coinbase/*.csv` and were never
      imported. A dollars-only basis would report $739.45 where the truth is $501.40; do not ship it.
- [x] **Transfer detection gets one chance per row, not one chance ever.** The eligibility predicate
      at `transactionIntegrity.ts:186-195` requires the category to be NULL or a transfer category,
      so categorization makes a row permanently unpairable. Change it to "never human-categorized and
      not dismissed as a transfer". Two prerequisites the first pass at this missed: the pairing
      UPDATEs at `:270-286` and the rebuild reset at `:200-211` both bypass `categoryWrites.ts`
      entirely, and the reset **nulls** a category rather than restoring the prior one, on every sync.
      Both have to move to `categoryWrites` or the widened pool destroys a machine category hourly.

---

## Phase 6 — AI as structural

The boundary, confirmed 2026-07-30 and unchanged: a write earns autonomy when it is an observation
about data that already exists, has an exact mechanical inverse, has a bounded and enumerable blast
radius, and does not overwrite a number the owner set.

**6.0 Model tiering.** Small, independent, and a prerequisite for everything else in this phase.
Three SDK call sites exist. `routes/ai.ts` is already modern (streaming, adaptive thinking,
`output_config.effort`, one cache breakpoint). The other two are on the pre-4.6 surface.

- [x] `aiWorker.ts:160` and `aiCategorySuggest.ts:62` — delete `temperature: 0.1`. A sampling param
      is a 400 on Sonnet 5 and Opus 5; it works today only because both call Haiku 4.5.
- [x] `aiWorker.ts:166` and `aiCategorySuggest.ts:75` — `response.content[0]` assumes a text block.
      Both target models run adaptive thinking by default, so `content[0]` becomes a thinking block,
      `rawText` resolves to `''`, and **both paths silently return zero results with no exception**.
      Replace with `content.find(b => b.type === 'text')`. This is the more dangerous of the two
      breaks and it is silent.
- [x] `advisorSettings.ts:16-20` — `claude-opus-4-8` becomes `claude-opus-5`. Drop
      `claude-haiku-4-5`: it is the one entry the unconditional `thinking: {type:'adaptive'}` +
      `output_config.effort` at `ai.ts:372-373` cannot serve.
- [x] The real invariant behind that: `ai.ts:372-373` builds `thinking` and `output_config` with no
      reference to the model it read at `:344`. A whitelist assertion in a test is not a guard — it
      restates a hardcoded list and a future re-add edits both in one commit, which is exactly how
      033/039/040 decayed. The request shape has to be derived from the model.
- [x] `ADVISOR_EFFORTS` extends to `['low','medium','high','xhigh','max']`. Raise `max_tokens`
      (`ai.ts:369`, currently 8192) — thinking counts against it, and an 8-round tool loop at max
      effort is the same truncation failure already documented for the worker. Update
      `tests/advisorSettings.test.ts:37,40,54` in the same commit.
- [x] Handle `stop_reason === 'refusal'` before reading content, at all three sites. Nothing does
      today, and both target models can return 200 with an empty content array.
- [x] Set an explicit `timeout` on the client (`anthropicClient.ts:57`). The worker's default
      10 minutes × 3 attempts blocks every subsequent review pass through the `workerRunning` guard.
- [x] Per-job assignment: Sonnet 5 medium as the baseline, Haiku 4.5 for bulk classification and
      near-lookup work, Opus 5 for self-audit and monthly synthesis.
- [x] **Do not** add `cache_control` to the worker. Its prefix is unstable by construction — it
      interpolates `Last successful sync: <timestamp>`, rewritten by the very sync that fires the
      worker, plus 15 volatile transactions and 20 sync changes. Cache reads would be 0 on every call
      while writes bill 1.25×: a ~25% input-cost increase with no offset.

**6.1 What the model can read.**

- [x] **`schemaDoc.ts`**: a curated semantic dictionary, versioned in the repo. Per-column units with
      the REAL-dollar price exceptions named as exceptions; sign conventions (liabilities stored
      positive as owed **and now legitimately negative in credit**; refunds are positive rows inside
      expense categories and are not income); the literal text of the spend/income predicates to
      paste; enum meanings (`category_source` NULL means pre-provenance, not zero); time semantics
      (dates are local `yyyy-MM-dd`, `created_at` is ISO UTC, SQLite's `date('now')` is UTC and
      disagrees with our month boundaries, so today's local date is supplied as a literal).
- [x] Read-only SQL gets a wall-clock kill and a row cap. It is write-proof but not time-proof; model
      SQL can currently freeze the single-process app.
- [x] New typed read tools: `get_merchant_rules`, `get_my_action_history`, `get_holding_history`,
      `get_sync_runs`, `get_provenance_summary`, `get_transaction_full`, `get_reconciliation`.
- [x] `aiContext` gains the sections it never had: existing rules, provenance distribution (2,412 of
      2,579 rows are `category_source` NULL), its own recent actions and their outcomes, the
      reconciliation state, full temporal reach instead of a 3-month average and 15 rows.

**6.2 What the model remembers.**

- [x] **Migration `ai_feedback`.** There is no record anywhere of the AI being wrong.
      `undoAdvisorAction` writes nothing; `updateTransaction` clears `category_action_id` on a hand
      edit, which protects undo and simultaneously erases the evidence. Written from three call
      sites: undo, manual override (before clearing), draft dismissal. Highest-value single addition
      in the design.
- [x] **Migration `ai_memory`** (scope / subject / statement / kind / evidence_count /
      superseded_by), visible, editable and deletable in Settings, carrying the evidence that
      produced each entry.
- [x] **Migrations `ai_runs`, `ai_incidents`.** Shipped as 051 and 050. `ai_observations` and
      `ai_briefs` were formally DROPPED on 2026-08-01, not deferred: neither was ever given a stated
      purpose beyond its name, `ai_memory` covers standing notes and the digest is computed on
      demand, and a second store would be another hand-maintained copy of state the run rows already
      carry. Decision recorded in `rebuild-part-3.md`; zero code references either table.
- [x] **Transaction field provenance.** The sync work protected a hand-edited `merchant_name` from
      provider overwrite using the row's own pending state and deliberately did not extend that to
      `date` / `amount`: pinning a money field the institution later revises would leave the ledger
      permanently disagreeing with the balance it reconciles against, with nothing on screen saying
      so. Doing it properly needs a `field_source` or edit-revision log shaped like migration 042.
      It belongs here, with the rest of the provenance work — and 5b.4 is the case that proves the
      need, because without it a corrected amount is indistinguishable from a reported one.

**6.3 What the model may do.**

- [x] **`aiGuards.ts`**: snapshot the headline set (net worth, month spend, month income, savings
      rate, 60-day scheduled net, per-category totals) before an autonomous batch, re-run the
      invariants after, diff, and auto-revert the whole batch by action id on breach.
- [x] **`aiJobs.ts` + `aiScheduler.ts`**: named jobs with a declared
      `{trigger, model, effort, writes, invariants, digestSection}`. Move the worker kickoff into a
      `finally` so a partial sync still triggers a pass (today it sits after `if (deferredError)
      throw`).
- [x] Emit an SSE event when a background pass applies anything, so the client stops rendering
      pre-AI category totals for up to 5 minutes.
- [x] **Expanded autonomous writes**: recategorize beyond uncategorized (never `human`), update and
      retire merchant rules, security metadata, merchant-name normalisation (with `original_name`
      immutable), exact-match duplicate resolution, equal-and-opposite transfer confirmation,
      recurring confirmation at 4+ occurrences.
- [x] **Proposal-only, per the owner's carve-out**: `update_budget`, `update_goal_target`,
      `set_manual_cost_basis`, category merge / delete / re-parent.
- [x] **`GET /api/ai/digest`**: diff-shaped and complete, row-level before/after, one-click
      revert-since-timestamp. Not a summary.
- [x] Chat loads history server-side from `conversationId` rather than trusting the client array.
- [x] Tests: `aiMemory`, `aiFeedback`, `aiGuards`, autonomy boundary.

---

## Phase 7b — Finish the design system

- [x] **Type**: open the range. The scale exists and is well built; it is unused above 17px and
      unused in weight. 422 of 466 type-step usages sit in an 11.5–15px band; 0 `font-bold`.
- [x] **Elevation** that works on a dark ground: shadow stops being the mechanism and value
      separation takes over.
- [x] **Charts**: `TrendChart` autoscales to its own min/max, so a $40 wobble and the real $1,518
      July fall draw the identical picture, and its x-axis is an array index, so a 5-month gap and a
      1-day gap have the same width. Calibrated scale with a printed zero; time-proportional x.
      Load the `dataviz` skill before touching chart colour.
- [x] **The motif.** Transform, do not kill: mīzān *is* balance. `MAX_TILT_DEG = 9` and the real
      sheet returns 1.40°, moving the pan end ~2.6px; seven months of real snapshots span a 2.1°
      excursion, about 4px. Replace the drawn scale with a calibrated horizontal beam: extent is the
      whole sheet, a fixed tick at 50% is the fulcrum that never moves, the needle sits at the real
      boundary. Today's 57.8% versus 50% is ~70px on a 900px bar; 2026-03-01 was ~37px the other way.
      Same data, roughly 25× the legibility, and a position on a labelled axis is a measurement where
      a rotation is a mood. The beam is also where degradation shows: when a stage failed or the
      snapshot is stale the whole primary reading goes uncalibrated, replacing a 7px dot that
      currently renders sage whenever status is not `'error'`, including when the label beside it
      says "Not synced yet".

Carried from the token work, still open:

- [x] ~27 hardcoded hexes in views (category and chart colours) do not follow the theme and will look
      wrong on the dark ground. Route them through tokens.
- [x] `shadow-e1-alt` is used 5 times and is not defined in `tailwind.config.js` — a dead utility
      emitting no CSS.
- [x] `Today.tsx` uses `text-faint` on two strings; `faint` is documented non-text (3.26:1 light,
      4.10:1 dark) and is the one token deliberately below AA.
- [x] U+2192 (used in 8 files) is in neither font subset and falls back to the system stack.
- [x] Instrument Sans italic is not shipped; the two italic strings in Advisor synthesize oblique.

---

## Phase 8 — Screen consolidation, 12 items to 6

- [x] **`/` the instrument** absorbs Today, Cash Flow and Reports. Reports and Cash Flow become a
      *time window* on one surface, not separate screens: one selector reshapes the same query set.
      Removes ~660 lines of duplicated view code and the possibility of two screens disagreeing about
      net worth, which `Reports.tsx` already carries a comment about having shipped once.
- [x] **`/ledger`** absorbs Transactions, Review and Bills. Bills dies for a structural reason: a
      bill is a transaction that has not happened yet, and giving future money its own screen is the
      mechanism by which forecasts get read as facts. The 30-day forecast sits at the top of the
      ledger, above today's rule, on the same date spine, in estimate ink. Review dies as a filter
      because it is a filter. Row flags include `category_source`, recorded per row and rendered
      nowhere.
- [x] **`/accounts`** absorbs AccountDetail.
- [x] **`/investments`** stays its own screen (owner's decision, 2026-07-30).
- [x] **`/plan`** absorbs Budget and Goals.
- [x] **`/settings`** absorbs Onboarding, an orphan route nothing links to in an always-logged-in
      single-owner app.
- [x] **Advisor stops being a tab, and the nav holds at six.** Owner's direction, 2026-07-31, after
      weighing the alternative: if the AI is genuinely integrated everywhere then it does not need a
      tab, and its settings stay in Settings. So `/advisor` is deleted rather than repurposed.

      That works because every piece of it already has a better home than a tab:

      | surface | home |
      |---|---|
      | conversation | ⌘K, as a sheet over the current screen |
      | a draft about a row | inline on that row, in estimate ink, one-key accept |
      | the digest of what it did | ⌘K, where it already renders |
      | model, effort, memory, action history | Settings, where they already are |

      ⌘K is the only conversational surface, and an answer arrives beside the data it is about. 251
      drafts and 140 applied actions have never once been visible next to the data they modified.

      **The anti-sidebar argument, so it does not get lost:** a sidebar chat is a second place to look
      that competes with the screen for attention and answers next to nothing. A sheet inherits the
      screen's context; an inline draft answers where the question is. Neither adds a permanent column.

      **The test of "seamless" is that nothing needs a tab to be reachable.** If any AI surface ends up
      with nowhere to live, that is the signal the integration is not finished, not the signal to add
      the tab back.

- [x] **Delete budget groups** end to end: both tables are empty after three weeks in an app with one
      budget. 115 lines of service, five routes, a 120-line modal, the memo machinery, four fetchers,
      one test file.
- [x] **Delete three dead preference keys**: `dashboard_layout`, `custom_report_views`, and
      `advisor_auto_apply_high_confidence`. The third reads `true`, asserting a confidence-gated
      autonomy policy removed in `f61109b`, and the model can read it through `run_sql_query`.
- [x] **Nav**: six words, labelled at every width. Today every label is behind `xl:block`, so under 1280px the entire navigation is
      twelve identical 7px dots at 1.6:1 contrast. Un-hijack ⌘R and ⌘P, currently `preventDefault`ed
      for Review and Reports, killing reload and print.
- [x] **Catch-all route.** There is no `path="*"`, so a typo renders a blank page.
- [x] Sub-500px is explicitly out of scope: `localGuard` binds this to loopback, so it is a desktop
      object. The 1280px break is real; 375px is not.

**Rendering hazards the correctness work created.** These are consequences of making the data honest
and must be handled, not flattened back into looking tidy.

1. **A spending category can be negative.** July 2026 Shopping is −$1,203.63 because that month's
   Amazon and REI credits exceed its purchases. `ProgressBar` cannot take a negative width, a
   share-of-total percentage against a signed total is meaningless, and a "top spending" list sorted
   by amount puts the largest credit last.
2. **An isolated estimated point invites false interpolation.** 2024-07-01 survives the
   informativeness gate legitimately, on one real $10 crypto buy, but its nearest neighbour is
   2025-04-01, nine months later. Coverage is 6/14 there. The trace has to break, not connect.
3. **Coverage changes along the series and part of the "cliff" is not money.** Estimated 2026-06-01
   is $3,823.16 at 14/14 coverage against measured 2026-06-30 at $1,068.29 at 11/11. Some of that
   drop is accounts arriving in mizān rather than money moving.
4. **`free` is signed now.** "Short this month" and "free to spend" are different states and must
   read differently, not as a red number in the same slot.
5. **A card balance can be negative** (5b.1). "You owe $563.26" and "Discover owes you $563.26" are
   different states and must read differently.

---

## Phase 10 — More than one provider

Owner's direction, 2026-07-31: support the major providers, OpenAI and Gemini alongside Anthropic, so
the model is the owner's choice. This is a real abstraction job rather than a config switch, and the
reason is worth stating before any of it is built.

**The seam already exists and is the right one.** `MODEL_CAPABILITIES` and `buildModelRequestShape()`
in `advisorSettings.ts` already derive the request from the model instead of assuming every model
takes the same shape, and `ADVISOR_MODELS` is derived from that same table so a whitelist cannot drift
from it. Adding a provider dimension to that table is the shape of the work. There are exactly three
SDK call sites: the streaming chat with tools (`routes/ai.ts`), the structured-output worker
(`aiWorker.ts`), and bulk classification (`aiCategorySuggest.ts`).

**What is genuinely Anthropic-shaped here, and must not be quietly dropped.** Each of these has an
equivalent on the other providers, and none of them is the same shape:

- **Prompt caching.** `cache_control: {type:'ephemeral'}` sits on a system prompt that is currently
  about 18,000 characters of financial context, re-sent on every turn and every tool round of every
  conversation. That marker is the only reason the design can afford to send the whole picture rather
  than a summary, and "send the whole picture" is the thing that made the advisor stop guessing.
  OpenAI caches automatically on a prefix-match basis and Gemini has explicit context caching with its
  own lifecycle; neither is a drop-in for a breakpoint marker. **Get this right per provider or the
  cost model of the entire AI design changes.**
- **Adaptive thinking**, with `display: 'summarized'`, which is what the SSE `thinking_start` /
  `thinking` / `thinking_end` contract streams to the client.
- **`output_config.effort`**, a five-level ladder now exposed in Settings.
- **`output_config.format` json_schema**, which replaced the worker's fence-strip-and-`JSON.parse`
  trust boundary. The Zod schema behind it stays regardless, because it carries the cross-field rule
  the JSON schema cannot express.
- **The tool loop**, bounded at 8 rounds, whose `tool_use` / `tool_result` block shapes differ per
  provider.

**Do not build a lowest-common-denominator client.** The honest design is a capability table that says
per model what it supports, and surfaces that degrade legibly: an effort dial that is not rendered for
a model that has no effort ladder is better than one that silently does nothing, which is the exact
defect Phase 6.0 removed for Haiku 4.5. A model that cannot cache a large prefix should say what that
costs before the owner picks it, not after.

- [x] Provider abstraction over the three call sites, keeping the derive-from-the-model invariant
      rather than adding a second source of truth beside it.
- [x] Per-provider credentials in `.mizan/credentials.json`, which is already AES-256-GCM encrypted
      with the key in the OS keychain, so this needs no new secret-handling mechanism. `.env` override
      per provider, matching the existing Coinbase precedent.
- [x] Capability table extended with a provider dimension: caching mechanism, thinking, effort,
      structured output, tool-call shape, context window, output cap.
- [x] Degrade legibly. Every surface that exposes a knob asks the table whether the chosen model has
      it, and says so when it does not.
- [x] The worker and the classifier pick per job, per the tiering already in `JOB_MODELS`. Cross-
      provider tiering is a feature, not an accident: a cheap classifier on one provider and a
      reasoning model on another is a reasonable thing for the owner to want.
- [x] Tests drive the real SDK for each provider against a local server with the base URL pointed at
      it, the way `tests/aiRequestShape.test.ts` already does for Anthropic, so the assertions are on
      the actual outgoing request body rather than on a mock.
- [x] **Say what changes.** The financial context is the same for every provider and every figure in
      it must stay true; nothing about the provider abstraction may weaken the "never a claim the code
      did not check" rule, which is currently enforced in prose in `aiContext.ts` and in the schema
      dictionary.

**Ordering note:** this comes after Phase 8 rather than before it, because Phase 8 moves the AI
settings surface into `/ai`, and building a provider picker into a Settings section that is about to
move is work done twice.

---

## Phase 9 — Verification

Numbered 9 and executed last: the order is 7b, 8, 10, 9, because Phase 10 lands a provider picker in
a settings surface Phase 8 is moving, and verification only means something once nothing else is
in flight.


- [x] Full suite plus both typechecks. **1,352 tests pass**, 20 suites, 0 fail. Run twice, twenty
      minutes apart, across a concurrent rewrite of the test schemas (see the last item): 1,352 both
      times, 11.3s then 11.0s. `npx tsc --noEmit` clean on `tsconfig.server.json` and on
      `tsconfig.json`.
- [x] Run the reconciliation invariant against the real database and record the residuals.
      Recorded below, with the flow-conservation check and the data-quality summary beside it.
- [x] Re-derive every headline figure named in both plan files from the live DB. Recorded below and
      in the matching section of `rebuild.md`. **Nine figures no longer hold and two never did.**
- [ ] Drive the app and verify both themes at 1440 / 1280 / 1024.
- [ ] Sweep the 91 capped findings from the original audit for anything the phases did not
      incidentally fix.
- [ ] Convert the remaining hand-written test schemas to `migratedTestDb()`. **In flight while this
      verification ran**, so no count here is a standing figure. Two readings twenty minutes apart:
      65 of 113 files calling `migratedTestDb()` with 16 still holding a literal `CREATE TABLE`,
      then 68 of 113 with 11. The 11 at the second reading were `accountTypeClosed`,
      `budgetProjection`, `coinbaseConsolidation`, `conversations`, `deadPreferences`,
      `localBackup`, `merchantRules`, `nestedTransaction`, `readonlySql`, `recategorize`,
      `simplefinGuards`. Count it again before believing it.
- [ ] Update `CLAUDE.md`, and note that it is currently gitignored and therefore unversioned.

---

### Phase 9, run 2026-07-31: the three invariants against the owner's real database

Run against a private byte copy of `.mizan/mizan.db` taken with `sqlite3 .backup`, at **migration
`054_drop_dead_preferences.sql`** (53 rows in `schema_migrations`, `001` through `054`, `038`
deliberately absent). Twelve migrations later than the database Part I's audit measured, and one
later than the copy the Phase 8 test harnesses were built on. The live file was never opened for
writing; a dev server holds it.

One caveat on the code-side figures only, and it is worth stating rather than hiding: another session
was rewriting test files under `tests/` while this ran. `client/` and `server/` were untouched
throughout, so every grep-derived figure below is stable, and nothing in the ledger figures depends
on the working tree at all. The test-file counts are the exception and are marked as such.

Ledger as it stands: 2,588 settled transactions, 2023-09-16 to 2026-07-29, 14 accounts, 236 merchant
rules of which 234 live, 253 advisor drafts, 142 applied AI actions, 1 budget, 1 goal, 32 net-worth
snapshots of which 16 measured and 16 estimated.

**1. Reconciliation invariant.** `reconcileAccounts(db)`, no `since`.

| | |
|---|---|
| measured snapshots in the horizon | 16, 2026-06-30 to 2026-07-31 |
| accounts judged | 14 |
| accounts skipped, unjudged | 0 |
| `unreconciled` | **empty** |
| `total_residual` | **134,748 cents, $1,347.48** |

Per account, cents, `residual` / `boundary_amount` / `adjusted_residual`:

| account | residual | boundary | adjusted | note |
|---|---|---|---|---|
| Fidelity Individual | 78,438 | 0 | **78,438** | market-driven; `explained_delta` is −40,000 against an observed +38,438 |
| Chase Checking | 54,418 | 54,418 | **0** | the 5b.3 horizon artifact, one payroll dated on `first_date` |
| Coinbase | 3,318 | 0 | **3,318** | market-driven price drift |
| Chase Sapphire | −1,326 | −1,326 | **0** | the same artifact, opposite sign |
| Fidelity Roth IRA | −100 | 0 | **−100** | market-driven price drift |
| Wallet, Chase Freedom Flex, BofA Cash Rewards, Capital One Savor, Discover, Wealthfront Cash, BofA Checking, BofA Savings, Chase Savings | 0 | 0 | **0** | |

Sum check: 78,438 + 54,418 + 3,318 − 1,326 − 100 = 134,748, which is `total_residual` exactly.

`direction_conflict` is false on every row. `residual_ratio` is 1.96 on Fidelity Individual, which is
why it stays out of `unreconciled`: the market-driven early return holds because there is no
direction conflict.

**2. Flow conservation.** `findFlowConservationViolations(db)`: **1 finding**, and it is the same one.

> Chase Checking and Fidelity Individual, **20 legs**, 2026-05-21 to 2026-07-27, **$700.00** of
> movement.

This reproduces the Phase 5b figure to the leg and to the cent.

**3. Data-quality summary.** `getDataQualitySummary(db)` returns `{ issues }` and nothing else. No
`score`. **2 open conditions**, which is the count Phase 5c recorded, but neither is the condition it
recorded:

| id | severity | route | message |
|---|---|---|---|
| `sync-attention` | critical | `/accounts` | "1 connection need action before Mizān can fully trust the data." |
| `transaction-review` | info | `/review` | "7 review items need attention." |

`sync-attention` is firing on real state, not spuriously: `simplefin_connections` holds
`status = 'sync_error'`, `last_synced_at = 2026-07-30T21:50:47.031Z`. `/review` is a retired path but
not a dead link: `LEGACY_TARGETS` redirects it to `/ledger?uncategorized=1`.

**Copy defect, live on that first row.** `syncHealth.ts:167` pluralizes the noun and not the verb, so
at a count of one the owner reads "1 connection **need** action". The condition fires correctly; the
sentence is wrong, on the one issue rendered at critical severity.

---

### Every figure both plan files claim, re-derived 2026-07-31

The originals are left where they are. This is the annotation, not a rewrite: what a figure was when
the decision was made is the record, and overwriting it would destroy the thing the plan is for.

**Verdicts used below.** *Holds* means the stated query returns the stated number today. *Moved*
means it was true and the world changed. *Does not reproduce* means the number cannot be recovered
from what is written down, either because it never held or because the query behind it was never
recorded.

#### Figures that hold, unchanged

| figure | query | today | source |
|---|---|---|---|
| Flow-conservation finding: 20 legs, 2026-05-21 to 2026-07-27, $700.00 | `findFlowConservationViolations(db)` | identical | 5b table |
| `recategorizeAll` relabels **2** rows | `recategorizeAll(db)` on a throwaway copy | `{updated: 2}`; the four category counts that move are `cat_income_other` 9→8, `cat_travel_hotels` 36→37, `cat_xfer_cc` 46→47, `cat_xfer_in` 39→38 | 5b.5, 5b table |
| Both contradicting AI rules retired rather than deleted | `SELECT pattern, source, retired_at FROM merchant_rules WHERE lower(pattern) IN ('spotify','backblaze')` | both carry `source = 'ai'`, `retired_at = 2026-07-30T21:50:31Z` | 5b.5 |
| 236 merchant rules, 41 distinct `created_at` | `SELECT COUNT(*), COUNT(DISTINCT created_at) FROM merchant_rules` | 236 and 41 | diagnosis §3 |
| 32 Spotify rows, 7 Backblaze rows | `SELECT COUNT(*) FROM transactions WHERE lower(COALESCE(merchant_name, original_name)) LIKE '%spotify%'` (and `%backblaze%`) | 32 and 7 | diagnosis §3 |
| **62** rows are `manually_categorized = 1` or `category_source = 'human'`, not 0 | `SELECT COUNT(*) FROM transactions WHERE manually_categorized = 1 OR category_source = 'human'` | 62 | corrections to Part I |
| 2,412 rows carry `category_source` NULL | `SELECT category_source, COUNT(*) FROM transactions GROUP BY 1` | 2,412 (the denominator moved: 2,588, not 2,579) | 6.1 |
| `review_status`: open **153**, reviewed **2,435**, dismissed **0** | `SELECT review_status, COUNT(*) FROM transactions GROUP BY 1` | 153 / 2,435 / 0, and `dismissed` is still a value nothing writes | Phase 8 |
| Amazon $1,795.86 gross against a $1,112.99 window total | `getTopMerchantsReport(db, {2026-07-01..2026-07-31})` | merchant total 179,586 cents, report total 111,299 cents, ratio 161.4% | Phase 8 |
| $1,800 of brokerage ledger error | the 12 non-reversal `Electronic Funds Transfer Received` rows on Fidelity Individual sum to −90,000 cents; a sign error is twice that | −$900.00 stored, $1,800.00 of error, and all 14 rows are still negative | diagnosis §2 |
| The AI is told `investments: 8 transactions, net -$800.00` | `buildFinancialContext()`, "Excluded from income and spending reports" | verbatim, still | diagnosis §2 |
| Freedom Flex owed $1,235.95 on 06-30; Amazon refund $955.19 on 07-13; autopay 07-26 exactly $280.76; $283.81 statement credit 07-27 | the 06-30 snapshot `breakdown` and the account's July rows | 123,595 cents on 06-30; +95,519 / +28,076 / +28,381 on 07-13 / 07-26 / 07-27 | diagnosis §1 |
| One payroll of $544.18 dated 2026-06-30, the horizon's first date | `SELECT date, amount FROM transactions WHERE lower(...) LIKE '%payroll%'` | present; 21 payroll rows now, not 20 | corrections to Part I |
| Discover's backfill floor 2026-06-16, Coinbase's 2025-09-04 | `SELECT backfill_floor_date FROM accounts` | both exact | 5b.2 |
| Wealthfront Cash: 12 real transactions reconciling to zero residual | `reconcileAccounts` plus the ledger reach section | 12 rows, residual 0 | 5c |
| Coinbase disposal history exists only in the CSV: **24 Convert, 7 Send, 6 Receive, 1 Dust** | `Transaction Type` histogram over `data/coinbase/*.csv` | 24 / 7 / 6 / 1 Retail Simple Dust, exact | 5c |
| 14 holdings, the 8 Coinbase ones all `cost_basis IS NULL` | `SELECT COUNT(*) FROM holdings` and the join to `securities` | 14 holdings, 8 Coinbase, all NULL; 10 NULL in total once the two SPAXX sweeps are counted | 5c |
| Summing only the rows `get_transaction_full` counts reproduces the reports exactly | walk `get_transaction_full` over every July row, sum the signed amount of those whose `reading.counts_toward_reports.spending_and_cashflow` is true | 160,241 cents, which is `getCashflowReport` net (271,540 income minus 111,299 expenses) to the cent | 6.1 |
| `getSpendingReport.total` equals cashflow expenses exactly | both, over 2026-07 | 111,299 = 111,299 | Part I Phase 2 consequence |
| The five refund rows the old classification dropped in July are worth **$2,054.24**, three Amazon credits, an REI return, a Lyft adjustment | the pre-fix predicate, run over 2026-07 | 5,738 + 95,519 + 102 + 75,936 + 28,129 = 205,424 cents, and the composition matches | `transactionFilters.ts` docstring |
| Ledger-wide the residual is **53 rows** | the same predicate, no date filter | 53 rows (the money moved: see below) | `transactionFilters.ts` docstring |
| Six nav items, and a catch-all route | `NAV_ITEMS` + `SETTINGS_ITEM` in `NavRail.tsx`; `path="*"` in `App.tsx` | 5 + Settings; `NotFound` is mounted | Phase 8 |
| `shadow-e1-alt`, `text-faint`, U+2192 all gone from views | grep over `client/src` | zero uses of each; all three survive only as comments recording why | Phase 7b carryover |
| `Advisor.tsx` was 290 lines | `git diff --numstat 9676b0c f28232e` | 290 deleted | Phase 8 |
| 1,352 tests, both typechecks clean | `npm test`, `npx tsc --noEmit` on both configs | 1,352 pass, both clean | Phase 10 |

#### Figures that no longer hold, and what they are now

| figure, as recorded | what it is on 2026-07-31 | why it moved |
|---|---|---|
| **`total_residual` is $40.13** (Coinbase $41.06 + Roth IRA −$0.93), 5b.3 | **$1,347.48.** Fidelity Individual $784.38, Chase Checking $544.18 (boundary, adjusts to 0), Coinbase $33.18, Chase Sapphire −$13.26 (boundary, adjusts to 0), Roth IRA −$1.00 | the horizon rolled forward to 2026-06-30..2026-07-31 and Fidelity Individual now carries an unexplained market-driven residual it did not then. `unreconciled` is still empty, which is the part of the prediction that was load-bearing |
| Net worth **$3,787.23**, 5b table | **$4,193.18** (snapshot 2026-07-31). The 2026-07-30 snapshot is $4,202.86, which is the figure Phase 8 quotes | three more days of ledger |
| Liabilities **$3,947.93 owed**, 5b table | **$4,278.70 owed.** Still three cards in credit: Discover −$563.26, Chase Freedom Flex −$276.12, BofA Cash Rewards −$5.82 | Freedom Flex took a $7.69 Blue Bottle charge on 07-29, so it is −$276.12 and no longer −$283.81 |
| Free to spend **+$277.82**, 5b table | **+$191.23** with the Shopping claim capped at its $500.00 ceiling, **+$691.23** before budget claims. Components: liquid $6,035.67, cards $4,278.70, bills $64.04, goals $1,001.70 | the whole sheet moved |
| July net **+$1,389.00**, savings rate **+64.0%**, Part I Phase 2 | **+$1,602.41** and **59.0%**. Income $2,715.40, expenses $1,112.99 | July was mid-month when it was measured |
| July Shopping **−$1,203.63**, Part I and hazard 1 | **−$1,028.63.** Still negative, which is the point of the hazard | |
| July Amazon credits **$1,772.93** | **$1,771.93** (+95,519, +75,936, +5,738). The REI return is $281.29 exactly, unchanged | off by $1.00; not reconstructible from what is written down |
| Ledger-wide refund residual **$6,267.43** | **$6,277.43**, over the same 53 rows | |
| Estimated 2026-06-01 is **$3,823.16** at 14/14 coverage against measured 2026-06-30 at $1,068.29 at 11/11, hazard 3 | **$5,521.48** at 14/14 against $1,068.29 at 11/11. The coverage asymmetry that the hazard is actually about holds exactly | the reconstruction re-ran on a later balance sheet |
| The 2026-01-01 estimated point is **+$228.70** where the ledger supports **−$1,571.30**, diagnosis §2 | **+$1,367.35.** Neither number reproduces | |
| BofA Cash Rewards **1,049** ledger points, Discover **475**, Wealthfront Cash **226**, 5c table | **1,050 / 476 / 227.** Each grew by exactly one calendar day, which is the series behaving as designed | |
| `describe_schema` **25,507** bytes | **27,254** bytes | Phase 10 added a provider dimension the dictionary describes |
| `get_merchant_rules` for one merchant **1,136** bytes | **1,122** bytes for `merchant: 'Spotify'`; 23,918 unfiltered | the two AI rules retired |
| `get_transaction_full`: **102 of 120** July rows count | **110 of 129** | more July |
| 251 drafts, 140 applied actions | **253** and **142** | |
| `category_source`: 2,412 / 86 ai / 62 human / 12 heuristic / 7 rule, Phase 8 | 2,412 / **88** ai / 62 human / **13** heuristic / **13** rule | |
| 1,297 distinct merchant names | **1,299** | |
| Reconciliation finds **6 of 14** accounts unreconciled, largest residual −$1,126.52 on Discover, Part I | **0 of 14.** Discover reconciles at 0 | this is the 5b work landing, and it is the strongest single confirmation in this pass |
| Backup closure **17 to 28** tables, Part I Phase 4a | **32 of 32.** `LOCAL_BACKUP_TABLES` covers every table in the database | the AI tables from 6.2 and 6.3 were added to it |
| Three dead preference rows are **not yet gone**; `schema_migrations` tops out at 053, Phase 8 "Correction to record" | **Stale. Migration 054 ran at 2026-07-31T22:28:11.786Z.** `app_preferences` holds exactly two rows, `advisor_user_profile` and `net_worth_reconstruction_mark`. `advisor_auto_apply_high_confidence` is gone and `run_sql_query` can no longer read it | |
| Ledger basis: 2,579 transactions to 2026-07-28, 236 rules, 140 actions, 19 snapshots, Part I | 2,588 to 2026-07-29, 236 rules (234 live), 142 actions, **32** snapshots (16 measured, 16 estimated) | |
| Baseline **374 tests**, Part I Phase 0 | **1,352** | |

#### Figures that do not reproduce from what is written down

- **`countTransactionsHeldByRule` at 7.8 ms, about 210x.** The plan names neither the rule nor the
  call shape. Measured today over all 234 live rules: **2,283 ms total, 9.8 ms mean**, with a spread
  from 9.2 ms to **177.9 ms** on the widest rule. The rewrite is clearly real, and the improvement
  is probably close to what was claimed, but "7.8 ms" is a single unlabelled sample that no re-run
  can land on. The claim needs the rule id beside it or it needs to be a range.
- **113 reverse-containment pairs, all endorsed by the owner's settled category.** The predicate is
  not written down. Reconstructing it as "`merchantMatchesRulePattern(name, pattern)` is true and
  the merchant name is shorter than the pattern", over 1,299 distinct names x 234 live rules, gives
  **159**. Either the predicate differed or the ledger moved; from the plan alone it is not possible
  to tell which, and that is the defect.
- **A dollars-only crypto basis would report $739.45 where the truth is $501.40.** The code that
  produced both numbers was deleted with `investmentAnalytics.ts`. Nothing in the repo can re-derive
  either one. The conclusion it supports is sound and independently visible (all 8 Coinbase holdings
  still carry NULL `cost_basis`, and the disposals are still only in the CSV), but the two figures
  are unverifiable and should be read as a record of a decision, not as measurements.
- **73,738 of 529,149 whole-cent sheets** rendered the false payoff sentence. The enumeration ran
  against the pre-fix `Reports.tsx`, which no longer exists, and its input (liquid $5,291.49) is now
  $6,035.67. Not reproducible.
- **568 lines deleted across twelve files, Phase 8.** `git diff --numstat 9676b0c..f28232e` over the
  whole phase is 14,922 insertions and 5,991 deletions across 154 files; the nine deleted view files
  alone account for **3,202** deleted lines. There is no reading of "twelve files" that yields 568.
  The deletion is much larger than the claim, so the claim understates rather than overstates, but
  it still does not reproduce.
- **The beam puts the measured month across 181px of a 1196px axis**, and the tilt figures it
  replaced (8.66px, 5.13px). These are rendering geometry, not database state. The tests that pin
  them pass, so they are checked; they are simply not re-derivable from the ledger.
- **Onboarding was 139 lines.** `git diff --numstat` says **138**.

#### One claim in code that its own published query does not return

`rules.ts`, in the `rulesOutranking` docstring, says "236 live rules over 41 distinct timestamps,
173 of them sharing one" and prints the query beside it:

```sql
SELECT created_at, COUNT(*) FROM merchant_rules WHERE retired_at IS NULL
GROUP BY created_at ORDER BY 2 DESC
```

That query returns **234** live rules, 41 distinct timestamps, and **171** in the largest group.
Two of the three numbers are wrong, and they are wrong because the comment was written before 5b.5
retired the two AI rules that the same commit retired. This is the exact failure mode Phase 6.1
recorded and closed ("re-measure any figure you write into a comment, state the query beside it, or
delete it"), reappearing in the file the retirement happened in. The query is right there and
disagrees with the sentence above it.

#### Still open on the real data, and not a regression

- The **mis-signed Fidelity amounts remain uncorrected**, deliberately, per 5b.4 and the 6.2 note.
  Their live cost, re-measured: a $784.38 unexplained residual on Fidelity Individual, and an AI
  prompt that still reads `investments: 8 transactions, net -$800.00`. Migration 048 landed the
  provenance that makes correcting them possible; nothing has used it yet.
- **23 hardcoded hexes remain** under `client/src/views` and `client/src/components`, against the
  "~27, route them through tokens" item marked done in Phase 7b. 22 are the swatch values in
  `settings/CategoriesSection.tsx`, which is a colour picker and arguably wants literals; the
  remaining one is `#c9963a` in `SyncActivityPanel.tsx`, which is not.
- **`font-bold` is still used zero times.** Phase 7b diagnosed "unused in weight" and opened the
  scale; the weight range today runs light (9), normal (6), medium (24), semibold (13). That is a
  wider range than before and the diagnosis figure still literally describes the code, so the item
  is done in spirit and the specific number was never re-checked after.
- **`budget_rollover_ledger` holds one orphaned row.** The only budget carries `rollover = 0`, so
  `computeBudgetRolloverLedger(db)` returns `[]`, but the table still holds
  `2026-07 / budget_amount 50000 / actual_spend −120363 / ending_rollover 170363`, calculated
  2026-07-30. The row's `actual_spend` of −120,363 cents is stale: July Shopping is **−102,863**
  cents today. Nothing reads it while `rollover = 0`, so it is inert rather than wrong on screen,
  but it is a stored figure no live code path can restate.
- **`ai_feedback`, `ai_memory` and `ai_incidents` are all empty**; `ai_runs` holds exactly one row
  (`background_review`, `claude-sonnet-5`, medium, completed, 0 proposed / 0 applied / 0 refused,
  21,817 input tokens, 0 cache read and 0 cache write, which is what 6.0 says the worker should
  show). The 6.2 machinery is installed and has not yet had anything to record.

---

## Out of scope, deliberately

- Sub-500px layout (loopback-bound desktop object)
- Multi-user, auth, or anything that widens the bind
- Re-adding Plaid/Teller (removed in 014), the freelance tax feature (019), or the General catch-all
  (036)
- A score-out-of-100 anywhere in the UI: that is the derived-as-fact failure this whole plan is about
- Rewriting a number an institution reported. Detection and provenance, never a silent correction —
  with the single, exactly-bounded exception in 5b.2, where the provider's own transactions prove the
  provider's own magnitude and disagree only about direction.

---

## Progress log

| When | Landed | Verified against the live database |
|---|---|---|
| 2026-07-30 | **Phase 5b complete**, 3 commits (`1eee66f`, `d111cfd`, `5d8210a`) | 560 tests pass, both typechecks clean, `vite build` succeeds |

**Phase 5b, measured.** Every figure produced by running the real services against a copy of
`.mizan/mizan.db`.

| | before | after |
|---|---|---|
| Net worth | $2,081.45 | **$3,787.23** (+$1,705.78) |
| Liabilities | $5,653.71 owed | **$3,947.93 owed**, three cards correctly in credit |
| Free to spend | −$1,427.96 | **+$277.82** |
| Reconciliation, boundary artifacts | Chase Checking −$544.18, Chase Sapphire −$13.26 flagged as ledger gaps | **both adjust to 0** and drop out of `unreconciled` |
| Mis-signed brokerage transfers | invisible | **1 finding**: Chase Checking / Fidelity Individual, 20 legs, 2026-05-21 to 2026-07-27, $700.00 that left two accounts and arrived nowhere |
| `recategorizeAll` | 41 rows relabelled, 39 of them by AI rules that contradict the owner's | **2 rows**, both pre-existing owner-rule effects |

### What the three verification rounds cost, and what they were for

Phase 5b took **three** adversarial rounds, not one. The first implementation passed its own tests
and was still wrong in ways the tests could not see. The pattern is worth keeping:

1. Round 1 built the correction as a post-sync stage. It worked, and it produced **nine spurious
   sync-panel rows every hour, forever**, because the provider rewrites the wrong sign each sync and
   three separate mechanisms each reported the round trip. This codebase had already had that exact
   failure once (the ~123 phantom "modified" rows an hour).
2. Round 2 added two detectors that fired on ordinary healthy events: `direction_conflict` alarmed on
   any brokerage deposit during a down month, and the ingest advisory compared 30 days of ledger
   against one hour of balance movement. Both were deleted rather than tuned.
3. Round 3's first `flowConservation` predicate fired on a payday split, on two card payments in one
   week, and on a transfer plus its reversal. The predicate that holds requires **both legs
   transfer-class, both outbound, neither already paired, and at least two matched pairs between the
   same two accounts** — a coincidence is a coincidence, a repeated pattern is a defect.

The standing lesson: **a detector that fires on a healthy event does not ship.** Every detector in
this phase now has healthy-case tests proving silence, not just defect-case tests proving detection.

### Deliberately not done, and why

- **The mis-signed Fidelity amounts are reported, not corrected.** `upsertSimplefinTransaction`
  overwrites `amount`, so a repair reverts within the hour, and there is no `amount_source` column,
  so a corrected amount would be indistinguishable from a reported one. Correcting it needs the
  transaction field provenance in Phase 6.2.
- **The queue does not pre-filter drafts the guards would refuse.** It was built that way and
  reverted: `merchantMatchesRulePattern`'s substring branch sweeps the bare merchant name `Uber`
  into an `UBER *EATS` rule, so a proposal agreeing with 113 settled rows is refused, and hiding it
  buried a legitimate suggestion with no reason and no way to see it. Refusing on click, with the
  reason, is the visible version of the same decision. The matcher's looseness is a real defect and
  belongs with the Phase 6 AI write work: confirming such a rule would relabel 13 ride charges as
  food delivery.

---

## Phase 5c, landed 2026-07-30

Five commits: `2bc18e9`, `7f1f87b`, `8fc41f6`, `a141d75`, `ec818d0`. **625 tests pass**, both
typechecks clean, `vite build` succeeds.

| | before | after |
|---|---|---|
| Rollover ledger | a GET rewrote the stored July row, swinging `ending_rollover` by $1,812.79 | the read is pure; two calls leave `COUNT(*)` and `MAX(calculated_at)` untouched |
| A closed month's budget amount | restated from the live amount on every call | frozen at what was in force; spend is still re-derived, so a late transaction still reaches the month it belongs to |
| Account balance chart | 19 points over 179 days for every account | **1,049** for BofA Cash Rewards, 475 Discover, 226 Wealthfront Cash, with measured balance sheets marked as dots |
| Wealthfront's invented cliff | $1,517.30 → $0.00 → $1.70 drawn as measured history | gone; the line is the account's own ledger |
| Data-quality panel | rendered nowhere | renders the issue list; **2 open conditions** on the real ledger, both actionable |
| `GET /api/insights/quality` | returned `score: 86` and `"Reliable enough"` | returns `{ issues }` and nothing else |
| Coinbase units | parsed at `coinbase.ts:428` and discarded at the insert | captured on both the v3 order path and the v2 ledger path |
| Transfer pairing eligibility | one chance ever, lost the moment categorization ran | one chance per sync, and both pairing writes now go through `categoryWrites` |

### Two features were cut back to what the data supports

**Crypto cost basis is not derived, and `investmentAnalytics.ts` was deleted.** The derivation was
built, and verification established it could not produce a number on this ledger and added three
failure modes to get there: it priced a self-custody `receive` at market value and called the
difference unrealized gain; a single manual transaction anywhere in the Coinbase account wiped every
basis permanently with no owner remedy; and staking rewards arrive in `holdings.quantity` with no
ledger row, so those holdings refuse forever. All 8 holdings refused, $0.00 was derived, and nothing
in the repo could change that, because the disposal history exists only in `data/coinbase/*.csv` and
`csvImport.ts` writes no units. **The migration and the write-path capture stayed**, because Coinbase
supplies the units on every row and they are unrecoverable once a row is written without them. The
reason is recorded at the capture site, not in a review thread.

**The balance chart makes no agreement claim.** The first version said "Reproduces all 14 measured
balance sheets that cover it, to the cent" when what it had checked was that each measurement landed
inside a two-day band, and that band absorbed up to $3,439.04 on Chase Checking. It also raised
"Differs from the measured balance sheet by up to $715.00" on an ordinary day with an inflow followed
by an outflow, and would have left three accounts carrying a permanent finding the owner could not
act on, because `takeSnapshot` only ever rewrites today's row so the wrong-signed snapshots from
2026-07-23 to 07-29 are permanent. All of it was deleted. The chart is now one ledger line with the
recorded balance sheets marked as dots: Discover's $1,126.52 divergence is visible rather than
asserted, and nothing accuses the ledger of anything.

Two latent `TrendChart` defects surfaced and were fixed in passing, both of them false claims: an
all-estimated series was drawn as the solid measured line, and the crosshair dot floated about 21% of
the plot off its own line.

### The verification pattern, now four rounds deep

Of five Phase 5c tracks, **one passed verification on the first attempt**. The other four each
shipped something that fired on an ordinary healthy event or made a claim the code had not checked:
a panel that read "N open conditions" on a clean ledger because every month contains a transfer; a
freeze that landed in one of two carryover walkers, so the Budget screen and the ledger disagreed by
$100 after an ordinary budget raise; a cost basis priced from an inflow; a chart that accused three
accounts permanently.

None of these were caught by tests, because each implementer's tests asserted that the defect case
was detected. **What catches them is constructing the healthy case and proving silence.** That is now
required of every detector and every piece of user-facing copy in this codebase.

---

## Phase 6.0 and 6.1, landed 2026-07-30

Four commits: `83321bc`, `b1147c5`, `6fbc860`, `46e7ca7`. **752 tests pass**, both typechecks clean,
`vite build` succeeds.

**The request shape is derived from the model now.** `MODEL_CAPABILITIES` records, per model, whether
it takes adaptive thinking, which effort levels it accepts, and whether it supports structured output.
`buildModelRequestShape()` builds the request from that table and drops what the model rejects.
`ADVISOR_MODELS` is derived from the same table, so the whitelist and the capability list cannot
drift: they are one list. That is the actual invariant. A test asserting the contents of a whitelist
would only restate a hardcoded list, and a future cost-motivated re-add edits both in one commit,
which is exactly how migrations 033/039/040 decayed.

Landed with it: `temperature: 0.1` deleted at both sites; `response.content[0]` replaced by a reader
that takes every text block, so a leading thinking block is no longer mistaken for "no answer";
`stop_reason === 'refusal'`, an empty content array, and tool-round exhaustion all now say what
happened instead of returning silently; `claude-opus-4-8` became `claude-opus-5`; effort extended to
the full five-level ladder; an explicit client timeout, because `workerRunning` turns one hang into
every later review pass being skipped; and the worker's fence-strip-and-`JSON.parse` replaced by a
structured output contract, with the Zod schema kept behind it because the JSON schema cannot express
the cross-field rule that `kind === payload.kind`, and it is the payload that reaches a write path.

The tests drive the **real SDK** against a local server with `ANTHROPIC_BASE_URL` pointed at it, so
they assert on the actual outgoing request body rather than on a mock.

**`schemaDoc.ts`** is the semantic dictionary: units with the REAL-dollar exceptions named as
exceptions, sign conventions including a liability that may now be negative, the spend and income
predicates generated from the real functions so they cannot drift, enum meanings including that
`category_source` NULL means pre-provenance rather than zero, and the fact that SQLite's `date('now')`
is UTC and disagrees with this app's month boundaries.

Seven new typed read tools, each a thin wrapper over the service that already owns the aggregate.
Model-authored SQL got a wall-clock kill and a row cap: it was write-proof but not time-proof, and the
UI is served from the same process.

**Two figures worth keeping.** `describe_schema` was 34,398 bytes per call and is 25,507, expanding
only the three tables every spend query reads and naming the rest. `get_merchant_rules` for one
merchant was 28,160 bytes because it returned all 236 rules; it is 1,136. A tool that returns 8.6k
tokens when asked anything is a tool the model drowns in.

**`get_transaction_full` was telling the model the wrong thing.** Its `counts_toward_totals` applied
only `excludedFromTotalsSql` and omitted both `pending = 0` and the category-tree scope exclusion, so
on the live July it claimed 112 of 120 rows counted when the real figure is 102: the eight $100
Fidelity contributions, a $780 cash deposit and a $5 Venmo transfer all read as ordinary spend. It now
evaluates the same generated predicate the doc publishes, and summing only the counted rows
reproduces `getSpendingReport.total` and the cashflow income exactly.

### The failure mode this round produced, five times

Every one of the four tracks shipped at least one **claim that exceeded what the code checked**:

- a clean bill of health that covered accounts the reconciliation never judged, so connecting a card
  produced "no account carries an unexplained residual" while never naming it;
- an investment note that told the model holdings were misfiled whenever an IRA held cash;
- a sentence explaining a residual's sign that was backwards for two of the three accounts it labels
  on the live ledger;
- flow-conservation copy asserting "one side is stored with the wrong sign" as a cause, when the
  detector establishes only that the rows are same-signed and unpaired;
- and measured figures baked into a source comment that no re-run could reproduce.

None of these are bugs in the ordinary sense and none would fail a test. They matter because this
prompt is the model's whole picture of the owner's finances, and a confident false sentence in it is
worse than an absent one. The rule now: **re-measure any figure you write into a comment, state the
query beside it, or delete it.**

### Also closed

`rulesOutranking` implemented two of the four keys of the resolution order, so an equal-length rule
pair could produce a single-rule write that the next whole-ledger re-check reverts, which is the
self-reverting trap the surrounding comment claimed was impossible. The order now exists once, as a
comparator, used by both paths. And `countMerchantRuleImpact` was called without the source the rule
would be written with, so the blast radius the owner is shown ("would relabel N transactions") was
computed as the wrong author: measured at 5 where the write relabels 0.

**The matcher was not changed, and that is a measured conclusion rather than a dodge.** Over 236 rules
x 1,297 distinct merchant names, every monotone tightening loses correct matches before it loses the
Uber Eats false positive: all 113 reverse-containment pairs on this ledger are endorsed by the owner's
own settled category and none disagree. The fix went where the evidence was instead, into precedence,
and cost zero correct matches. 18 healthy proposals go from refused to allowed.

---

## Phase 6.2, landed 2026-07-31

Three commits: `86c0017`, `34c8da4`, `89ac355`. **822 tests pass**, both typechecks clean,
`vite build` succeeds. Migrations 047, 048, 049.

**`ai_feedback` (047).** There was no record anywhere of the AI being wrong, and the reason was
structural: `undoAdvisorAction` wrote nothing, and `updateTransaction` cleared `category_action_id`
on a hand edit, which correctly protects undo and simultaneously erases the only evidence that the
model's answer was rejected. It now records from three sites: undo, manual override (written before
the clear), and draft dismissal. The row carries the merchant, what the model proposed and what the
owner chose instead, because a feedback row saying only "wrong" is worth very little. No confidence,
no score, no accuracy percentage: this is evidence, not a grade, and a test reads `PRAGMA table_info`
to keep it that way.

`stale` is nullable on purpose, and getting that right took a second pass. The first version computed
it from `isDraftStillActionable`, which only judges 5 of the 11 draft kinds and whose `default:`
branch returns "not judged" rather than "live". Six kinds were therefore recording `stale = 0`, which
migration 047's own header forbids in as many words: "Defaulting that to 0 would assert a check the
code did not perform." Liveness is now three states, and the six record NULL.

**Transaction field provenance (048).** `date_source` / `amount_source` / `merchant_name_source` plus
`transaction_field_revisions`, in the shape of migration 042. The requirement was never "let the
owner pin `amount`": pinning a money field the institution later revises leaves the ledger
permanently disagreeing with the balance it reconciles against. It is that **when the provider and
the owner disagree, that is recorded and visible rather than silently resolved either way.** The
overwrite still happens; the disagreement is now evidence.

This is also what the mis-signed Fidelity rows were waiting on. They still are not corrected, and
correcting them is now possible rather than indistinguishable from a report.

**`ai_memory` (049)**, visible, editable and deletable in Settings, carried into the prompt marked as
belief rather than measurement, with `superseded_by` so a belief that changed has a history.

### The validator that was wrong in both directions

The first version refused a statement carrying a derived figure. Verification found it refused
**"Maxes out the 401(k) before adding anything to the taxable brokerage"** (the pattern matched `401`
because `(` is a word boundary), along with `529`, `1099`, `403(b)`, "the 1st of each month" and "the
15th of each month". It accepted **"Spends about four hundred dollars a month on groceries"**,
"Keeps twelve thousand in the checking buffer" and "Carries 90 in revolving balance". The Settings
panel told the owner "Amounts, percentages and rates are refused"; the migration header and the panel
both promised a figure "cannot be read back as current", which `run_sql_query` disproves in one call
since it has no table allowlist.

**The validator is deleted rather than patched.** No pattern separates a durable disposition from a
figure that will go stale, and a refusal the owner trusts and that is wrong in both directions is
worse than none. Staleness is made harmless instead: every memory reaches the prompt with the date it
was recorded and the observation count behind it, and the section tells the model to read each
statement as of that date. Every piece of copy claiming a guarantee was rewritten to say what holds.

### Flagged issues, swept

Every item deferred during the rebuild was verified before being fixed, and two turned out to be
misdescribed:

- **A false sentence on a healthy balance sheet.** `Reports.tsx` computed `payable` by subtracting a
  subtraction, so on a sheet where cash fully covers the debt `remaining` came back as float dust and
  the page rendered "$0 would still be owed, with no cash left to reach it". Both halves false.
  Measured at the owner's own liquid balance: **73,738 of 529,149** whole-cent sheets. The payoff is
  settled in cents now, and a second reading defect surfaced while fixing it: whole-dollar formatting
  rendered a 40-cent shortfall as "$0 would still be owed".
- The two "stale" measured claims in `aiContext` turned out **not** to be stale. Both re-measure
  exactly. The real error was that one illustrated its point with a figure from a window the function
  does not cover.
- The negative-total note's guard was roots-only while the tree prints children, so a window three
  months from today hands the model `Entertainment / Movies` at -$15.48 with the explanation
  suppressed. Fixed the guard.
- `dataQuality` claimed "No account holds a settled transaction" while counting only visible ones.
- A guard refusal named a category by raw id; `sync-empty` fired forever on a manual-only install;
  `reconcileAccounts` could not distinguish "skipped" from "absent"; `budgetGroups.test.ts` built its
  own schema by hand, and it had drifted (REAL where production has been INTEGER cents since
  migration 022). All fixed. Seven em dashes swept.

**One correction to my own brief:** the concrete example I passed on for the payoff defect
(liquid $1,000, debt $10) does not reproduce; it returns exactly 0. The defect is real and the
smallest reproducing pairs are liquid $0.08 / debt $0.01, and at the owner's scale $5,291.49 / $0.03.

---

## Phase 6.3, landed 2026-07-31

Six commits: `3ffffef`, `8c35dde`, `7dd2958`, `797b89c`, `a943f7c`, `ecad696`. **950 tests pass**,
both typechecks clean, `vite build` succeeds. Migrations 050, 051, 052. Phase 6 is complete.

**The guard.** An autonomous batch is snapshotted, run, and re-checked against a conservation
invariant: **recategorizing is a reshuffle, not a change in magnitude.** The hard part was that "any
figure moved" cannot be the breach condition, since moving per-category totals is what the pass is
for. So each headline carries a movement policy (invariant / accounted / derived / evidence), the
accounted ones must move by exactly what the batch's own rows explain to the cent, and crossing into
a transfer category or across the income boundary is legitimate rather than a breach. On breach the
whole batch reverts, or it refuses and says so. No parallel SQL: every headline comes from the
service that already owns it.

**Autonomy is now three kinds, and it is structural.** `AUTONOMOUS_DRAFT_KINDS` was a `Set<string>`
anyone could push a line onto; it is derived from `DRAFT_KIND_AUTONOMY`, a
`Readonly<Record<AdvisorDraftActionKind, ...>>`, so a new kind that declares nothing is a compile
error and cannot default into autonomy by omission. Every proposal-only kind names the criteria it
fails. Your carve-out kinds carry `ownerCarveOut: true`, and the writes that have no draft kind
(category merge, delete, re-parent) are recorded too, so the carve-out is complete rather than as
complete as today's union.

Two kinds were added and five were judged and refused:

| kind | verdict |
|---|---|
| categorize_transaction, now including rows a rule or the heuristic filed | autonomous |
| create_merchant_rule | autonomous (unchanged) |
| retire_merchant_rule (new) | autonomous, only the model's own rules, only when the rule files zero rows |
| confirm_recurring | proposal-only: no exact inverse, nothing records that the model set it |
| set_sector_metadata | proposal-only: `setSecurityMetadata` overwrites with no record of the prior value |
| merchant-name normalisation | proposal-only for now |
| duplicate resolution, transfer confirmation | proposal-only |
| update_budget, update_goal_target, set_manual_cost_basis | proposal-only, your carve-out, always |

**The digest** shows every row the AI touched, row-level before and after, grouped by the action that
caused it, with revert-since-timestamp in one gesture. It plans the peel before executing it, so the
count it promises is the count it delivers.

### What three independent verification lenses found

I ran verification through three lenses on the autonomy work rather than one, and each found a
different real defect. All three converged on the same core one:

- **The auto-revert could not un-retire a rule.** `revertBatch` walked `transaction_category_revisions`
  only, so a breached batch containing a retirement was half-reverted and reported itself whole, into
  `ai_runs.invariant_breach`. That is precisely the state the design exists to prevent.
- **A fourth hand-listed set.** `Settings.tsx` held its own copy of the OLD autonomous set gating the
  Undo button, so a retirement rendered with no way to put it back, under a row promising "the ones
  you can put back". The server-side undo worked and was unreachable.
- **The owner-facing sentence was false.** "Categorizes transactions and writes merchant rules" after
  a third kind was added and the second widened. It is now generated from the same table the
  enforcement reads, as the model's sentence already was.
- **The prompt contradicted the widening in the same string:** a MUST saying transaction ids may only
  come from the uncategorized list, twelve lines above a new section inviting refiles. On this ledger
  the uncategorized list is empty, so the MUST pointed at nothing. The prompt now states one rule, and
  four tests assert it: **the prompt is the interface to the model and was the least tested surface in
  the system.**
- **`countTransactionsHeldByRule` took 1.65 seconds** on the real ledger, inside the write
  transaction, on the process serving the UI. Rewritten to ask each distinct merchant name once:
  **7.8 ms, about 210x, and still exact** (0 mismatches against a reference winner-resolution over
  all 234 live rules).
- **The chat tool path bypassed the guard entirely**, applying up to 200 categorizations with no
  conservation check and no run row, under the same `source = 'worker_auto'` label as the background
  pass. It now runs inside the guard, and the audit trail distinguishes the two.

### An oscillation the autonomy argument did not account for

`draftLiveness` lapses on `category_source = 'ai'` so a pass cannot re-answer its own answer hourly.
But "Re-check all transactions" rewrites the model's row back to the rule's category with source
`'rule'`, returning it to the pool. Decision, and it is a judgement rather than a bug fix: **the owner
pressing re-check is a deliberate reset and the model does not undo it, and separately the model gets
one answer per row, ever.** The pool now excludes any row carrying an AI revision, because the
revision log is durable where `category_source` is not. The cost is that a genuinely wrong rule stays
wrong after an explicit re-check; that is a state the owner chose and can still fix by hand.

---

## Phase 7b, landed 2026-07-31

Three commits: `b01baf8`, `f576faa`, `92a5272`. **1,039 tests pass**, both typechecks clean,
`vite build` succeeds. Phase 7 is complete.

**Type.** The scale was well built and unused: 380 of 424 step usages (89.6%) sat inside an 11.5 to
15px band and there was no `font-bold` anywhere. A new `Figure` primitive owns the money numeral at
four steps with real gaps, and the screen title stepped DOWN from 28px to 19px, because the title was
previously larger than every number on the page it headed and the nav rail already says where you
are. Both levers, not just the loud one.

**Elevation.** `e1`/`e2`/`e3` were keyed to a dark shadow, which is invisible on a dark ground, so the
whole ladder collapsed there. Each step now raises surface and border together, running away from
each ground, so the word means the same thing in both themes. The top rung deliberately stops raising
the surface on dark: measured, the surface it would have used puts `clay` at 3.41:1 and `muted-2` at
3.30:1, and a dialog is exactly the surface that carries money.

**Charts.** `TrendChart` autoscaled to its own min and max, so a $40 wobble and a $1,518 fall drew the
identical picture, and its x-axis was an array index, so a 31-day gap and a 1-day gap had the same
width. It now has a calibrated domain with a printed zero and a time-proportional axis, and it breaks
rather than joining across a gap it cannot justify.

**The motif.** The drawn scale is gone. Measured, `MAX_TILT_DEG = 9` meant the owner's whole recorded
history spanned **8.66px of pan travel**, and the measured month within it **5.13px**. Nobody can read
that. The calibrated beam puts the same measured month across **181px of a 1196px axis**. A position
on a labelled axis is a measurement; a rotation is a mood. The beam is also where degradation shows:
when a stage failed, or the sheet is stale, or coverage is partial, the whole primary reading goes
uncalibrated rather than a 7px dot changing colour in the corner.

### Three findings that were bigger than the brief

**A whole phase of work the running app never reached.** `backfillSnapshots()` reconstructs net-worth
history from the ledger, and Phase 4 rebuilt it substantially: per-account floors, an informativeness
gate, coverage per snapshot. **It had no caller in `server/src`.** Only `scripts/backfill/rebuild.ts`,
run by hand. So the recorded Phase 4 result, "5 estimated points becoming 16, oldest 2024-07-01", was
what the script produces and never what the database held. It is now conditioned on the data through
a persisted watermark, with an explicit owner rebuild beside it. On the real ledger: 5 replayed months
become 16, oldest 2026-02-01 becomes 2024-07-01, NULL coverage 5 becomes 0, and every measured row is
byte-identical afterwards.

The implementer's first predicate for it was "the ledger reaches below the oldest snapshot", which is
permanently true here (the ledger starts 2023-09-16, the oldest justifiable month is 2024-07-01,
because the months between are covered but uninformative and the walk correctly declines to emit
them). That would have re-run the reconstruction every hour forever. Caught by running it twice.

**A false count in owner-facing chart copy, pinned by a test.** The caption said "6 segments are
dotted" while 3 polylines were drawn: the number counted point-to-point transitions, which the merge
loop collapses. The test asserted the string by regex and never against the rendered segment count.
Now there is one entry per rendered polyline by construction, and the test parses the number back out
of the caption and compares it to what the geometry drew.

**Hazard 3's named instance could not fire.** Migration 044 populates `covered_accounts` only
`WHERE is_estimated = 0`, so every estimated row carries NULL, and the classifier needed a count on
both ends. The exact cliff the hazard names, estimated 2026-06-01 at 14 accounts against measured
2026-06-30 at 11, was classified as an ordinary estimate. **An unrecorded count is now a reason to
distinguish rather than an assumption of agreement**, and the copy claims only what is known: "only
one end records how many accounts were counted, so whether that number changed across it is not
known."

### Also caught

A `--mz-edge` token that put a **3.19:1 grey stripe across every primary button** on light while doing
nothing (1.03:1) on the surfaces it was designed for. A `cat-1..8` colour ramp shipping 16 CSS
properties and 8 config entries and emitting **zero utilities**, duplicated beside the 8 literal hexes
that actually render. A money numeral at **3.91:1** in `Investments.tsx`, failing AA. `trendGeometry`
returning a plausible geometry on unsorted input instead of raising. And three comment figures that
did not reproduce, including one the implementer's own report admitted it could not reproduce and
shipped anyway.

---

## Phase 8, landed 2026-07-31

Six commits: `9302305`, `9c2c4b5`, `51a4a9b`, `e008514`, `1938540`, `f28232e`. **1,317 tests pass**,
both typechecks clean, `vite build` succeeds. Migrations 053 and 054.

Twelve nav items are six: `/`, `/ledger`, `/accounts`, `/investments`, `/plan`, `/settings`.
**568 lines deleted** across twelve files, and the Advisor tab (290 lines) and Onboarding (139) are
gone rather than moved.

**`/` the instrument.** The consolidation argument turned out sharper than the plan had it: a window
is only meaningful for a FLOW. Net worth, held, owed and free are states at an instant, so a period
selector over them would claim a measurement the app cannot take. The surface splits into the
standing (windowless) and over this window (one selector). The evidence this is right rather than
fussy: `Reports.tsx` had already grown two independent range selectors without anyone naming why.
The 44px subject step went to what is free after every claim, not to net worth: a $4,202.86 net worth
does not answer "am I alright" and what is free does.

**`/ledger`.** The 30-day forecast sits above today's rule on the same date spine in estimate ink, so
a forecast reads as a continuation of the ledger rather than a separate promise. Review became a
filter because it always was one. `category_source` is finally on screen: 2,412 pre-provenance, 86
ai, 62 human, 12 heuristic, 7 rule, on the one surface where the owner would act on it.

**`/plan`.** Budgets and goals as one claim sheet, because both are money claimed in advance at two
horizons. Budget groups deleted end to end, including the three draft kinds, which is a type-level
change now that autonomy is a `Readonly<Record<AdvisorDraftActionKind, ...>>`.

**The nav.** `dot` on `rail` measured 1.70:1 in light, twelve times over. It is six right-aligned
words at 17px, labelled at every width, with a hairline leader in a fixed gutter pointing at the
active screen. A rule that points is a statement about position; a dot that changes colour is a
legend you have to learn.

### A defect found while consolidating, shipping in Reports until today

`getTopMerchantsReport` returns `SUM(ABS(amount))` per merchant and `SUM(-amount)` as its total. Two
different quantities. On July 2026 Amazon is $1,795.86 gross against a $1,112.99 total, so the share
rendered as **161%** and the bar drew 161% wide, silently clipped by `overflow-hidden`.

### The keyboard now has one owner, and that is the real outcome

Two separate rounds of verification found the same defect from two directions, and the second one was
introduced by the fix for the first:

1. `a` and `x` wrote to the ledger while a control had focus, because the guard tested `tagName`
   against a list and the Balance `Select` renders a `<button role="combobox">`.
2. The new `g` navigation chord collided with the ledger's `a`, and `preventDefault` is not
   `stopImmediatePropagation`, so **pressing `g` then `a` on /ledger navigated AND applied the AI
   categorization under the cursor**.
3. The ⌘K sheet did not neutralise the screen underneath. In digest mode focus fell to `<body>`, the
   ledger's focus test passed, and `a` applied an AI draft while the owner was reading the digest of
   what the AI had already done.

Three window-level listeners each deciding independently whether a keystroke was theirs is the shape
that produced all three, and a fourth condition would have produced a fourth. There is now ONE
dispatcher: it owns what is open (an overlay stack), what has focus (one rule per binding), and whose
keystroke it is (prefix consumption, then overlay > screen > app). All 12 chords live in one table,
`assertNoCollisions` runs at module import so a colliding table fails the app at boot, and a test
walks every file under `client/src` and requires exactly one to hold a global keydown listener.

Two more defects fell out of that audit: one Escape closed EVERY open dialog at once, and the ledger
had been compensating for the missing layer model with `showAddEntry || showAddScheduled || editing`,
an enumeration of the overlays it happened to know about, which is exactly why the sheet reached past
it.

### Seven capabilities were dropped, and the report enumerated two

The brief asked for all ten retired views to be walked. Verification found **seven** fetchers with
zero callers. Six were re-homed with an argument each, one was deleted with an argument:

- `aiApi.confirmDrafts` re-homed to the ledger's suggested filter. The endpoint answers 200 with a
  per-draft outcome even when guards refuse, so refusals arrive as a LIST; clicking Accept N times
  cannot produce that.
- `transactionsApi.markReview` re-homed as Set aside / Undo. `review_status = 'dismissed'` is read by
  three server queries and was set by nothing, so those clauses could never fire and the queue had no
  exit but filing the row. Distribution on the real ledger: open 153, reviewed 2,435, **dismissed 0**.
- `rulesApi.dismissSuggestion` and `approveSuggestions` re-homed. Approve-only was a one-way door, and
  a declined suggestion regenerated on every visit.
- `reportsApi.trends` and `networthAttribution` re-homed to the instrument.
- `aiApi.suggestCategories` **deleted**: applying its guesses goes through `bulkCategorizeTransactions`,
  which writes `source: 'human', markManual: true` and mints an owner rule per merchant. It would have
  stamped the model's guess as the owner's.

### Correction to record

The three dead preference rows are **not yet gone** from the live database. Migration 054 is well
formed and runs at next server start; `schema_migrations` tops out at 053 and all three rows are still
live, including `advisor_auto_apply_high_confidence = true`, which the model can read through
`run_sql_query`. The code half is clean.

---

## Phase 10, landed 2026-07-31

Two commits: `d34f98d` (SDKs, isolated per the dependency rule) and `d5d926a`. **1,352 tests pass**,
both typechecks clean, `vite build` succeeds.

Research first, build second: two spikes established what OpenAI and Gemini actually require before
any interface was designed, because a training prior on any of these three SDKs is stale.

**The seam was already right.** `MODEL_CAPABILITIES` and `buildModelRequestShape()` derive the request
from the model, and `ADVISOR_MODELS` is derived from the same table. Phase 10 added a provider
dimension to that table rather than a second source of truth beside it. `providerForModel` throws on
an unknown id rather than guessing, which matters because all three SDKs widen their model parameter
to `string`.

**Three genuinely different caching mechanisms behind one interface, without the interface lying about
any of them:**

| provider | mechanism | minimum | lifetime |
|---|---|---|---|
| Anthropic | one `cache_control` breakpoint on the system text | 512 to 4096 tokens by model | 5 minutes |
| OpenAI | explicit breakpoint on an `input_text` block plus a stable `prompt_cache_key` | 1024 tokens | 30 minutes minimum |
| Gemini | an explicit cache OBJECT with a lifecycle, created and deleted per request | 4096 tokens | 600s, or until the request ends |

Two things the spikes surfaced that a naive port would have got wrong. OpenAI's
`prompt_cache_breakpoint` exists on `ResponseInputText` and NOT on anything `instructions` can carry,
so moving the 18,000-character context into `input[0]` is forced rather than stylistic. And Gemini's
`caches.create` bills the prefix at the full input rate, so a single round that reads it back once
pays a write plus a read plus storage where an inline prompt pays one read: the cache is therefore
built lazily, only on the first round that actually asks for a tool.

**Cache accounting is inverted between providers and copying one line onto another would have
overstated uncached input by the whole prefix.** Anthropic's `input_tokens` excludes the cache fields;
OpenAI's `input_tokens` includes `cached_tokens`; Gemini's `promptTokenCount` includes
`cachedContentTokenCount`. Each adapter reconciles into one `ProviderUsage`, and that reconciliation
is a test rather than a comment.

**Every surface degrades legibly.** The effort dial renders from the selected MODEL's ladder, so
Gemini shows three rungs with a sentence saying so and a model with no ladder shows none. Gemini's
`ThinkingLevel` is MINIMAL/LOW/MEDIUM/HIGH, so `xhigh` and `max` are refused rather than silently
remapped onto `high`, which is the Phase 6.0 defect exactly. A model whose provider has no key is
listed and disabled with the missing credential named, because hiding it would make the owner wonder
where it went.

Keys share the existing AES-256-GCM envelope with the key in the OS keychain. No key is logged,
returned over the wire, or reachable by the wrong provider. `store: false` on both OpenAI paths keeps
the financial context off their servers, which their default would not.

### What verification caught

- **Gemini chat usage never accumulated across tool rounds.** `usage = { ...usage, ...readUsage(...) }`
  overwrites where the other two adapters add. Reproduced on a real two-round chat: reported 1,000
  uncached input tokens where the truth was 6,000, and after 8 rounds only round 8 counted. **This is
  the number that decides whether the design is affordable, and it erred by making the cache look
  about 6x better than it is.** Every Gemini test was single-round.
  The fix has a second trap in it: Gemini restates a running total per chunk rather than an increment,
  so summing chunks overcounts. Last-wins within a round, accumulate across rounds, and a test pins
  both halves.
- **`ai_runs.model` recorded the compile-time default, not the model the pass called.** With a per-job
  preference set to an OpenAI model, the request went to OpenAI and the audit row said Anthropic.
  Migration 051's own header says that column exists so a retiering is visible in the history, and
  Phase 10 shipped the retiering mechanism it could no longer see. Now resolved once and carried to
  all three consumers, so there is no second resolution site that can disagree.
- **The per-job model picker offered models whose provider had no key**, and the job then skipped
  silently forever: the credential gate returns before the run row is written, so there was no
  `ai_runs` row, nothing in the digest, nothing on any screen, one `console.log` an hour. The advisor
  picker already disabled unconfigured models; the job picker did not.
- **`$ref` and `$defs` were listed as hard errors under Anthropic's structured-output subset. They are
  documented as supported.** Both propagated into the portable union, so a future schema using either
  would have been rejected on all three providers for a reason none of them has.
- The OpenAI reasoning-summary hazard was wider than reported: it hit all three call sites, and on the
  two non-chat ones the summary was billed and never read.
- Gemini's caching copy told the owner the cache is "created per conversation and deleted when it
  ends", which is the wrong cost model for a cache created lazily inside one request.

## Phase 9, landed 2026-07-31

The plan defined Phase 9 as sweeping the 91 capped findings from the original audit for anything the
phases had not incidentally fixed. **That list was not recoverable** (it lived in a context window that
was compacted several sessions ago), and the code it described has since been almost entirely
rewritten, so restating it would have been a claim about work nobody could check. It was replaced by a
fresh six-lens audit of the codebase as it now stands: **26 findings raised, 3 refuted, 23 survived**
independent adversarial verification (9 high, 10 medium, 4 low).

Those 23 were fixed across four disjoint tracks, and then **every fix was refuted by an independent
agent that had not written it**. That second pass is the one worth recording:

| | claims upheld | overstated | refuted | regressions introduced |
|---|---|---|---|---|
| investments | 2 | 2 | 4 | 4 |
| ai writes and data | 4 | 4 | 1 | 4 |
| detectors and copy | 5 | 2 | 2 | 7 |
| client chrome | 6 | 1 | 1 | 3 |
| **total** | **17** | **9** | **8** | **18** |

**Eight of 23 fixes did not do what their own report said, and the fixes introduced 18 regressions
between them.** A round of fix-then-report, with tests passing and both typechecks clean, was wrong
about a third of what it claimed. This is the fifth round in a row where that held.

### The tests were the one thing nothing typechecked

`tests/` was in neither tsconfig project for the whole life of the repo. `tsconfig.json` covers
`client/src` and `shared`; `tsconfig.server.json` covers `server/src` and `shared`. The 1,545 tests
whose job is to assert the code is correct were the only files no compiler read.

Adding `tsconfig.tests.json` reported **27 errors**, and the ones that mattered were fixtures asserting
against fiction: `plaid_transaction_id`, `plaid_account_id`, `connection_type: 'plaid'` and
`scope: 'plaid_all'` on types migration 014 made unreachable in 2026, and a `route` field on
`TransactionReviewQueueSummary` that no server query has ever produced. CLAUDE.md had called the plaid
fixtures cosmetic. They were not cosmetic once a compiler looked at them: a test that builds a row the
database cannot hold is asserting against a shape that does not exist.

The `route` disagreement was resolved **against the test**. `getTransactionReviewSummary` constructs
all seven queues literally and emits no route on any of them, and `QUEUE_DESTINATIONS` in
`Instrument.tsx` is a total `Record<TransactionReviewQueueId, string | null>`, so a new queue that
declares no destination is a compile error there, where an optional server field would let one default
into nothing silently. Same structural argument as `DRAFT_KIND_AUTONOMY`. The gate is now four:
`npm test` plus `npm run typecheck` (three projects).

### What the second pass caught that the first pass had reported as fixed

- **The Investments hero and its own chart still disagreed, for a second reason.** The fix resolved one
  portfolio account set, but read it from `accounts` with no `is_hidden` filter while the series comes
  from breakdown JSON that `takeSnapshot` writes only for `is_hidden = 0`. Disconnecting Coinbase
  (`DELETE /api/coinbase/disconnect` sets `is_hidden = 1` and leaves `current_balance` alone) put the
  wallet in the headline and not in the series: hero $2,436.21 against a tail of $2,045.04, and a
  standing `+$391.17 since Jul 31` on a portfolio that had not moved. Two more cases reached the same
  split: `?endDate=` before the newest snapshot, and balances moving after the newest snapshot.
- **"Each surface says why" was a claim about comments.** The screen printed $2,436.21 and Cmd+K
  printed $2,045.04 for the same words, and the only text explaining the gap was a source comment
  neither the owner nor the model reads. The reconciling sentence is now rendered on both.
- **The reconciliation note fired on an ordinary healthy account.** Judging `holdings_value` against
  the headline meant an IRA funded and not yet invested read as a $500 discrepancy. It is judged
  against `invested_balance` now, and the uninvested balance gets its own line that accuses nothing.
- **A dismissal silenced the wrong rule.** `ownerDeclinedProposal` keyed a retirement on the rule's
  *pattern*, so declining to retire rule X for "Spotify" also silenced a proposal about rule Y on the
  same pattern. Keyed on rule id now, read back out of the dismissed draft's own payload. The fix
  carried its own hazard: `json_extract` raises on a non-JSON payload, which threw out of both the
  guard and the worker; both use `json_valid` now.
- **The declined-proposal suppression had no route back and nothing on screen said it existed.** A
  suggestion the owner turned down simply stopped appearing, permanently, with the code comment naming
  an escape hatch the UI could not reach. There is a "Suggestions you turned down" panel in Settings
  now, with `GET /api/ai/declined` and a restore that reopens the draft.
- **The write guard and the model's own pool disagreed about what one dismissal meant.** The guard
  refused per (row, category); the worker dropped the whole row. So declining "Coffee" for a row made
  that row invisible to every future pass rather than declining one category for it. The row stays in
  the pool now, annotated with the categories that are refused for it.
- **`unreconciled_residual` summed signed residuals under a sentence promising it is zero exactly when
  the list is empty.** Two unreconciled accounts at +$999 and -$999 published a clean bill of health.
  It sums magnitudes now, which makes the biconditional structurally true, because the filter that
  decides `unreconciled` requires magnitude past the tolerance.
- **The duplicate detector fired on an ordinary healthy event.** Newness was decided on the group id,
  which is a content hash: a pending duplicate pair posting, or a merchant rename, minted a new id and
  re-alarmed. Newness is decided on member transaction ids now. A third copy joining an established
  group used to be silent and is now reported once.
- **Two comments written in the same change set disagreed about one measurement** (the review backlog
  as 15 in `dataQuality` and 7 in `Instrument`). 15 is the raw `advisor_drafts` count; 7 is what
  survives `isDraftStillActionable`, and 7 is what the panel prints. Both now say which is which.
- **`index.css` claimed every `bg-rail` call site pairs it with `text-ink`.** A walker over the tree
  found **22 rail call sites, 9 of them setting a tone a light rail cannot carry**. The false universal
  is replaced by the measured allowance, and `tests/railGround.test.ts` fails both on a tenth site and
  on an entry that gets fixed without being delisted.
- **The selection ring the accounts fix made load-bearing was nullified by `opacity-55`.** `opacity`
  applies to `box-shadow`, so on a closed or hidden row (both of which can be the selected one) sage
  composited to 1.97:1 on light against a surface step of 1.13, and nothing marked which row the
  detail panel was describing.

### Figures that did not reproduce, restated with the query beside them

- The undo panel cap: reported as 78% of actions unreachable, measured at **65%** (142 actions, 92
  past the newest-50 window). The panel now serves all of them and states the drawing cap.
- `TrendChart` carried four stale measurements: the series is **32 rows, 16 estimated**, median gap
  **28 days** not 2, `joinLimit` 93 against a 274-day gap that **is** withheld so the line does break,
  the tightest drawn step **0.129%** not 0.55%, and 19 of 32 points inside the last 16.4% not 15 of 20.
- The estimated June sheet is **5521.48**, not the 3868.92 in the comment; `backfillSnapshots`
  recomputes estimated rows on every run.
- The largest step between two **measured** rows is -255052 on 2026-07-13; the larger -445319 crosses
  an estimated-to-measured boundary and is not the same quantity.

### Driven in a browser

Five screens at 1024, 1200 and 1440, both themes, no console errors and no horizontal overflow at any
width. The persisted partial-sync fault renders (`UNCALIBRATED  The last sync did not finish every
stage`), which is correct: the newest sheet was written by a run whose SimpleFIN stage returned
**402**, so 13 of its 14 balances are whatever the previous run left, and `covered_accounts = 14`
counts accounts the snapshot included, not accounts a provider refreshed. "What needs you" reads
**AI Insights 7** in the default tone rather than "Uncategorized 7" in alarm ink linking to a filter
holding none of them, and the ledger's "Model suggests" chip agrees with the queue at 7.

### Two things that exist only on this machine

`CLAUDE.md` is gitignored, so a fresh clone has no copy, no review ever sees an edit to it, and several
passages in it are the only surviving record of what a bug cost. That is unchanged and still undecided.
`.claude/hooks/migration-guard.sh` was in the same position and is now tracked: CLAUDE.md described it
as one of the two things that catch a migration-prefix collision, and it existed nowhere but here.

### Left open, deliberately

- **The Investments account set is resolved from today's `accounts` table and applied to every past
  breakdown.** Retyping a brokerage to `savings` moves the same two snapshots from $2,445.89 to
  $505.92, and the screen stays internally consistent while being historically false. Reproduced, not
  fixed. The honest fix freezes membership at snapshot-write time, which needs `snapshot.ts`, a
  migration and a backfill. The route comment states the limitation instead of claiming the set is
  right for history.
- **`deriveAssetBuckets` has no production caller.** `reports.ts` was the last one. It survives only
  because `tests/creditPosition.test.ts` is the sole remaining assertion that a card in credit carries
  as a negative liability through that path. Re-home it or delete it with its test.
- **The nine sub-AA `rail` call sites are recorded, not fixed**, in `tests/railGround.test.ts`, plus two
  on `pill-bg`. Each is a one-class fix in a file outside the track that found them.
- **A refused draft row is written on every pass** that re-proposes a declined category for a row.
  Nothing bounds the accumulation. The alternative, dropping the row, is the defect that was fixed.
