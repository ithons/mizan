# mizān part IV: the last mile

Written 2026-08-31, against HEAD `58463e7`, one month after Parts I to III and `relink-and-close`
closed. Every figure below was re-derived on 2026-08-31 against a read-only copy of `.mizan/mizan.db`
at migration 056, with the query beside it. Where a claim comes from running the real service rather
than reading it, that is said.

---

## The brief this answers, and where the brief is wrong

The brief asks for seven stages in order: know the repo, clean up, project the bugs, audit the
boundary, decide what it should be, make it fast and small, and make the visual argument. It also
asks, if the ordering is wrong, to say so early. It is wrong in one specific way, and the correction
is the most useful thing in this document.

**Stages 1 to 3 are not empty, but they will not pay what the brief expects.** This repo has been
through four adversarial verification rounds across five plan files and 326 commits. A generic
re-audit re-finds recorded findings. What it cannot find is what those rounds structurally could not
see, and that is where this plan spends its effort:

- **Drift between the record and the tree**, because every prior round re-derived its figures by
  hand, and hand-derived figures rot. Measured below: every one of them has.
- **Time dependence**, because a suite written on one day and run a month later is a different
  experiment. One test had already failed on this alone before any work began.
- **The boundary**, which no plan file covers at all. It is the one genuinely unexplored stage.
- **The last mile**, defined below, which is the shape the remaining defects actually have.

**Stage 6 is half wrong.** `tests/` is 41k lines against `server/`'s 37k, and that looks like a size
finding. It is not one. The test mass is this codebase's immune system and a deliberate position;
cutting it is not a deliverable. Stage 6 targets are the app: startup, sync pass duration, bundle.
Measured, they are already fine, and the section says so rather than inventing work.

**Stages 5 and 7 are where the open questions genuinely are**, and Part III already wrote most of
stage 7 as Phases 13 and 14 and then never landed them.

---

## The through-line: what is actually left is a last mile

Every defect this pass verified has the same shape, and it is not the shape a young codebase has.
Nothing here is a missing mechanism. In every case the mechanism exists, is well argued in a
comment, and is covered by tests. What is missing is the last connection.

| Verified | The mechanism | The last mile that is missing |
|---|---|---|
| V1 | `flowConservation` detects the mis-signed transfers; the amount-revision write path pins a correction against the next sync | Nothing routes the owner from the finding to the twelve rows. Zero revisions in three months |
| V2 | `contrastClaims.test.ts` re-derives every stated figure from the source of truth | It walks `client/src`. Not one source-walking test walks `server/src` |
| V4 | `classifySyncConnection(row, now)` takes an injectable clock | `getSyncHealth(db)` did not take one, and dropped it |
| V9 | The AI call is bounded at 300s with `maxRetries: 1` and a paragraph arguing the bound | The four calls that fetch the actual money set no timeout at all |
| V10 | `boundary_amount` explains the Chase Checking residual exactly, to the cent | The record still carries it as an open item |
| 6 | `MIZAN_HOST`, `HOST_IS_LOOPBACK` and a "binding beyond loopback" warning all exist | All three sit in a branch neither documented command reaches, so the bind is `::` |

Finding 6 is the purest instance in the repo. The mechanism is not merely built and unused: it is
built, correct, documented in three places, and unreachable. Nothing about it is wrong except that
nothing runs it.

That is the signature. A codebase that grew through correction builds the mechanism at the moment it
understands the defect, and the understanding is complete while the wiring is one step short. The
work below is ordered by that reading, not by severity alone, because a plan that treats these as
five unrelated bugs will fix five things and leave the pattern.

---

## Baseline, before any work

`npm test` at HEAD: **1691 tests, 1690 pass, 1 fail.** Three typechecks clean. `npm run build` clean.

The failure is `tests/syncHealth.test.ts`, "HEALTHY: a connection that has never failed carries no
failure advice at all", asserting `freshness === 'fresh'` against a fixture dated 2026-08-01 and the
wall clock. It passed on the day it was written and has failed every day since 2026-08-04.

This is fixed already, ahead of the plan, because the gate is the instrument every phase below is
measured with and it cannot be red. It is fixed per rule 1, in the write path rather than by moving
the fixture date: `classifySyncConnection(row, now = new Date())` already took a clock and
`getSyncHealth(db)` dropped it, so every caller including `routes/insights.ts` and `aiContext.ts` was
pinned to the wall clock with no seam. `now` is threaded through `getSyncHealth`; the two integration
tests are anchored to their own fixture clock; and a new regression asserts both directions off an
injected clock, so the healthy case can no longer rot. **1692 tests, 1692 pass.**

---

## What was verified, and what was refuted

Full evidence, with every query, is in the findings appendix at the end. Confidence is labelled
throughout: **verified** means reproduced by running code or a query, **inferred** means it follows
from code read directly, **guessed** means pattern-matched and not confirmed. Nothing below is
guessed; the guesses were killed.

### Verified

