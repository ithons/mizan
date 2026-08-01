# mizān rebuild — plan (part I)

**Everything still open now lives in `rebuild-part-2.md`.** This file remains the record of what the
audit found and what Phases 0–5 and 7 shipped. Two of its entries were later found to be mis-framed
and are corrected there: the Chase Checking residual is a reconciliation horizon artifact rather than
a missing payroll, and the crypto cost basis is blocked on missing units rather than on a lot policy.

Written 2026-07-30. Basis: a 58-agent audit (9 subsystem auditors, per-finding adversarial
refutation, a completeness critic) plus direct verification against the live `.mizan/mizan.db`
(2,579 transactions, 2023-09-16 to 2026-07-28, 14 accounts, 236 merchant rules, 140 applied AI
actions, 1 budget, 1 goal, 19 net-worth snapshots).

36 findings survived refutation; 9 were killed; 91 non-low findings were carried forward
unverified because verification was capped at 5 per auditor. The critic deduplicated 36 confirmed
findings down to roughly 27 distinct defects.

Baseline at start: 374 tests pass, both typechecks clean, 45 uncommitted files from the previous
session's UI Phase 0–1.

---

## The structural finding

This codebase does not correct defects by changing the write path. It corrects them by running a
one-off repair against the live database, then leaves the write path alone. Migration 033 taught
"reassign holdings_history before deleting an account"; migration 039 taught "fold deleted account
ids out of historical breakdowns"; neither lesson is in `mergeAccounts` or `deleteAccount`.
Migration 040 deleted baseless estimated snapshots on 2026-07-25T02:34, and
`scripts/backfill/rebuild.ts` regenerated five of them on 2026-07-27T22:22. Migration 020 is the one
repair that also got a guard and a regression test, and it is the one that still holds.

**Every phase below that fixes a repair-shaped bug must land the invariant in the service, not just
the data fix.** That is the single rule this plan is organised around.

The second cross-cutting gap: `transactionFilters.ts` was extracted so "what counts as spend" could
not drift, and it covers only transfer/duplicate status. The polarity half (amount sign ×
`is_income` × `is_investment` × excluded roots) is hand-written in seven places with at least three
different semantics. Phase 2 finishes that extraction.

---

## Decisions taken (2026-07-30)

| Question | Answer |
|---|---|
| Palette | Build **both** light and dark with a real toggle. Fix the value-range and inverted-chroma problems in both. |
| Structure | Consolidate 12 nav items down to **6**, but keep Investments as its own screen. |
| AI autonomy | Keep the carve-out: `update_budget`, `update_goal_target`, `set_manual_cost_basis`, category merge/delete stay proposal-only. Everything else becomes autonomous. |
| Commits | Baseline commit first, then one commit per completed phase, staged by explicit path. Dependency changes land isolated. |

---

## Order, and why

Phases are ordered by *what is actively getting worse*, then by what unblocks what.

1. **Phase 1 first** because the AI worker is rewriting the ledger every hour and each pass destroys
   the previous pass's undo chain. This compounds; nothing else does.
2. **Phase 2 next** because those are wrong numbers on screens being read today, and because
   finishing the shared-predicate extraction is what stops the class from recurring.
3. **Phase 3** before any AI expansion, because widening write authority on top of a 33%-inflated
   burn rate and unmarked estimates amplifies the error rather than replacing it.
4. **Phase 4–5** are the integrity and honesty layers the UI will render.
5. **Phase 6** expands AI only after 1–5 make its inputs true and its writes reversible.
6. **Phase 7–8** are last because the UI should render numbers that are already correct, and because
   view files touched by earlier phases get consolidated here rather than edited twice.
7. **Phase 9** verifies the whole thing against the real database.

---

## Phase 0 — Baseline

- [x] Commit the 45 in-flight UI files as one baseline commit
- [x] Confirm 374 tests + both typechecks green (done: green at plan time)

---

## Phase 1 — Stop the ledger being rewritten

The AI worker has written 12 Spotify rules across 2 categories, 8 Trupanion rules, and 7 Backblaze
rules across 2 categories. On 2026-07-29 it set `Spotify → cat_ent_streaming` at 18:04 and
`Spotify → cat_subscriptions` at 20:04. Every matching row flipped twice in two hours with no UI
signal. Root cause: the model has never been shown `merchant_rules`, so it proposes blind on every
sync. Each pass sets `category_previous_id = category_id`, so the earlier action becomes
un-undoable and "previous" points at the AI's own prior guess rather than the pre-AI truth.

