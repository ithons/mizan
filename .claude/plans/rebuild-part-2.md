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

- [ ] **Migration `ai_feedback`.** There is no record anywhere of the AI being wrong.
      `undoAdvisorAction` writes nothing; `updateTransaction` clears `category_action_id` on a hand
      edit, which protects undo and simultaneously erases the evidence. Written from three call
      sites: undo, manual override (before clearing), draft dismissal. Highest-value single addition
      in the design.
- [ ] **Migration `ai_memory`** (scope / subject / statement / kind / evidence_count /
      superseded_by), visible, editable and deletable in Settings, carrying the evidence that
      produced each entry.
- [ ] **Migrations `ai_runs`, `ai_incidents`, `ai_observations`, `ai_briefs`.**
- [ ] **Transaction field provenance.** The sync work protected a hand-edited `merchant_name` from
      provider overwrite using the row's own pending state and deliberately did not extend that to
      `date` / `amount`: pinning a money field the institution later revises would leave the ledger
      permanently disagreeing with the balance it reconciles against, with nothing on screen saying
      so. Doing it properly needs a `field_source` or edit-revision log shaped like migration 042.
      It belongs here, with the rest of the provenance work — and 5b.4 is the case that proves the
      need, because without it a corrected amount is indistinguishable from a reported one.

**6.3 What the model may do.**

- [ ] **`aiGuards.ts`**: snapshot the headline set (net worth, month spend, month income, savings
      rate, 60-day scheduled net, per-category totals) before an autonomous batch, re-run the
      invariants after, diff, and auto-revert the whole batch by action id on breach.
- [ ] **`aiJobs.ts` + `aiScheduler.ts`**: named jobs with a declared
      `{trigger, model, effort, writes, invariants, digestSection}`. Move the worker kickoff into a
      `finally` so a partial sync still triggers a pass (today it sits after `if (deferredError)
      throw`).
- [ ] Emit an SSE event when a background pass applies anything, so the client stops rendering
      pre-AI category totals for up to 5 minutes.
- [ ] **Expanded autonomous writes**: recategorize beyond uncategorized (never `human`), update and
      retire merchant rules, security metadata, merchant-name normalisation (with `original_name`
      immutable), exact-match duplicate resolution, equal-and-opposite transfer confirmation,
      recurring confirmation at 4+ occurrences.
- [ ] **Proposal-only, per the owner's carve-out**: `update_budget`, `update_goal_target`,
      `set_manual_cost_basis`, category merge / delete / re-parent.
- [ ] **`GET /api/ai/digest`**: diff-shaped and complete, row-level before/after, one-click
      revert-since-timestamp. Not a summary.
- [ ] Chat loads history server-side from `conversationId` rather than trusting the client array.
- [ ] Tests: `aiMemory`, `aiFeedback`, `aiGuards`, autonomy boundary.

---

## Phase 7b — Finish the design system

- [ ] **Type**: open the range. The scale exists and is well built; it is unused above 17px and
      unused in weight. 422 of 466 type-step usages sit in an 11.5–15px band; 0 `font-bold`.
- [ ] **Elevation** that works on a dark ground: shadow stops being the mechanism and value
      separation takes over.
- [ ] **Charts**: `TrendChart` autoscales to its own min/max, so a $40 wobble and the real $1,518
      July fall draw the identical picture, and its x-axis is an array index, so a 5-month gap and a
      1-day gap have the same width. Calibrated scale with a printed zero; time-proportional x.
      Load the `dataviz` skill before touching chart colour.
- [ ] **The motif.** Transform, do not kill: mīzān *is* balance. `MAX_TILT_DEG = 9` and the real
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

- [ ] ~27 hardcoded hexes in views (category and chart colours) do not follow the theme and will look
      wrong on the dark ground. Route them through tokens.
- [ ] `shadow-e1-alt` is used 5 times and is not defined in `tailwind.config.js` — a dead utility
      emitting no CSS.
- [ ] `Today.tsx` uses `text-faint` on two strings; `faint` is documented non-text (3.26:1 light,
      4.10:1 dark) and is the one token deliberately below AA.
- [ ] U+2192 (used in 8 files) is in neither font subset and falls back to the system stack.
- [ ] Instrument Sans italic is not shipped; the two italic strings in Advisor synthesize oblique.

---

## Phase 8 — Screen consolidation, 12 items to 6

- [ ] **`/` the instrument** absorbs Today, Cash Flow and Reports. Reports and Cash Flow become a
      *time window* on one surface, not separate screens: one selector reshapes the same query set.
      Removes ~660 lines of duplicated view code and the possibility of two screens disagreeing about
      net worth, which `Reports.tsx` already carries a comment about having shipped once.
- [ ] **`/ledger`** absorbs Transactions, Review and Bills. Bills dies for a structural reason: a
      bill is a transaction that has not happened yet, and giving future money its own screen is the
      mechanism by which forecasts get read as facts. The 30-day forecast sits at the top of the
      ledger, above today's rule, on the same date spine, in estimate ink. Review dies as a filter
      because it is a filter. Row flags include `category_source`, recorded per row and rendered
      nowhere.
- [ ] **`/accounts`** absorbs AccountDetail.
- [ ] **`/investments`** stays its own screen (owner's decision, 2026-07-30).
- [ ] **`/plan`** absorbs Budget and Goals.
- [ ] **`/settings`** absorbs Onboarding, an orphan route nothing links to in an always-logged-in
      single-owner app.
- [ ] **Advisor stops being a tab.** ⌘K becomes the only conversational surface, as a sheet over the
      current screen so an answer arrives beside the data it is about. Drafts attach to the row they
      are about: a suggested category renders inline in the ledger row in estimate ink with a one-key
      accept. 251 drafts and 140 applied actions have never once been visible next to the data they
      modified.
- [ ] **Delete budget groups** end to end: both tables are empty after three weeks in an app with one
      budget. 115 lines of service, five routes, a 120-line modal, the memo machinery, four fetchers,
      one test file.
- [ ] **Delete three dead preference keys**: `dashboard_layout`, `custom_report_views`, and
      `advisor_auto_apply_high_confidence`. The third reads `true`, asserting a confidence-gated
      autonomy policy removed in `f61109b`, and the model can read it through `run_sql_query`.
- [ ] **Nav**: six words, labelled at every width. Today every label is behind `xl:block`, so under
      1280px the entire navigation is twelve identical 7px dots at 1.6:1 contrast. Un-hijack ⌘R and
      ⌘P, currently `preventDefault`ed for Review and Reports, killing reload and print.
- [ ] **Catch-all route.** There is no `path="*"`, so a typo renders a blank page.
- [ ] Sub-500px is explicitly out of scope: `localGuard` binds this to loopback, so it is a desktop
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

## Phase 9 — Verification

- [ ] Full suite plus both typechecks.
- [ ] Run the reconciliation invariant against the real database and record the residuals.
- [ ] Re-derive every headline figure named in both plan files from the live DB and confirm it
      matches what the UI renders.
- [ ] Drive the app and verify both themes at 1440 / 1280 / 1024.
- [ ] Sweep the 91 capped findings from the original audit for anything the phases did not
      incidentally fix.
- [ ] Convert the remaining hand-written test schemas to `migratedTestDb()`.
- [ ] Update `CLAUDE.md`, and note that it is currently gitignored and therefore unversioned.

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