- **V1 [medium]** The mis-signed brokerage transfers are detected, reported, and unactionable.
  `findFlowConservationViolations` run against the live copy returns exactly one violation: Chase
  Checking to Fidelity Individual, 20 legs, 2026-05-21 to 2026-07-27, movement 70000 cents. The
  correction path is complete end to end. `transaction_field_revisions` has 0 rows and no transaction
  carries `amount_source = 'human'`. Part III Phase 11 promised these rows would become a recorded
  correction; what landed is the mechanism, and nothing has invoked it.
- **V2 [high]** Server-side stated figures have no enforcement, and every one has drifted.
  `rules.ts:502` claims 236 rules over 41 timestamps with 173 sharing one; live is 248, 55, 171.
  `aiWorker.ts` claims 135 detection rows to 2026-07-30; live is 146 to 2026-08-29. `CLAUDE.md`
  claims 238 and 45, and open 158 / reviewed 2,442; live is 248 and 55, and 189 / 2,534. In every
  case the structural claim survived and only the pasted number rotted.
- **V9 [high]** All four outbound provider calls set no timeout, and the retry policy multiplies it.
  `grep -n timeout` over `simplefin.ts`, `coinbase.ts`, `routes/simplefin.ts` and `retry.ts` returns
  zero hits. Axios defaults to wait-forever. `defaultIsRetryable` classes a statusless network error
  as retryable and `maxAttempts` defaults to 3.
- **V10 [record]** The Chase Checking $544.18 item that `STATE.md` still carries as open is resolved.
  `reconcileAccounts` on the live copy: residual 54418, boundary_amount 54418, adjusted_residual 0.
- **V6 [PARTLY WRONG, corrected by the audit]** I ran three detectors against the live copy (sync
  health, data quality, personal-finance invariants), found them silent, and wrote "the detectors
  are silent on the owner's real data". Three is not "the detectors". Audit findings 4, 30, 17 and
  29 ran the one I skipped: replaying `getAnomalyInsights` once per day over the year to
  2026-08-31, the spending-spike detector fired on **303 of 365 days** across ten categories, in
  runs up to 94 days unbroken, printing 1000% or more on 41 of them and topping out at 25000%. I
  re-derived that independently before accepting it: 303/365, max 25000%. The clause "This refutes
  the obvious projection that a month unattended would leave standing findings the owner cannot act
  on" was exactly wrong, and it is the kind of claim rule 2 forbids: a conclusion wider than the
  measurement behind it. Fixed in Phase 3; the corrected figure is 25 days across 2 events.
- **V7 [boundary]** One AI call ships 30,560 characters, about 8,042 tokens, 596 lines, 21 sections,
  318 dollar figures and 39 account-name occurrences, including the owner's stated residency and
  income context. `ai_runs` records model, trigger, timing and exact token counts, and does not
  record the payload.

### Refuted, recorded so they are not relitigated

- **V3, killed by one comment.** 68 AI runs, 1,303,889 input tokens, 0 cache reads, 0 cache writes
  looks like elaborate caching machinery that never fired. It is deliberate, and argued in the source
  immediately above the call: the prefix is unstable by construction and the hourly cadence outruns
  both TTLs. The measurement confirms the design.
- **V5, my own projection, killed.** Orphan `running` rows (1 in `ai_runs` since 2026-08-01, 5 in
  `sync_runs` since 2026-07-24) do not poison the AI pass watermark. `lastPassStartedAt` filters on
  `completed` or `nothing_to_do` and the docstring says why.
- **V1's first two framings, killed.** "$1,800 of wrong money on screen" is wrong: the rows are
  `is_investment = 1` and `transactionFilters.ts:65` excludes investment flows from the expense side,
  so no spending or income total is affected. "Reconciliation should be flagging this" is also wrong:
  `direction_conflict` is `!isMarketDriven` by construction and the comment argues it properly.
- **V9's timing evidence, downgraded.** 13 sync runs over 60s and a 2h 06m maximum are *consistent*
  with an unbounded hang but do not prove one: no other run started inside that window, so machine
  sleep produces an identical signature. The finding stands on the code, not on the durations.
- **V11, not claimed.** The ten failed AI runs measure 644s to 2260s against a documented ten-minute
  cap. That cap cannot be checked from laptop wall-clock timestamps, for the same reason.

---

## Phases, ordered by dependency

Full evidence for every finding cited by number is in `part-4-findings.md`.

### Phase 0: the gate  [LANDED, ahead of this plan]

Threaded `now` through `getSyncHealth`. 1692/1692, three typechecks, build clean. Every phase below
is judged with this instrument and it cannot be red while they run.

### Phase 1: the server binds to loopback  [finding 6, critical]

**What it changes.** `server/src/index.ts:166` takes the `!IS_PROD` branch under both documented
commands, because neither `npm run dev` nor `npm start` sets `NODE_ENV` and `.env` holds four keys,
none of them `NODE_ENV`. That branch is `ViteExpress.listen(app, PORT, announce)`, and vite-express's
`listen(app, port, callback)` accepts no host and calls `app.listen(port, ...)`, so Node binds `::`.
`MIZAN_HOST` is read into a constant only the unreachable branch uses, and the "binding beyond
loopback" warning is gated on `IS_PROD && !HOST_IS_LOOPBACK`, so it can never print.