- [x] Migration: `merchant_rules` gains `source`, `action_id`, `created_by`, `retired_at`
- [x] Migration: `merchant_rule_revisions` (append-only: rule_id, from_category, to_category, source, action_id, at)
- [x] Migration: `transaction_category_revisions` (append-only, so undo walks back to the last non-AI value)
- [x] `upsertMerchantRule` refuses to silently change an existing rule's category; records a revision instead
- [x] Merchant-rule patterns normalise case so "Spotify" and "spotify" are one rule, not two
- [x] `confirmCategorizeTransaction` hard-refuses `category_source = 'human'` / `manually_categorized = 1`, returned as a per-row skip
- [x] `confirmMerchantRule` applies with `onlyUncategorized: false, skipManual: true` so the action has a real blast radius and a real undo
- [x] `routes/ai.ts` stops asserting a hand-edit cause it never verified on `nothing_to_undo`
- [x] Blast-radius caps in code: refuse patterns under 5 chars, refuse a single action touching more than N rows, refuse a rule whose category disagrees with the majority category of rows it already matches
- [x] `getTransactionReviewSummary` drops open drafts whose target is no longer actionable (14 immortal drafts today, 3 pointing at the deleted `cat_shop_general`)
- [x] `aiContext` gains an existing-rules summary so the model stops proposing blind
- [x] Tests: `aiWriteGuards.test.ts` (human rows never overwritten, caps enforced), `merchantRuleRevisions.test.ts`
- [x] ~~One-time repair for the 12 duplicate rules~~ **CORRECTED 2026-07-30:** `upsertMerchantRule` already deduped on `lower(pattern)`, so there was exactly ONE Spotify rule, not twelve. The twelve were twelve ACTIONS repeatedly upserting that one row and flipping its category. No duplicate rows existed to repair; the defect was entirely in the write path, which is now fixed and schema-enforced.

---

## Phase 2 — Wrong numbers on screen

- [x] **Finish the shared predicate.** `transactionFilters.ts` gains `spendPredicate()` / `incomePredicate()` owning the polarity half. Replace all seven hand-written copies (`reporting.ts:288`, `budgetProjection.ts:112`, `:269`, `anomalyInsights.ts:60`, `:102`, `aiContext.ts:380`, `subscriptionInsights.ts:138`).
- [x] **Refunds.** `getCashflowReport` sums signed amounts per category class so a refund nets down instead of vanishing. July 2026 currently shows net −$665.24 / savings rate −31% where the truth is +$1,389.00 / +64%. 53 rows / $6,267.43 ledger-wide. Same fix in `getSpendingReport` and `budgetProjection` (a returned $955.19 Amazon purchase currently consumes the Shopping budget permanently).
- [x] **`anomalyInsights` duplicate half.** It inlines the transfer clause and omits the duplicate clause. Subsumed by the predicate extraction above.
- [x] **Cash Flow month param.** `CashFlow.tsx:35` sends `?month=`; `routes/reports.ts:135` drops it; the panel renders $80,798.16 under a heading that says July ($2,836.46). Fix the call site now; the view is consolidated away in Phase 8. Delete `month` from `ReportParams`.
- [x] **Cost basis of literal 0 is unknown, not zero.** `simplefin.ts:79` stores 0 for SPAXX money-market sweeps; `investmentMetadata.ts:70` labels it `'provider'`; `investmentAnalytics.ts:139` counts it as known. Header reads ▲$141.82 / 7.1% where the truth across positions with a real basis is $36.83 / 1.8%. Fix ingest + the aggregate predicate + a migration nulling existing zero-basis rows.
- [x] **Free to spend ignores every credit card.** `safeToSpend.ts` computes `liquid − bills − budgets − goals`, rendering $4,226 beneath "Owed $5,653.71" with $5,291.49 liquid. Move to a shared service, subtract card balances, render as an explainable subtraction. Delete the docstring's reference to a server-side metric that does not exist (removed in `a1412db`).
- [ ] **Rounded money that does not add up.** MOVED TO PHASE 7: this is a typographic decision about which figures are checkable against each other, and it belongs with the type system rather than ahead of it.
- [ ] ~~(original entry)~~ **Rounded money that does not add up.** 81 `formatWholeCurrency` call sites vs 15 `formatCurrency`. Today's month rule renders out/in/net as three independent whole-dollar roundings, so the first minus the second need not equal the third. Establish the rule: exact everywhere a figure can be checked against another figure.
- [x] **`flattenReportCategories`** returns `previous: 0, delta: <full amount>` for every category, so `top_spending[i].delta` claims every category is brand new.
- [x] **Savings rate** (MOVED TO PHASE 5, with the rest of the unknown-versus-zero class) returns 0 for a no-income window, so the first fortnight of every month reports 0%.
- [x] Tests for each, asserting against the real ledger's shape

**Consequence of the refunds fix, discovered on real data (2026-07-30):** a category can now legitimately
report a NEGATIVE total when a month's credits exceed its purchases. On the live ledger July 2026
Shopping is **−$1,203.63**, because $1,772.93 of Amazon credits and a $281.29 REI return land in a
month with few Shopping purchases. That is the truth and it must be rendered as such, not floored at
zero. Phase 7/8 must handle it: `ProgressBar` cannot take a negative width, a share-of-total
percentage against a signed total is meaningless, and a "top spending" list sorted by amount puts
the biggest credit last. Verified at the same time: July spending total ($782.22) now equals
cashflow expenses ($782.22) exactly, so the two surfaces reconcile for the first time.

---

## Phase 3 — What the AI is told