Verified in the main loop, not only by the audit. With `MIZAN_HOST=127.0.0.1` explicitly set, the
actual bind is `{"address":"::"}`. Driving the app's own `localGuard` on a harness with no database,
from this machine's LAN address, a forged `Host: localhost:<port>` returned **HTTP 200 on a GET** and
**HTTP 200 on a POST carrying no Origin header**. That is not a flaw in `localGuard`: it is
browser-only by design, `evaluateLocalRequest` skips the Origin check when `req.origin` is absent, and
`tests/localGuard.test.ts:40` asserts exactly that as correct for curl. The two defences were meant to
compose. The first is not there, so the second is carrying a load it was never built for.

Three places state the opposite: `README.md:266`, `CLAUDE.md:317`, and the comment at `index.ts:39-42`.

**Why first.** Everything else in this plan is a wrong number. This is the ledger being readable and
writable from whatever network the laptop is on, and it has been true for the life of the repo. It
also shares no files with anything below.

**What proves it worked.** `lsof -nP -iTCP:<port> -sTCP:LISTEN` shows `127.0.0.1` under `npm run dev`,
and the same LAN curl gets connection-refused. Structurally: `app.listen(PORT, HOST, ...)` followed by
`ViteExpress.bind(app, server, ...)`, which vite-express exports for exactly this, so one HOST governs
both branches. A regression asserting `server.address().address === '127.0.0.1'` with `MIZAN_HOST`
unset, and the warning moved out from behind `IS_PROD`.

**What it does not do.** It does not add auth. One owner on one machine is the standing constraint,
and loopback is what that constraint was always resting on.

### Phase 2: the four defects that make a number wrong  [findings 3, 7, 2, 1]

Grouped because they are one class with one kind of proof: a total on screen disagrees with the ledger.

- **Finding 3, verified in the main loop.** `advisorDrafts.ts:961` calls `toCentsOrNull` and hands the
  result to `upsertRecurringAdjustment`, which calls `toCents` again at `recurringAdjustments.ts:105`.
  The comment three lines above states the requirement correctly and then satisfies it twice. The
  other caller, `routes/recurring.ts:236`, converts once, so one function has two callers holding
  contradictory unit contracts. A confirmed AI bill reprice is stored 100x too large and propagates to
  the forecast, the ledger spine, the next-bill reading and every goal completion date.
- **Finding 7, verified in the main loop against today's data.** `goalProgress.ts:19-23` overrides a
  savings goal's `current_amount` with its linked account balance; `safeToSpend.ts:96-98` reads
  `current_amount` raw. Live: goal `Emergency Fund` carries 100170 cents and its linked Wealthfront
  Cash account carries `current_balance` 0. So `/plan` and the AI say $0.00 saved while safe-to-spend
  subtracts $1,001.70 from a $6,712.02 liquid pool. Both numbers are on screen right now.
- **Finding 2.** A fully sold position is zeroed but keeps its cost basis, so the Investments header
  reports the sale as a 100% unrealized loss. It does not manifest on the live data yet; the first
  full sale of a Fidelity position triggers it. `investmentAnalytics.ts:437-442` already filters
  `value > 0` for the allocation bar and its comment names this exact case, so one of three consumers
  was fixed and two were not.
- **Finding 1, carried at 2/3 with a live dissent.** `boundary_amount` is subtracted unconditionally
  rather than only when the residual contains the artifact, which can manufacture an
  `adjusted_residual` and a false `direction_conflict` on a ledger that reconciles exactly. The
  dissenting refuter argues the reachability premise is empirically false. **This one is not settled
  and must be adjudicated before it is touched**, which is why it sits last in the phase. My own probe
  found the mechanism working correctly on today's data (Chase Checking residual 54418, boundary
  54418, adjusted 0), which is the state the existing tests cover; the finding is about the mirror
  state, which no test covers.

**What proves it worked.** For each, the regression the finding names, plus the healthy case asserting
silence. Finding 7 additionally: the two figures agree on the live data, which is checkable today.

### Phase 3: the detector that cries wolf  [findings 4, 30, 17, 29, 33]

The spending-spike detector fires on **303 of 365 days** of the owner's real ledger, in unbroken runs,
and its copy says "no comparable spending in the prior 30 days" about a window that contains
comparable spending. `anomalyInsights.test.ts` asserts no healthy case and its one silence assertion
is vacuous.

**Why here.** This is rule 3, the rule this codebase wrote down after a panel read "N open conditions"
on a clean ledger. It is the largest live violation of it in the tree, and it is separate from Phase 2
because nothing it touches is a total.

**What proves it worked.** The healthy case: the detector is silent on the owner's real ledger for the
overwhelming majority of days, asserted as a count rather than as a shape.

### Phase 4: the sync path's failure modes  [findings 8, 5, 48, 10, 25, 32, 56]

An empty or unreadable Coinbase 200 zeroes the entire crypto position and the same run snapshots it; a
credentials decrypt failure is swallowed into "nothing is configured"; no outbound call sets a timeout
(my V9, independently corroborated by the audit at 2/3); every SimpleFIN backfill floor was rewritten
to 2026-07-31 in the database; the Coinbase stage has no error channel; dismissing a recurring pattern
deletes the row that records the dismissal.

**Why after Phase 2.** These are how a number *becomes* wrong rather than a number that is wrong now.
Finding 8 is the exception and is arguably Phase 2 material; it sits here because its fix is in the
same file as the rest.

### Phase 5: make a stated figure impossible to rot, on the half of the tree that holds money

Unchanged from the argument above, and corroborated independently by the audit at finding 36:
`rules.ts` still prints 236 / 41 / 173 where live is 248 / 55 / 171. **The unresolved question below
stands, and Phase 5 does not start until it is answered.**

### Phase 6: close the last mile on the mis-signed transfers

Unchanged. `flowConservation` reports a pair and a movement total, nothing routes the owner to the
twelve rows, and `transaction_field_revisions` has 0 rows after three months.

### Phase 7: make the app runnable, then judge what only a browser can judge  [V12]

**What it changes.** `MIZAN_DIR` becomes overridable. Today it is
`path.join(process.cwd(), '.mizan')`, a module constant with no override, and startup runs
`reclassifyAutoAccountTypes` whenever any account carries `type_source = 'auto'`, which five do. So
booting the app to look at it means writing to the owner's real ledger.

**Why this is a phase and not a chore.** The completeness critic established that **no finder rendered
anything**, so findings 12, 13, 15, 24, 37, 39, 45, 53 and 62 are all source-read assertions about
pixels. `rebuild-part-3.md` says the one risk it cannot design away is a palette passing every test
and still being wrong on screen, and that "Gate 4 is not a formality". Gate 4 requires running the
app. This is, I think, why Phases 13 and 14 are the only fully specified phases in this repo's history
that were never landed: the cost of looking was a write to real financial data.

**What proves it worked.** Booting with the override set against a copied database leaves
`.mizan/mizan.db` byte-identical. Then the nine pixel findings are confirmed or killed in a browser.

### Phase 8: Part III Phases 13 and 14

The graphic layer and the accessibility remainder, already specified in full in `rebuild-part-3.md`.
**Gated on Phase 7, hard.** This is the phase where the suite passing and the screen being wrong are
completely compatible, and until Phase 7 lands there is no way to look.

### Phase 9: the record, and subtraction

Findings 35, 36, 38, 54, 59, 60, 61, 65 and 67 are documentation stating something HEAD does not do,
including `CLAUDE.md` describing the money write path as it was two commits ago and asserting the
migration hook is absent from a fresh clone when `git ls-files` shows it tracked. Plus the record
items above: the Chase Checking item is closed, `rebuild-part-2.md:338` is struck, and
`ui-overhaul.md` is judged rather than deferred a fourth time.

Subtraction lands here too, informed by the critic rather than by a census. `queryInvalidation.ts` is
a hand-maintained TanStack key list missing seven keys, which is the fifth-copy pattern this codebase
condemns; `textCategorization.ts` is a third categorizer and a fourth precedence tier nobody named,
owning 58 live rows; `scripts/cleanup/*.ts` are four out-of-band database mutators sitting in none of
the three tsconfigs.

### Not scheduled, and named so it is not mistaken for coverage

`simplefinRelink.ts:340-780`, roughly 440 lines deciding which old account maps to which new one, was
skipped by name by all three finders that opened the file. `simplefin_relink_proposals` is empty, so
this code has never executed and will run exactly once, unrehearsed, at the moment the ledger is most
fragile. Forty of the fifty-five migration bodies were read by nobody. Neither is in a phase because
neither is understood well enough to plan one.


---

## What I am least sure about

- **Finding 1 is genuinely unsettled**, and it is the only critical carried at 2/3. One refuter argues
  the reachability premise is empirically false, and my own probe found the mechanism behaving
  correctly on today's data. Both can be true: the existing tests and the live ledger cover one state,
  the finding is about its mirror. It must be adjudicated before it is touched, and if the mirror
  state is genuinely unreachable the right outcome is a test pinning that, not a change.
- **Phase 5's scope is the biggest judgement call here.** A walker over `server/src` that runs SQL to
  check comments is a test that touches the database, and the suite's whole discipline is that a test
  builds its fixture from the migrations. A figure derived from the *owner's* data cannot be checked
  against a `:memory:` fixture at all. There may be no honest way to enforce these figures in the
  suite, and the right answer may be a script the owner runs. Unresolved; Phase 5 waits on it.
- **Phase 6 may be a one-off.** Twelve rows on one account from one provider is an anecdote. Building
  a general affordance for a population of twelve is the generality the standing constraints call a
  cost. The narrower version is a script. I lean to the affordance because the detector is permanent
  and will fire again, but that is a preference, not a finding.
- **The boundary audit produced no deliverable, and I think that is the honest outcome.** Every
  outbound call is one the owner configured, nothing calls out before the owner acts, credentials are
  encrypted with the key in the keychain, and `ai_runs` already records model, trigger, timing and
  exact token counts per call. What one call ships is large (30,560 characters, about 8,042 tokens,
  including residency and income context) but that is the design working, not a leak. Findings 49, 50
  and 51 are the residue: a context preview route, a backup that omits the chat transcript from its
  own description, and an unrotated 6.8 MB log. None is worth a phase; they fold into Phase 9.