- [x] **The "3-month average" divides four months by three.** `aiContext.ts:319`. Window is Apr 1–Jul 29 (four `strftime` buckets), divided by the literal 3. Model is told income $4,396/mo and expenses $5,189/mo where the four-month truth is $3,297 and $3,892. Fix by making the range the three complete months the label promises (`endOfMonth(subMonths(today,1))`), not by dividing by `months.length`, which still blends a partial month.
- [x] **Provenance as a mechanism, not per-consumer patches.** `is_estimated` appears in six places in the whole codebase and reaches Reports/Accounts only because `routes/networth.ts:53` happens to `SELECT *`. Introduce a single snapshot read path that always carries it, and make the type non-optional so a consumer cannot silently drop it. Fixes the AI trend, `get_net_worth_history`, `AccountDetail`'s balance chart, and the Investments chart in one move.
- [x] The system prompt instructs the model to flag estimates; give it the flag it is being asked to use
- [x] **Holdings `LIMIT 15` totals.** `totalPortfolio`, `totalCostBasis`, `totalReturn` and the whole asset-mix percentage table are computed from a truncated slice and printed as the portfolio total. Correct today by luck (14 holdings).
- [x] **Three disagreeing investment totals** coexist on the same data: $2,044.62 (account balances), $2,144.62 (holdings sum), $2,443.67 (balances of accounts holding holdings). Two appear in the same prompt.
- [x] `formatMoney` renders to the cent on purpose; confirmed nothing else in the AI path abbreviates
- [x] Test: `aiContextNumbers.test.ts` asserts the divisor and that estimated rows are marked

---

## Phase 4 — History that stops decaying

**Status 2026-07-30:** snapshot buckets, net-worth attribution, merge/delete and the backup closure
are done and committed. Per-account estimation floors and the sync-integrity set are in flight.

- [x] **Snapshot buckets are frozen classification.** `snapshot.ts:74` computes liquid/investment/crypto from `accounts.type` at write time and never recomputes. Your two Fidelity accounts were auto-typed `checking` then retyped, so 2026-06-30 and 07-01 record `investment_assets = 0` for a portfolio holding $1,661.66, and the Investments chart plots $2,441.93 → $0.00 → $0.00 → $1,665.86. Derive buckets at query time from each snapshot's `breakdown` JSON joined to current account types.
- [x] **Net-worth attribution** reads today's `is_liability` against balances frozen months ago, so retyping re-signs history while the headline does not move, and a deleted account is silently an asset. That is the condition migration 039 repaired by hand.
- [x] **One new card truncates 2.5 years.** `estimateFloorMonth` takes the *maximum* first-transaction date across value-holding accounts, so Chase Freedom Flex (opened 2026-03-10) caps the whole walk. 2,198 imported transactions reaching 2023-09-16 produce five estimated points. Move to per-account floors with the partial-coverage band stated explicitly rather than drawn as one continuous line.
- [x] Purge estimated snapshots that fall below a later, higher floor (one already exists at 2026-02-01)
- [x] **`mergeAccounts` / `deleteAccount` learn the 033 and 039 lessons**: reassign `holdings_history` (currently `ON DELETE CASCADE`, so deletion destroys exactly what 033 rebuilt by hand), and fold the removed account id out of every historical `breakdown`. Also fix the `simplefin_account_id` UNIQUE collision in `mergeAccounts` (writes the source id onto the target before deleting the source).
- [x] **Backup is not a backup.** `LOCAL_BACKUP_TABLES` covers 17 of 26 while the preview reports "Ready, 17/18, zero warnings". Missing 9 tables / 587 rows: `holdings_history`, `advisor_actions`, `advisor_drafts`, `conversations`, `messages`, `budget_groups`, `budget_group_members`, `budget_rollover_ledger`, `recurring_occurrence_adjustments`. After restore the 86 rows carrying `category_action_id` point at nothing and undo 404s. Make the set FK-closed, in parent-before-child order, and tolerate a missing table key as empty-plus-warning rather than a fatal 400.
- [x] **Sync integrity**: a 200 with no `accounts` key zeroes all nine balances and reports success (bail when `seenAccountIds.size === 0`); a partial sync throws before `sync_complete` so the client never invalidates; `simplefin.ts:362` unconditionally overwrites hand-edited `date`/`amount`/`merchant_name` that `UpdateTransactionSchema` explicitly permits editing; 123 unchanged rows count as "modified" every hour; benign SimpleFIN `errors` strings (including the date-range-capped notice our own 730-day resync guarantees) trigger the destructive reconnect prompt.
- [ ] `GET /api/budgets/rollover-ledger` writes on every read and re-derives past months from the budget's *current* amount. Split read from write; the guard exempts GET from the origin check precisely because GETs were assumed not to mutate.
- [ ] Regression test per repaired invariant, not just per data fix

---

## Phase 5 — Derived numbers that earn belief