- **68 findings is more than one pass should land.** Phases 1 through 4 are 17 of them. I have not
  costed the rest and I would rather stop after Phase 4 and re-derive than commit to an order for
  findings whose evidence I have not personally re-checked.
- **I have still not run the app.** That is Phase 7's whole point, and it means nine of the surviving
  findings are assertions about pixels made by reading source. They are marked as such.

## Out of scope, deliberately

All standing non-goals hold: one owner and one machine, no auth, no Plaid or Teller, no score out of
100, no number the app invented and then presents as a fact, and never silently rewriting what an
external source reported. `CLAUDE.md` stays gitignored, per the decision already recorded.

Two more, specific to this plan:

- **No test deletions for size.** See the brief correction above.
- **No new AI surface.** The AI layer does real work on this data (today's pass proposed four drafts
  and applied four). Whether it has decayed into a surface is a stage 5 question and the answer so far
  is no.

---

# Appendix: findings, with every query


Every figure below re-derived 2026-08-31 against a read-only copy of `.mizan/mizan.db` at
migration 056, with the query stated. Code claims cited file:line.

## V1 [MEDIUM, after three rounds of self-refutation] A standing finding with no route to the fix
WHAT I FIRST CLAIMED, AND WHY IT WAS WRONG. I opened with "$1,800 of wrong money is still on
screen". Three checks killed successive versions of that:
 - The 12 rows are categorised `cat_inv_transfer`, which carries `is_investment = 1`, and
   `transactionFilters.ts:65` excludes investment flows from the expense side. No spending or
   income total is wrong. `schemaDoc.ts:563` publishes that exclusion in as many words.
 - Reconciliation does not flag them, and that is deliberate, not a miss: `direction_conflict` is
   `!isMarketDriven && ...` by construction, and the comment at `reconciliation.ts:338` argues it
   properly ("no comparison against it can separate a mis-signed transfer from a down month").
 - It names a designated catcher, `flowConservation.ts`, and that detector DOES fire. Run against
   the live copy it returns exactly one violation: Chase Checking <-> Fidelity Individual, 20 legs,
   2026-05-21 to 2026-07-27, movement 70000 cents. Correct, specific, and surfaced through
   `routes/insights.ts:124` and `aiContext.ts:252`.
 - The write path is complete and reachable: `modals.tsx:149-169` lets the owner edit an amount,
   `categoryWrites.ts:308-323` files a `transaction_field_revisions` row, and `simplefin.ts:564`
   pins it against the next sync via `amount_source = 'human'`.

WHAT ACTUALLY SURVIVES. Every part works and the defect is still there. On the live copy:
  SELECT COUNT(*) FROM transaction_field_revisions;   -> 0
  amount_source over transactions                     -> (null) 2589, provider 134, human 0
Twelve rows dated 2026-04-15..2026-07-27 remain negative, and the detector has been repeating the
same finding for three months. `rebuild-part-3.md` Phase 11 promised these rows "become a RECORDED
correction rather than an uncorrected report"; `relink-and-close.md` Phase 1 is marked
`[LANDED 2026-08-01]`. What landed is the mechanism. Nothing has ever invoked it.

So this is rule 3's second half, not a broken write path: the detector leaves a standing finding
and nothing routes the owner from the finding to the twelve rows. `flow_conservation` reports a
pair and a movement total; acting on it means finding twelve rows by hand and retyping each in a
modal, and no surface connects the two.
PROVES REAL: the flowConservation output above, plus 0 revision rows after three months.
PROVES FIXED: the detector's finding carries the rows it is made of and an action that files the
revisions; afterwards `findFlowConservationViolations` returns [] on this data, 12 revision rows
exist, and a second sync does not revert them.

## V2 [HIGH] Server-side stated figures have no enforcement, and every one has drifted
The repo already built the right mechanism, for the client only. `tests/contrastClaims.test.ts`
walks `client/src`, parses every ratio-shaped figure near a token name, and re-derives it from the
palette, with a `[historical]` opt-out that lives in the source comment. It is good work.

Every source-walking test targets `client/src`. Not one walks `server/src`:
  accountsRowContrast, askSheet, barBoundary, cardElevation, contrastClaims, edgeToken,
  keyboard, navigation, railGround, rehomedCapabilities -> all client/src
  deadPreferences, amountCorrectionCopy -> single named files
So the money logic carries zero prose-claim enforcement while the palette carries a sophisticated
one. Rule 2 ("never a claim, in code or in copy, that the code did not check") is enforced on
exactly the half of the codebase that does not hold money.