- [x] **Recurring patterns get a category.** `recurring.ts:279-295` never writes `category_id`, so all 11 rows are NULL, so `budgetProjection.ts:186`'s `IS NOT NULL` filter means `expected_recurring` is always 0 and `forecast_confidence` always `'none'`. The budget projection shipped in `9c565ba` renders nothing on real data. Majority category with a clear-majority requirement; ties record NULL.
- [x] **Recurring amounts from a recent window, with drift shown.** Payroll stores `average_amount = 39893` while the last four occurrences are all `54418` and the forecast's own AVG gives `47691`. Two disagreeing "expected amount" values both render on Bills.
- [x] **Recurring dates.** Detection anchors `next_expected` at `last_seen + rounded median gap` instead of day-of-month, so Backblaze (charges on the 17th) is forecast 2026-08-16 and flagged overdue on its real due date. Chained `addMonths` clamps a 31st-anchored bill to the 28th and never recovers. `daysUntil` is a wall-clock delta, so from local noon every countdown is a day short and contradicts its own calendar-derived `status`.
- [ ] **Ledger-derived daily balance history** for deposit and credit accounts: today's balance minus every later transaction. Consistent with the ledger by construction, kills the invented cliffs and the six-day July hole, and removes the "was the app running that day" dependency. Snapshots stay as measured anchors, drawn marked. Market-driven accounts keep the documented reverse-replay treatment.
- [x] **Reconciliation invariant**: per account, per window, balance delta versus summed transactions, reported as an unexplained residual. Nothing in the app checks this today. Must use a cumulative multi-window horizon or it will scream on healthy accounts.
- [ ] **Surface the data-quality layer that already exists.** `getDataQualitySummary` composes sync health, review backlog, forecast confidence, exclusions and the invariants; `routes/insights.ts:98` serves it; `insightsApi.quality()` is defined; nothing renders it. Render the issue list, not the score.
- [ ] **Brokerage contribution sign.** Fidelity Individual carries "Electronic Funds Transfer Received (Cash)" rows at `amount = -10000` on four July dates; your own `data/fidelity/` export shows `+100`. Four contributions a month read as $400 leaving the household. Pair with the matching Chase Checking outflow as transfers.
- [ ] **Crypto cost basis** from the buy/sell rows already in the ledger (all 8 Coinbase holdings are NULL while the README claims crypto tracks unrealized gain). Needs a stated lot policy: a 2025-09-04 BTC sell already exists, so sum-of-buys is wrong.
- [ ] **Transfer detection** gives each transaction one chance to pair before categorization makes it permanently ineligible

---

## Phase 6 — AI as structural

Boundary confirmed 2026-07-30: a write earns autonomy when it is an observation about data that
already exists, has an exact mechanical inverse, has a bounded and enumerable blast radius, and does
not overwrite a number the owner set.

- [ ] **`schemaDoc.ts`**: a curated semantic dictionary, versioned in the repo. Per-column units with the REAL-dollar price exceptions named as exceptions; sign conventions (liabilities stored positive but subtracted; refunds are positive rows inside expense categories and are not income); the literal text of the spend/income predicates to paste; enum meanings (`category_source` NULL means pre-provenance, not zero); time semantics (dates are local `yyyy-MM-dd`, `created_at` is ISO UTC, SQLite's `date('now')` is UTC and disagrees with our month boundaries, so supply today's local date as a literal).
- [ ] Read-only SQL gets a wall-clock kill and a row cap. It is write-proof but not time-proof; model SQL can currently freeze the single-process app.
- [ ] New typed read tools: `get_merchant_rules`, `get_my_action_history`, `get_holding_history`, `get_sync_runs`, `get_provenance_summary`, `get_transaction_full`
- [ ] `aiContext` gains the sections it never had: existing rules, provenance distribution (2,412 of 2,579 rows are `category_source` NULL), its own recent actions and their outcomes, full temporal reach instead of a 3-month average and 15 rows
- [ ] **Transaction field provenance.** The sync workstream protected a hand-edited `merchant_name` from provider overwrite using the row's own pending state, and deliberately did NOT extend that to `date`/`amount`: pinning a money field the institution later revised (a tip adjustment, a partial reversal, a corrected post date) would leave the ledger permanently disagreeing with the balance it reconciles against, with nothing on screen saying so. Doing it properly needs a `field_source` or edit-revision log in the shape of migration 042. That belongs here, with the rest of the provenance work.
- [ ] **Migration: `ai_feedback`.** There is currently no record anywhere of the AI being wrong. `undoAdvisorAction` writes nothing; `updateTransaction` clears `category_action_id` on a hand edit, which protects undo and simultaneously erases the evidence. Written from three call sites: undo, manual override (before clearing), draft dismissal. Highest-value single addition in the design.
- [ ] **Migration: `ai_memory`** (scope/subject/statement/kind/evidence_count/superseded_by), visible, editable and deletable in Settings, carrying the evidence that produced each entry
- [x] **Migration: `ai_runs`, `ai_incidents`.** Shipped as migrations 051 and 050. `ai_observations`
      and `ai_briefs` were named on this line and nowhere else, were never given a stated purpose in
      any plan file, and are **dropped, decided 2026-08-01**. The argument and its measurements are
      in `relink-and-close.md` Phase 4; the short form is that the "have I already said this" job an
      observations log would have done is already done by the write record itself
      (`transaction_category_revisions.to_source = 'ai'` and `ai_feedback` joined to
      `advisor_drafts`), that a stored brief can disagree with a ledger the on-demand digest
      recomputes against, and that the part of an observation log that is genuinely missing is
      missing upstream of any table: the worker's output contract accepts drafts only, so an
      observation carrying no action has no channel to be written from. This line is closed. Do not
      re-open it without reading that phase first.