Consequence, measured today:
  rules.ts:502-503  "236 live rules over 41 distinct timestamps, 173 of them sharing one"
    SELECT COUNT(*), COUNT(DISTINCT created_at) FROM merchant_rules WHERE retired_at IS NULL;
      -> 248 and 55; top collision 171.   All three figures stale.
  aiWorker.ts       "135 rows, 2026-06-30T15:37Z to 2026-07-30T02:04Z, every one 'integrity'"
    SELECT COUNT(*), MIN(created_at), MAX(created_at) FROM sync_changes WHERE change_type='detected';
      -> 146 rows, to 2026-08-29T04:06Z.  Count and range stale; the structural claim holds.
  CLAUDE.md         "238 and 45 as of 2026-08-01"            -> 248 and 55
  CLAUDE.md         "open 158, reviewed 2,442, no dismissed"
    SELECT review_status, COUNT(*) FROM transactions GROUP BY 1;
      -> open 189, reviewed 2534, still no `dismissed`.  Counts stale; structural claim holds.
In every case the structural claim survived and only the pasted number rotted, which is the
argument for deriving the number rather than deleting the sentence.

## V3 [REFUTED BY THE CODE - my own finding, killed]
I measured 68 ai_runs, 1,303,889 input tokens, 0 cache reads, 0 cache writes, and was about to
report that the elaborate three-provider caching machinery had never fired in production.
It is deliberate and argued in the source, at `aiWorker.ts` immediately above the call:
"No prefix caching on this pass, on any provider ... The prefix is unstable by construction:
buildFinancialContext() opens with today's date and interpolates the last successful sync
timestamp, rewritten by the very sync that fires this worker ... the hourly cadence outruns both
TTLs." `anthropic.ts:155` (`streamChat`) sets `cache_control: {type:'ephemeral'}`; `createOnce`
(line 279, the `generateStructured` path) deliberately does not.
The 0/0 measurement CONFIRMS the design rather than contradicting it. Recording this because the
brief asks for refutations and because the measurement looks damning until you read one comment.

## V4 [FIXED] The gate was red at baseline
`tests/syncHealth.test.ts` healthy-case asserted `freshness === 'fresh'` against a fixture dated
2026-08-01 and the wall clock. `classifySyncConnection(row, now = new Date())` already took a
clock; `getSyncHealth(db)` did not, and dropped it. Threaded `now` through `getSyncHealth`,
anchored the two integration tests, added a regression asserting both directions off an injected
clock. 1692/1692 pass, three typechecks clean.

## V5 [LOW, and my own projection was REFUTED] Orphan `running` rows accumulate, harmlessly
1 `ai_runs` row stuck `running` since 2026-08-01T01:17:45; 5 `sync_runs` stuck since 2026-07-24.
Nothing reaps them. I projected that they would poison the AI pass watermark. They do not:
`aiWorker.ts` `lastPassStartedAt` filters `status = 'completed' OR skipped_reason = 'nothing_to_do'`
and the docstring says exactly why. `readLastSyncRun` excludes `running` for its own stated reason.
The projection is refuted; the orphans are cosmetic.

## V6 [GOOD NEWS, verified by execution] The detectors are silent on the owner's real data
Ran the real services against the live copy (`_setDbForTesting` + a throwaway probe):
  sync health              -> healthy / "Fresh" / 2 connections fresh, 0 needing attention
  data quality             -> 1 issue, severity `info`, "1 recurring candidate needs review"
  personal finance invariants -> []
Rule 3 holds where it was measured. This refutes the obvious projection that a month unattended
would leave standing findings the owner cannot act on.

## V7 [BOUNDARY, measured] What one AI call ships
`buildFinancialContext()` against the live copy: 30,560 chars, ~8,042 tokens, 596 lines, 21
sections. Contains 318 dollar figures, 39 account-name occurrences, 132 ISO dates, 0 account masks.
Includes net worth, every account, 36 months of history, the 40 most recent settled rows, 248
merchant rules, and the owner's stated personal context (residency status, income seasonality).
Actual per-run input is larger: `ai_runs.input_tokens` averages ~19,175 and peaks at 25,055.
RETENTION: `ai_runs` records job, trigger, sync_run_id, model, effort, status, timing and exact
token counts. It does not record the payload. So the owner CAN answer "what left, when, to which
model, how big"; they CANNOT answer "what exactly was in it". The context is deterministic from the
DB, so the shape is reconstructable but not the bytes as sent.

## V8 [CONTEXT] The AI job framework has two entries
`AI_JOBS` declares `background_review` (scheduler, after_sync) and one `execution: 'callsite'` job
with `writes: []`. Only `background_review` has ever run (SELECT DISTINCT job FROM ai_runs).
Of 68 runs: 57 completed, 10 failed (all "Request timed out.", all on 2026-08-07/08), 1 stuck.
It does do real work: today's run proposed 4 and applied 4.

## V9 [HIGH] Every outbound provider call is unbounded, and the retry policy multiplies it
There are four outbound HTTP call sites and not one sets a timeout:
  server/src/services/simplefin.ts:891   axios.create({ baseURL: accessUrl })      <- no timeout
  server/src/services/coinbase.ts:305    axios.get(spot price)                     <- no timeout
  server/src/services/coinbase.ts:367    axios({...})                              <- no timeout
  server/src/routes/simplefin.ts:44      axios.post(decoded)  (claim URL)          <- no timeout
  grep -n timeout simplefin.ts coinbase.ts routes/simplefin.ts retry.ts  ->  zero hits