- [ ] **`aiGuards.ts`**: snapshot the headline set (net worth, month spend, month income, savings rate, 60-day scheduled net, per-category totals) before an autonomous batch, re-run the invariants after, diff, and auto-revert the whole batch by action id on breach
- [ ] **`aiJobs.ts` + `aiScheduler.ts`**: named jobs with declared `{trigger, model, effort, writes, invariants, digestSection}`. Move the worker kickoff into a `finally` so a partial sync still triggers a pass (today it sits after `if (deferredError) throw`).
- [ ] Emit an SSE event when the background pass applies anything, so the client stops rendering pre-AI category totals for up to 5 minutes
- [ ] **Expanded autonomous writes**: recategorize beyond uncategorized (never `human`), update/retire merchant rules, security metadata, merchant-name normalization (with `original_name` immutable), exact-match duplicate resolution, equal-and-opposite transfer confirmation, recurring confirmation at 4+ occurrences
- [ ] **Proposal-only, per the carve-out**: `update_budget`, `update_goal_target`, `set_manual_cost_basis`, category merge/delete/re-parent
- [ ] **`GET /api/ai/digest`**: diff-shaped and complete, row-level before/after, one-click revert-since-timestamp. Not a summary.
- [ ] **Model tiering.** Delete `temperature: 0.1` from `aiWorker.ts:160` and `aiCategorySuggest.ts:62` (sampling params return 400 on Sonnet 5 and Opus 5; it works today only because both call Haiku 4.5). Update `ADVISOR_MODELS` from `claude-opus-4-8` to `claude-opus-5`. Extend `ADVISOR_EFFORTS` to include `xhigh` and `max`. Replace the fence-strip-and-`JSON.parse` trust boundary with `output_config.format` json_schema, keeping Zod behind it as defence in depth. Per-job assignment: Sonnet 5 medium as the baseline, Haiku 4.5 for bulk classification and near-lookup work, Opus 5 for self-audit and monthly synthesis.
- [ ] Chat loads history server-side from `conversationId` rather than trusting the client array
- [ ] Tests: `aiMemory`, `aiFeedback`, `aiGuards`, autonomy boundary

---

## Phase 7 — Design system, both themes

Diagnosis, measured: 12 neutral tokens inside 25 L\* points, then a 19-point hole. `card` on `paper`
is 1.072:1, `rail` on `paper` 1.046:1, `line-2` on `card` 1.283:1, so a surface is defined entirely
by a hairline. OKLCh hues cluster at 76–87 across paper, card, ink, muted, line, track, beam, tan
*and* gold, so the caution colour is a saturated version of the background's own hue. Chroma is
inverted: `sage` C=0.045 against `tan` C=0.060 and `gold` C=0.123, so the colour carrying income and
assets is less saturated than a decorative fill. 422 of 466 type-step usages (90.5%) sit in an
11.5–15px band; 0 `font-bold`.

- [x] **Themeable token architecture.** Keep the channel-triplet mechanism exactly (`--mz-x-c` space-separated RGB consumed as `rgb(var(--mz-x-c) / <alpha-value>)`, `--mz-x` composed for the ~32 raw `var()` references in inline styles and SVG). Swap only the triplets under `:root[data-theme="dark"]` and a `prefers-color-scheme` default; the composed aliases follow for free. Never collapse a token to a bare `var()` or a single hex.
- [x] **Dark ground** at ~L\* 13 keeping paper's hue (OKLCh h≈80) so it reads as ink and oiled brass. 83 points of runway above it for panel / card / hover / selected / live / estimate.
- [x] **Light ground** rebuilt: drop paper to ~L\* 88 so there is genuine elevation above it rather than six points of runway.
- [x] **Fix inverted chroma in both**: the semantic accent must out-saturate the furniture, and gold must leave the background's hue family.
- [x] **Estimate ink** as a first-class token in both themes, achromatic and cooler, so an estimate is structurally distinguishable from a measurement rather than distinguished by a hover tooltip.
- [x] **Theme toggle** in Settings, replacing the inert `Appearance: Light` row. Persisted in `app_preferences`, applied before first paint to avoid a flash.
- [x] **Contrast verification for both themes**, on money numerals specifically, with the results recorded in the file the way the current `index.css` records the last ramp fix.
- [x] **Self-host the fonts.** `index.css:1` is a bare `@import` from `fonts.googleapis.com`: a loopback-bound local-first finance app calling Google on every cold load, and typographically naked offline. Zero `@font-face`, no `client/public`, no `.woff2` in the repo. Also: the import fetches JetBrains Mono 400;500 while `Today.tsx:235` sets `font-light` (300) on the net-worth hero, so the most important number in the app asks for a face that was never downloaded. Subset and self-host; this lands as its own commit.
- [ ] **Type**: open the range. The scale exists and is well built; it is simply unused above 17px and unused in weight.
- [ ] **Elevation** that works on a dark ground (shadow stops being the mechanism; value separation takes over).
- [ ] **Charts**: `TrendChart` autoscales to its own min/max, so a $40 wobble and the real $1,518 July fall draw the identical picture, and its x-axis is an array index, so a 5-month gap and a 1-day gap have the same width. Calibrated scale with a printed zero; time-proportional x. Load the `dataviz` skill before touching chart colour.
- [ ] **The motif.** Transform, do not kill: mīzān *is* balance. `MAX_TILT_DEG = 9` and the real sheet returns 1.40°, moving the pan end ~2.6px; seven months of real snapshots span a 2.1° excursion, about 4px. Replace the drawn scale with a calibrated horizontal beam: extent is the whole sheet, a fixed tick at 50% is the fulcrum that never moves, the needle sits at the real boundary. Today's 57.8% versus 50% is ~70px on a 900px bar; 2026-03-01 was ~37px the other way. Same data, roughly 25x the legibility, and a position on a labelled axis is a measurement where a rotation is a mood. The beam is also where degradation shows: when a stage failed or the snapshot is stale the whole primary reading goes uncalibrated, replacing a 7px dot that currently renders sage whenever status is not `'error'`, including when the label beside it says "Not synced yet".

---

## Phase 8 — Screen consolidation, 12 items to 6

- [ ] **`/` the instrument** absorbs Today, Cash Flow and Reports. Reports and Cash Flow become a *time window* on one surface, not separate screens: one selector reshapes the same query set. Removes ~660 lines of duplicated view code and the possibility of two screens disagreeing about net worth, which `Reports.tsx` already carries a comment about having shipped once.
- [ ] **`/ledger`** absorbs Transactions, Review and Bills. Bills dies for a structural reason: a bill is a transaction that has not happened yet, and giving future money its own screen is the mechanism by which forecasts get read as facts. The 30-day forecast sits at the top of the ledger, above today's rule, on the same date spine, in estimate ink. Review dies as a filter because it is a filter. Row flags include `category_source`, which is recorded per row and rendered nowhere.
- [ ] **`/accounts`** absorbs AccountDetail
- [ ] **`/investments`** stays its own screen (decision 2026-07-30)
- [ ] **`/plan`** absorbs Budget and Goals
- [ ] **`/settings`** absorbs Onboarding, which is an orphan route nothing links to in an always-logged-in single-owner app
- [ ] **Advisor stops being a tab.** ⌘K becomes the only conversational surface, as a sheet over the current screen so an answer arrives beside the data it is about. Drafts attach to the row they are about: a suggested category renders inline in the ledger row in estimate ink with a one-key accept. 251 drafts and 140 applied actions have never once been visible next to the data they modified.
- [ ] **Delete budget groups** end to end: both tables are empty after three weeks in an app with one budget. 115 lines of service, five routes, a 120-line modal, the memo machinery, four fetchers, one test file.
- [ ] **Delete three dead preference keys**: `dashboard_layout`, `custom_report_views`, and `advisor_auto_apply_high_confidence`. The third reads `true`, asserting a confidence-gated autonomy policy removed in `f61109b`, and the model can read it through `run_sql_query`.
- [ ] **Nav**: six words, labelled at every width. Today every label is behind `xl:block`, so under 1280px (including a non-maximised laptop window) the entire navigation is twelve identical 7px dots at 1.6:1 contrast. Also un-hijack ⌘R and ⌘P, which are currently `preventDefault`ed for Review and Reports, killing reload and print.
- [ ] **Catch-all route.** There is no `path="*"`, so a typo renders a blank page.
- [ ] Sub-500px is explicitly out of scope: `localGuard` binds this to loopback, so it is a desktop object. The 1280px break is real; 375px is not.

---

## Phase 9 — Verification

- [ ] Full suite plus both typechecks
- [ ] Run the reconciliation invariant against the real database and record the residuals
- [ ] Re-derive every headline figure named in this plan from the live DB and confirm it now matches what the UI renders
- [ ] Drive the app and verify both themes at 1440 / 1280 / 1024
- [ ] Sweep the 91 capped findings for anything the phases above did not incidentally fix
- [ ] Update `CLAUDE.md` with the new architecture, and note that it is currently gitignored and therefore unversioned

---

## Out of scope, deliberately

- Sub-500px layout (loopback-bound desktop object)
- Multi-user, auth, or anything that widens the bind
- Re-adding Plaid/Teller (removed in 014), the freelance tax feature (019), or the General catch-all (036)
- A score-out-of-100 anywhere in the UI: that is the derived-as-fact failure this whole plan is about


---

## Progress log

| When | Landed | Verified against real data |
|---|---|---|
| 2026-07-30 | Phase 0 baseline | 374 tests, both typechecks green |
| 2026-07-30 | Phase 1: revision logs, write guards, rule provenance | 15 open drafts to 0 surfaced as work; `total_open` 19 to 4; migration 042 applied to the live DB after a backup |
| 2026-07-30 | Phase 2: refunds, cost basis, cards | July net -$665.24 to **+$1,389.00**, savings rate -31% to **+64.0%**; portfolio gain $141.82 to **$36.83** (7.1% to 1.8%); free-to-spend $2,523.56 to **-$1,926.52**; spending total now equals cashflow expenses exactly |
| 2026-07-30 | Phase 3: AI numbers | 3-month average income $2,862.93/mo to **$2,139.19/mo**; 5 of 19 trend points now marked as reconstructions; portfolio totals no longer computed from a `LIMIT 15` slice |
| 2026-07-30 | Phase 4a: write-path invariants | derived investment buckets fix two snapshots reading $0.00 for a $1,661.66 portfolio; backup closure 17 to 28 tables, **673 rows** that would have been silently dropped now round-trip exactly |
| 2026-07-30 | Phase 5 (partial): savings rate | undefined rather than 0% for a no-income window |