Axios defaults to `timeout: 0`, meaning wait forever.

It compounds. `retry.ts` `defaultIsRetryable` returns true when `status === undefined`, which is
exactly the shape of a network hang, and `maxAttempts` defaults to 3. So an unbounded request is
retried up to three times, each unbounded. Backoff itself is trivial (1s + 2s), so backoff cannot
account for the observed durations; the hang can.

EVIDENCE, SPLIT HONESTLY. The code fact is decisive on its own and does not depend on the timing
data: four outbound calls, zero timeouts, axios waits forever by default, and a statusless network
error is classed retryable and retried three times. That is an unbounded hang by construction.

The timing data is CONSISTENT with a hang but does not prove one, and I could not separate the two
hypotheses. No other sync run started inside the 2h 06m window and there was 1 `sync_changes` row
and 0 transaction updates in it, so "the provider call hung" and "the laptop slept" produce an
identical signature here. I am not claiming the observed long runs were hangs. What follows is the
distribution, offered as the shape of the tail rather than as proof of cause:
  SELECT ... FROM sync_runs WHERE status='succeeded'  ->  p50 5.3s, p90 11.5s, p99 3776s, max 7580s
  13 successful runs took over 60s. The longest ran 2h 06m.
Decomposing that run (its item rows are stamped once, at completion):
  run started            2026-07-28T17:18:03Z
  simplefin item stamped 2026-07-28T18:23:09Z   (+65 min)
  coinbase item stamped  2026-07-28T19:24:20Z   (+61 min)
  the two system stages  2026-07-28T19:24:23Z   (+2 s)
The gaps sit inside the provider calls, in ~1-hour units. The local stages are instant.

WHY IT IS A DESIGN GAP RATHER THAN AN OVERSIGHT. One directory away, the AI call is bounded at
`timeoutMs: 300_000` with `maxRetries: 1` and a paragraph arguing the bound sits "well inside the
hourly sync cadence that fires this" (aiWorker.ts:646). The calls that fetch the actual money have
no bound and no argument. The reasoning was applied to the model call and not to the bank call.

CONSEQUENCE BEYOND SLOWNESS: `runFullSync` is blocked for the duration, the hourly scheduler's
re-entrancy guard skips passes for as long as it lasts, and `sync_runs` records a two-hour run as
`succeeded`, so nothing surfaces it.
PROVES REAL: the four grep results and the run decomposition above.
PROVES FIXED: an explicit timeout on all four sites; a test that a hung request rejects within the
bound rather than hanging; and no `sync_runs` row exceeding timeout x attempts thereafter.

## V10 [RECORD DRIFT] A standing "Open" item in STATE.md is already resolved
`.claude/STATE.md` has carried "Chase Checking unreconciled $544.18 (one payroll - likely missing
row)" as an open item since the Phase 5 era. Running `reconcileAccounts` against the live copy:
  Chase Checking   residual=54418   boundary_amount=54418   adjusted_residual=0