### Recurring lesson, worth keeping

Six separate times, a test failed only because its hand-written schema lacked a column, a CHECK, or a
table that the real migrations produce (`manually_categorized`, `duplicate_status`, `is_estimated`,
the migration-042 provenance tables, `securities` timestamps that do not exist, a positional
`INSERT` broken by a new column). Each failure was the audit's structural blind spot surfacing:
a test that builds its own schema cannot catch a divergence from the migrated one. `migratedTestDb()`
in `tests/helpers/schema.ts` now exists and every new test uses it. Converting the remaining
hand-written schemas is a Phase 9 item.


---

## Rendering hazards created by the correctness work

These are consequences of making the data honest, and Phase 7/8 must handle them rather than
flooring them back into looking tidy.

1. **A spending category can be negative.** July 2026 Shopping is **-$1,203.63** because that month's
   Amazon and REI credits exceed its purchases. `ProgressBar` cannot take a negative width, a
   share-of-total percentage against a signed total is meaningless, and a "top spending" list sorted
   by amount puts the largest credit last.
2. **An isolated estimated point invites false interpolation.** 2024-07-01 survives the
   informativeness gate legitimately, on one real $10 crypto buy, but its nearest neighbour is
   2025-04-01 nine months later. A line drawn between them interpolates nine months that do not
   exist. Coverage is 6/14 there. The trace has to break, not connect.
3. **Coverage changes along the series and part of the "cliff" is not money.** Estimated 2026-06-01
   is $3,823.16 at 14/14 coverage against measured 2026-06-30 at $1,068.29 at **11/11**. The new
   coverage columns reveal that some of that drop is accounts arriving in mizan rather than money
   moving, which nothing could see before. The chart must not present the two as the same quantity.
4. **`free` is signed now.** "Short this month" and "free to spend" are different states and must
   read differently, not as a red number in the same slot.

## Verified figures, second pass

| | before | after |
|---|---|---|
| Backblaze next charge | 2026-08-16 (a day early, then flagged overdue on the real date) | **2026-08-17** |
| Payroll expected amount | $398.93 stored / $476.91 forecast (two numbers on one screen) | **$544.18** on both |
| Month-end bill walk from 01-31 | 01-31, 02-28, 03-28, stuck | **01-31, 02-28, 03-31, 04-30** |
| Patterns carrying a category | 0 of 11 | **4 of 11** (the rest have no clear majority, which is the tie-safe answer) |
| Estimated net-worth points | 5, oldest 2026-02-01 | **16, oldest 2024-07-01**, each with coverage |
| Ten flat months of $380.00 | drawn as history | **not emitted at all** |
| Ledger-to-balance reconciliation | did not exist | 6 of 14 accounts unreconciled, largest residual **-$1,126.52** on Discover |


---

## Carried into Phase 8 from the token work

The palette now themes correctly, but the SCREENS are not theme-clean yet. Whoever consolidates them
must handle:

- **~27 hardcoded hexes in views** (category and chart colours: `#c9963a`, `#7c8b99`, `#a7bb92`, ...)
  do not follow the theme and will look wrong on the dark ground. Route them through tokens.
- **`shadow-e1-alt` is used 5 times and is not defined in `tailwind.config.js`.** A pre-existing dead
  utility emitting no CSS. Left alone because fixing it changes rendering in views the token
  workstream was not allowed to touch.
- **`Today.tsx` uses `text-faint` on two strings.** `faint` is documented non-text (3.26:1 light,
  4.10:1 dark) and is the one token deliberately below AA.
- **U+2192 (the arrow, used in 8 files)** is in neither font subset and falls back to the system
  stack. Unchanged behaviour, but now visible against a deliberate type system.
- Instrument Sans italic is not shipped; the two italic strings in Advisor synthesize oblique.

### Measured result of the palette rebuild

| | before | after (light / dark) |
|---|---|---|
| ground `paper` L\* | 93.9, six points of runway above it | **87.8 / 13.0** |
| `card` on `paper` | 1.072:1 | **1.240:1 / 1.190:1** |
| loudest furniture vs quietest accent | tan C=0.060 beat sage C=0.045 | **tan 0.041, sage 0.096** (un-inverted) |
| `gold` hue vs neutral family | 78.8 against paper 84.6, read as ambient | **57.7**, ~23 degrees clear |
| `text-gold` contrast | 2.18:1 | **4.57:1 / 7.40:1** |
| money numerals | muted ramp had failed AA before the last fix | every one clears AA on both grounds, both themes |
| fonts | 3 families from Google on every cold load, mono 300 never downloaded | **6 self-hosted variable woff2, 308 KB**, mono 300 real |
| `/alpha` utilities | the class that silently died once before | **9 of 9 emit**, verified in the built CSS per theme |