The boundary mechanism `reconciliation.ts` was built for explains it exactly, to the cent. It is
the documented horizon artefact (a payroll dated on the first snapshot's own date), not a missing
transaction. The item is closed and the record should say so.
Same probe, same run: the only genuinely unexplained non-market account is Wallet at -$8,000 cents
(-$80.00), and Fidelity Individual's $864.46 is the market-driven exemption working as designed.

## V11 [CAVEAT ON A FIGURE, not a finding] The AI timeout cap cannot be checked from these rows
`anthropicClient.ts:41-44` states the worker is bounded at ten minutes ("two attempts at five
minutes"). The ten `failed` ai_runs measure 644s to 2260s of wall clock, which looks like a
violation. It is not checkable: these timestamps come from a laptop, and sleep between `started_at`
and `completed_at` is indistinguishable from a long request, exactly as in V9. I am not reporting
the cap as violated. If any later work cites these durations, it must carry this caveat.


## V12 [MEDIUM] The app cannot be run against anything but the owner's real ledger
`server/src/db/index.ts:7`: `const MIZAN_DIR = path.join(process.cwd(), '.mizan')`. It is a module
constant with no environment override, and `CLAUDE.md` records the consequence for npm scripts but
not this one: there is no way to boot the app against a scratch database.

It is not merely read-only-unsafe. `server/src/index.ts` runs two startup backfills behind cheap
COUNT gates, and one of them is currently armed on the live data:
  SELECT COUNT(*) FROM transactions WHERE category_id IS NULL;      -> 0   (gate closed)
  SELECT COUNT(*) FROM accounts WHERE type_source = 'auto';         -> 5   (gate OPEN)
So starting the server runs `reclassifyAutoAccountTypes` against the owner's real financial database.

CONSEQUENCE. Anyone wanting to look at the app, drive a screen, take a screenshot, reproduce a
rendering defect, or judge the visual argument has exactly two options: mutate the owner's ledger, or
not look. This is why Part III Phases 13 and 14 are the two phases in this repo's whole history that
were fully specified and never landed, and why the one risk `rebuild-part-3.md` says it "cannot
design away" is that a palette can pass every test and still be wrong on screen ("Gate 4 is not a
formality"). Gate 4 requires running the app, and running the app costs a write to real data.
PROVES REAL: the constant, the two COUNT gates, and the count of 5.
PROVES FIXED: `MIZAN_DIR` reads an env override; booting with it set against a copied database
leaves `.mizan/mizan.db` byte-identical.

---

# Progress log

## 2026-09-01: Phases 0 through 4 landed, plus what looking at the screen found

Fourteen commits. `npm test` 1743 passing, three typechecks clean, `npm run build` clean, and the
production build verified by running it rather than by reading it.

**Phase 0.** `getSyncHealth` takes an injectable clock. The gate went from 1690/1691 to green.

**Phase 1, the bind.** `listenOnHost` in `server/src/listen.ts`, called once, in both modes.
`ViteExpress.bind` attaches Vite to the already-bound server, which is what `ViteExpress.listen`
does internally. Verified in the real app: `lsof` shows `127.0.0.1:3010`, a curl from this
machine's LAN address with a forged `Host` header now fails to connect where it previously returned
HTTP 200 on both a GET and a POST. The beyond-loopback warning is no longer behind `IS_PROD`.
`npm start` now sets `NODE_ENV=production`, which was its own finding: helmet's CSP, the production
CORS policy and `express.static(dist/client)` were all unreachable from either documented command,
so `npm run build` wrote a client bundle that `npm start` never served. Verified by running it: CSP
header present, hashed asset served, still bound to loopback.

**Also landed to make Phase 7 possible, ahead of order.** `MIZAN_DIR_OVERRIDE`. Every figure below
was then taken from the real app running against a copy, with `.mizan/mizan.db` byte-identical
before and after (sha256 `a6a5872467e3727d...`).

**Phase 2, the wrong numbers.**
- `safeToSpend` asks `calculateGoalProgress` instead of reading `goals.current_amount` raw. On the
  live ledger this moved the Balance screen's subject numeral from **"$1,036.75 short this month"
  to "$35.05"**, and the screenshot before and after is the proof. `list_goals` had the same defect
  from the other side and now asks the same function, so the chat tool and the system prompt cannot
  disagree about one goal inside one conversation.
- `confirmRecurringAdjustment` converts to cents once. Demonstrated by reintroducing the second
  conversion and watching both new tests fail.
- A sold-out position is no longer priced as a 100% unrealized loss. One shared `isLivePosition`
  predicate, used by the header, the row gain, the holdings list and the Cmd+K answer;
  `getAllocationSlices` already had this filter privately, which is how one of four consumers was
  right.
- `boundaryApplicableTo` clamps the reconciliation boundary adjustment so it can only shrink a
  residual toward zero. This was the one critical carried at 2/3 with a live dissent, so it was
  reproduced first: on a ledger that reconciles to the cent, a row dated on the last snapshot date
  produced `adjusted_residual +5000` and a row dated on the first produced `-7000` with
  `direction_conflict` TRUE. Both now report 0. The live Chase Checking case is untouched
  (residual 54418, boundary 54418, adjusted 0), which is what makes the fix conservative.

**Phase 3, the detector.** The spending spike is measured against the maximum of the six preceding
30-day windows rather than against the single window before it, with a floor under the baseline so
a ratio against near-zero cannot be printed as a reading. Replayed over the same year of the
owner's real ledger: **303 firing days became 25**, ten categories became two, and the largest
reading fell from 25000% to 497%. Those 25 days are four distinct events, each visible for 10 to 13
days because a 30-day window carries one spike for about that long. On today's data the detector is
silent, and `/api/insights` returns one positive and one info row.

**Phase 4, the sync path.**
- An unreadable `credentials.json` is a fault rather than an empty store, it is recorded as a failed
  sync run item so the run lands `partial` instead of toasting "Sync complete" in green, and every
  mutator refuses to write over a file it could not read. That last part was the destructive half:
  a re-link would have replaced the Coinbase key and every AI provider key with just the SimpleFIN
  URL.
- An unreadable Coinbase 200 no longer zeroes the whole crypto position. `accountRowsSeen`
  distinguishes an empty feed from a genuine sell-out, because a sell-out still returns rows.
- All four outbound provider calls set a timeout. They set none, axios waits forever, and
  `defaultIsRetryable` treats a statusless network error as retryable across three attempts.

**Found by looking at the screen, which no finder could do.** The Investments holdings list
rendered a $0.38 position, a $0.21 position and a $0.01 balance all as "$0", and one row read
"−$0 · 12.5%": a percentage stated against an amount printed as nothing. A per-unit price went
through the whole-dollar formatter, so POL at $0.090195 rendered as "$0" while CLAUDE.md explains
at length why the database keeps that precision. Both fixed with named formatters and property
tests. This is the class of defect Phase 7 was written to reach, and it was reachable within
minutes of the app being runnable.

**Corrected mid-flight.** V6 in this document claimed "the detectors are silent on the owner's real
data" on the strength of three detectors. The one I did not run was firing 83% of the year. The
claim is struck above and the measurement that replaced it is stated with its query.