---

## Part I's figures, re-derived 2026-07-31

Phase 9 re-ran every measured figure in both plan files against a private byte copy of
`.mizan/mizan.db` at migration **`054_drop_dead_preferences.sql`**, twelve migrations after the
database this file's audit was written against. **The full record, with the query beside each
figure, is in `rebuild-part-2.md` under "Every figure both plan files claim, re-derived 2026-07-31".**
The reconciliation, flow-conservation and data-quality residuals are recorded in the same place.

Nothing above has been edited. What a number was when the decision was made is the record; this is
the annotation. What follows is only the Part I entries whose verdict is not "holds".

**The basis line at the top of this file has moved.** 2,579 transactions to 2026-07-28 is now
**2,588** to 2026-07-29; 19 net-worth snapshots is now **32** (16 measured, 16 estimated); 140
applied AI actions is **142**; 236 merchant rules still reads 236, of which **234 are live** after
5b.5 retired two. 14 accounts, 1 budget and 1 goal are unchanged. The 374-test baseline is **1,352**.

| Part I figure | 2026-07-31 | verdict |
|---|---|---|
| Reconciliation: 6 of 14 accounts unreconciled, largest residual −$1,126.52 on Discover | **0 of 14 unreconciled.** Discover reconciles at 0. `total_residual` $1,347.48, none of it flagged | moved; this is Phase 5b landing and it is the strongest confirmation in the pass |
| Phase 2: July net −$665.24 to **+$1,389.00**, savings rate −31% to **+64.0%** | **+$1,602.41** and **59.0%**. Income $2,715.40, expenses $1,112.99 | moved; July was mid-month when measured |
| Phase 2: free-to-spend $2,523.56 to **−$1,926.52** | **+$191.23** with the Shopping claim at its $500.00 ceiling, +$691.23 before budget claims | moved twice, once here and once in 5b |
| Phase 2 consequence: July Shopping **−$1,203.63**, from $1,772.93 of Amazon credits and a $281.29 REI return | **−$1,028.63**, from **$1,771.93** of Amazon credits and the same $281.29 REI return. Still negative, which is what hazard 1 is about | moved; the Amazon figure is off by $1.00 and cannot be reconstructed |
| Phase 2 consequence: July spending total equals cashflow expenses exactly ($782.22 = $782.22) | **$1,112.99 = $1,112.99.** The equality is what the claim was, and it holds | holds, values moved |
| Phase 3: 3-month average income $2,862.93/mo to **$2,139.19/mo** | **$2,139.19/mo**, verbatim in `buildFinancialContext()`. Expenses $3,475.31/mo, net −$1,336.12/mo | holds exactly |
| Phase 3: three disagreeing investment totals, $2,044.62 / $2,144.62 / $2,443.67 | account balances and the holdings sum now **agree exactly at $2,045.04**. The third, $2,436.21, differs only because it adds Coinbase's $391.17, which is a scope difference and not a disagreement | moved, and the defect is closed |
| Phase 4a: backup closure 17 to **28** tables | **32 of 32.** `LOCAL_BACKUP_TABLES` now covers every table in the database, including the 6.2 and 6.3 AI tables | moved, in the right direction |
| Phase 5: 4 of 11 recurring patterns carry a category; payroll expected $544.18 on both surfaces; Backblaze next charge 2026-08-17 | **4 of 11**, payroll `average_amount` **54418**, Backblaze `next_expected` **2026-08-17** | all three hold exactly |
| Phase 5: estimated net-worth points 5, oldest 2026-02-01, to **16, oldest 2024-07-01**, each with coverage | **16 estimated, oldest 2024-07-01, zero rows with NULL coverage.** 2024-07-01 sits at 6/14, and its nearest neighbour is still 2025-04-01, nine months later | holds |
| Rendering hazard 3: estimated 2026-06-01 $3,823.16 at 14/14 against measured 2026-06-30 $1,068.29 at 11/11 | **$5,521.48** at 14/14 against **$1,068.29** at 11/11. The coverage asymmetry the hazard is about holds exactly; the estimated dollar figure does not | partly moved |
| Phase 4: Chase Freedom Flex opened 2026-03-10 and capped the walk | first transaction **2026-03-10**, and per-account floors mean it no longer caps anything | holds |
| Phase 7 carryover: `shadow-e1-alt` used 5 times and undefined; `text-faint` on two strings in `Today.tsx`; U+2192 in 8 files | all three are **zero uses**. Each survives only as a comment recording why it is gone | all fixed |
| Phase 7 diagnosis: 422 of 466 type-step usages in an 11.5 to 15px band, **0 `font-bold`** | `font-bold` is **still 0**. The weight range opened to semibold instead: light 9, normal 6, medium 24, semibold 13 | the diagnosis figure still describes the code; the item is done by a different lever than the one named |
| Phase 7 carryover: ~27 hardcoded hexes in views | **23 remain.** 22 are swatch literals in `settings/CategoriesSection.tsx`, a colour picker; the outlier is `#c9963a` in `SyncActivityPanel.tsx` | partly done, and the item is marked done |
