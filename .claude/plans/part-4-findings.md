# Part IV appendix: the deep audit, in full

Run 2026-08-31 against HEAD `58463e7`. 27 finders over record drift, bug projection by lens, the
egress boundary, subtraction and the design argument; every finding then attacked by three
independent refuters (code, data, record) instructed to default to refuted when uncertain.

    144 raw findings from 27/27 finders
    144 after dedup
    CAPPED: top 130 verified; 14 low-severity findings were NOT verified and are NOT reported
    68 survived 2-of-3 adversarial refutation, 62 refuted

Cost: 418 agents, 35.7M tokens, 10,518 tool calls, 3h 57m.

`2/3 kept` means one refuter dissented; the dissent is printed with the finding. A dissent is not
noise: finding 1 below is carried at 2/3 and its dissent argues the reachability premise is
empirically false, which is a live disagreement and is flagged as such in the plan.

Findings the main loop verified independently, by running code rather than reading it, are marked
**[independently verified]**. Everything else carries the finders' evidence as written.

---

## 1. [CRITICAL] `boundary_amount` is subtracted unconditionally, so it manufactures an unexplained residual and a false `direction_conflict` on a ledger that reconciles to the cent

`reconciliation` | 2/3 kept | finder confidence: verified | found by: reconciliation-networth

**Evidence.** server/src/services/reconciliation.ts:293-304 computes `boundaryAmount = firstDayTotal -
lastDayTotal` from the raw same-day sums and always applies `adjustedResidual = residual -
boundaryAmount` and `adjustedExplained = explainedDelta + boundaryAmount` (:304), which then decides
`direction_conflict` (:320-325) and `unreconciled` (:333-344). The doc comment at :50-61 calls it
"the part of `residual` that is an artifact of where the horizon was cut", but nothing checks that
the residual contains that artifact. Reproduced by running the real `reconcileAccounts` over
`migratedTestDb()` fixtures (scratchpad script, nothing written to the repo): CASE A, one asset
account, snapshots 2026-08-01 $1,000.00 and 2026-08-31 $1,050.00, one +$50.00 row dated 2026-08-31
already in the last balance -> observed 5000, explained 5000, residual 0, boundary_amount -5000,
adjusted_residual +5000, `unreconciled` = [Checking A], `unreconciledResidual` 5000. CASE B,
snapshots 2026-08-01 $1,020.00 and 2026-08-31 $1,000.00, a +$70.00 row dated 2026-08-01 already in
the first balance and a -$20.00 row mid-window -> observed -2000, explained -2000, residual 0,
boundary_amount 7000, adjusted_residual -7000, direction_conflict TRUE. Why the in-balance state is
the ordinary one at the last end: `SimplefinAccountPayload` carries `balance` and `transactions` in
one object (server/src/services/simplefin.ts:70-72), `syncSimplefinAccounts` writes
`current_balance` from `acct.balance` (:791) then posts `acct.transactions` from the same payload
(:830), and `takeSnapshot()` records that balance as today's measured sheet at stage 90 of the same
run (server/src/services/syncManager.ts:499-501). On the live copy 23 of the 25 measured snapshot
dates carry same-day posted rows (up to 457708 cents of absolute same-day activity on 2026-08-10);
only 2026-08-08 and today's 2026-08-31 do not, which is the only reason the live report currently
shows boundary_amount 0 on every account except the two whose first end is 2026-06-30.

**Failure scenario.** On any sync day where a transaction dated today has already posted and reached `current_balance`
(the default for SimpleFIN, one payload), that account's `adjusted_residual` gains exactly that
day's net. `/api/insights/reconciliation` publishes `unreconciled_residual` > 0, and
`aiContext.ts`'s `### Ledger Integrity` block, which prefaces every AI prompt, writes for CASE B:
"Checking B: the balance shows a fall of $20.00 where the transactions account for a rise of $50.00,
leaving $70.00 unexplained between 2026-08-01 and 2026-08-31, and the transactions point the
opposite way from the balance movement." Every clause is false; the ledger explains the balance
exactly.

**Proves it real.** Run `reconcileAccounts` on a `migratedTestDb()` fixture with two measured snapshots and a boundary-
day transaction whose effect IS in that snapshot's balance: `residual` comes back 0 and
`adjusted_residual` comes back equal to that transaction, with `direction_conflict` true in the
first-end variant. Every existing boundary test (tests/reconciliation.test.ts:127-144, :146-161,
:196-216) builds only the mirror state where the boundary row is NOT in the snapshot balance, which
is why four adversarial rounds could not see this.

**Proves it fixed.** The adjustment stops being unconditional: `boundary_amount` may only remove what the residual
actually contains, e.g. clamped so it can never raise `Math.abs(adjusted_residual)` above
`Math.abs(residual)`, or surfaced as a two-sided uncertainty band rather than a point subtraction.
Regression tests for both states at both ends: boundary row in the balance (adjusted_residual 0,
direction_conflict false, unreconciled empty) and boundary row not in the balance (the existing
assertions still hold).

**Dissent (1 of 3 refuters).** REFUTED as stated (critical, "the ordinary case"). The code behavior is real; the reachability
premise is empirically false.  1) The reproduction is conceded. I ran the real `reconcileAccounts`
over `migratedTestDb()` fixtures (scratchpad only, nothing written to the repo) and got the finder's
exact

---

## 2. [CRITICAL] A fully sold position keeps its cost basis, so the Investments header reports the sale as a 100% unrealized loss

`investments / cost-basis` | 3/3 kept | finder confidence: verified | found by: investments

**Evidence.** server/src/services/simplefin.ts:147-149 and server/src/services/coinbase.ts:511-513 zero a vanished
position with `UPDATE holdings SET quantity = 0, institution_value = 0` and leave `cost_basis` (and
`cost_basis_quality`) untouched. Nothing downstream excludes a zero-value row:
client/src/lib/investmentAnalytics.ts:269-279 (`effectiveCostBasis`/`holdingGain`) only refuses a
non-positive BASIS, :281-314 (`getCostBasisStats`) sums basis and market value over `known` with no
value filter, client/src/views/Investments.tsx:251 feeds it every portfolio holding, and :390-418
renders every one of them as a row. server/src/services/advisorTools.ts:613-618 repeats the same
arithmetic for the Cmd+K investments answer. The contrast is in the same file:
client/src/lib/investmentAnalytics.ts:437-442 explicitly filters `group.value > 0` out of the
allocation bar and its comment names sold-and-zeroed positions as the reason, so exactly one of
three consumers was fixed. Reproduced in-process against a `migratedTestDb()`; no files written.

**Failure scenario.** Owner sells their whole VT position. The next SimpleFIN sync stops reporting it, so the row is
zeroed but keeps its $1,199.84 provider basis. The header goes from `Cost basis $2,302.60 / up
$112.79 / 4.90%` to `Cost basis $2,302.60 / down $1,175.77 / 51.06%` off the same two-position basis
total, and the holdings list gains a permanent row reading `$0 / -$1,199.84 / 100.0%` for a security
the owner no longer holds. The Cmd+K investments answer prints the same false loss. Nothing on
either surface says a sale happened; the loss is labelled unrealized and the row's
`cost_basis_quality` still claims 'provider'.

**Proves it real.** Repro: migratedTestDb, insertAccount(type brokerage), upsertHoldingsFromSimplefin with VT+FSKAX,
then upsertHoldingsFromSimplefin with FSKAX only, then
getCostBasisStats(listHoldingsWithMetadata(db)). Returns knownCount 2, knownCostBasis 230260,
unrealized -117577, returnPct -51.06, with the VT row at quantity 0 / value 0 / cost_basis 119984 /
quality 'provider'. Honest caveat: the live DB does not currently manifest this. The only zero-value
holding today (a USDC dust position) carries a NULL basis, and Coinbase never writes a basis at all
(services/coinbase.ts:190-201). The mechanism is verified; the first full sale of a Fidelity
position triggers it.

**Proves it fixed.** The zero-out passes must record that the position is gone rather than only that it is worth nothing
(clear cost_basis, or carry an explicit closed marker), and getCostBasisStats, holdingGain, the
holdings list and advisorTools' analyzeInvestments must all resolve 'is this a live position'
through one shared predicate the way effectiveCostBasis already centralises 'is this basis known'.
Regression test: seed two positions with provider basis, sync a feed that drops one, assert the
header stats are unchanged for the surviving position, that the sold row renders no gain, and assert
the same silence from advisorTools. Fixed in the write path, not by a migration nulling the basis of
today's zeroed rows.

---

## 3. [CRITICAL] confirmRecurringAdjustment converts dollars to cents twice: an owner-confirmed bill reprice is stored 100x too large

`money-boundary` | 3/3 kept | finder confidence: verified | found by: budget-recurring

**[independently verified]** Verified: `advisorDrafts.ts:961` toCentsOrNull -> `recurringAdjustments.ts:105` toCents. The other
caller, `routes/recurring.ts:236`, converts once.

**Evidence.** server/src/services/advisorDrafts.ts:961 `adjusted_amount: toCentsOrNull(payload.adjusted_amount)`
-> server/src/services/recurringAdjustments.ts:105 `adjusted_amount:
toCents(input.adjusted_amount)`. The payload unit is documented as dollars at
shared/schemas/index.ts:216-218 and produced in dollars by advisorDrafts.ts:495-498 (`moneyAmount()`
returns a plain dollar number, signed negative for an expense category). The comment at
advisorDrafts.ts:954-956 states the requirement ("payload.adjusted_amount is dollars ... must be
stored in cents") and then reaches cents twice. The other caller of the same service,
routes/recurring.ts:236, passes `req.body` in dollars and converts exactly once, so the two callers
hold contradictory unit contracts for one function. Swept the sibling handlers: confirmBudget
(advisorDrafts.ts:881) and confirmGoalTarget (advisorDrafts.ts:925) each call toCents once and then
write raw SQL; confirmManualCostBasis (advisorDrafts.ts:975) passes dollars raw to
setManualCostBasis, which converts at investmentMetadata.ts:172. All three are correct; this is the
only handler that converts AND calls a converting service.

**Failure scenario.** Owner asks Cmd+K "adjust the recurring Comcast bill to $180". draftRecurringAdjustment builds
payload.adjusted_amount = -180 (dollars). Owner confirms the queued draft
(create_recurring_adjustment is proposal_only, so a human approval is required and given).
confirmRecurringAdjustment -> toCentsOrNull(-180) = -18000 -> upsertRecurringAdjustment ->
toCents(-18000) = -1800000. recurring_occurrence_adjustments.adjusted_amount = -1,800,000 cents.
buildOccurrence (recurringForecast.ts:79-81) substitutes it for the pattern amount,
routes/recurring.ts:38 dollarizes to -$18,000.00. GET /api/recurring/forecast then reports an
$18,000 bill: forecast.bills and forecast.net are wrong by $17,820, and that propagates to the
Ledger spine (client/src/views/ledger/spine.ts:170), Instrument's next-bill reading
(client/src/views/Instrument.tsx:766), and client/src/lib/goalForecast.ts:50-53
monthlyRecurringSurplus, which feeds every goal's projected completion date.

**Proves it real.** In a migratedTestDb, insert a recurring pattern, call confirmAdvisorDraft on a
create_recurring_adjustment draft with payload.adjusted_amount = -180, then `SELECT adjusted_amount
FROM recurring_occurrence_adjustments`. It returns -1800000; the correct value is -18000.
Equivalently, PUT /api/recurring/:id/adjustments with adjusted_amount -180 stores -18000, so the
same user intent lands 100x apart depending on which surface expressed it.

**Proves it fixed.** Drop the toCentsOrNull at advisorDrafts.ts:961 so the handler passes dollars, matching the route
caller (or invert: make upsertRecurringAdjustment take cents and convert at both call sites).
Regression test asserting BOTH callers produce the same stored cents for the same dollar figure,
plus the existing skip case (adjusted_amount null) still stores NULL and writes nothing new.
tests/recurringAdjustments.test.ts and tests/aiFeedback.test.ts:257 only exercise action:'skip',
where adjusted_amount is null and both conversions are no-ops, which is why four verification rounds
passed over this.

---

## 4. [CRITICAL] The spending-spike detector is a chronic standing false positive: it fires on 68% of days of the owner's real ledger

`detectors / insights` | 3/3 kept | finder confidence: verified | found by: detector-silence

**Evidence.** server/src/services/anomalyInsights.ts:72-74 (HAVING current_spend >= 30000 AND current_spend -
previous_spend >= 20000 AND (previous_spend = 0 OR current_spend >= previous_spend * 1.75));
:117-137 (message + `up N%`); server/src/routes/insights.ts:336 (fed into /api/insights);
server/src/services/advisorTools.ts:505 (same detector powers Cmd+K);
client/src/views/Instrument.tsx:562 (`insightsQ.data?.[0]` - one slot) and :779-800 (an AI draft
gets a Dismiss button, an insight gets only its action route: there is no dismiss). Measured by
running getAnomalyInsights against live.db once per day: 2023-10-01..2026-08-31 = 1066 days, spike
fires on 726 (68.1%); last 365 days 303/365; 116 of those days print a percent >= 1000%. Categories
that fired: Shopping 186 days, Travel 179, Food & Drink 149, Education 60, Home 40, Transport 30,
Pets 17, Entertainment 16, Taxes 13, Health 5. Replicating the route's severity/rank ordering with
an injected clock, the spike would be the served insight[0] on at least 369 of those 1066 days
(lower bound: the one budget row in `budgets` was created 2026-07-09 but carries no month, so the
simulation lets budget-over outrank it retroactively on days it could not have fired).

**Failure scenario.** The owner's Home category holds one ~$2,000 monthly rent payment. It lands inside the rolling
[now-29, now] window and no comparable charge lands in [now-59, now-30], so previous_spend is $15.84
and current_spend is $2,045.92. The gates pass and /api/insights serves severity 'warning' with the
message "Home spending is up 12816% versus the prior 30 days" and metric "$2,030" (the delta, not
the spending, sitting next to a percent a reader will attach to it). More generally the gates are
$300 current, $200 delta and a 1.75x ratio, which ordinary month-to-month variance in
Food/Shopping/Travel clears on two days out of three. There is no dismiss and no cooldown, so the
row occupies the single "Needs you" sentence on the home screen for as long as the window straddles
the charge - up to 30 consecutive days per lumpy bill. This is rule 3 twice over: it is not silent
on an ordinary healthy event (rent being paid; a month with more travel than last month), and "Open
reports" navigates to /?window=this-month, a calendar-month screen that cannot reproduce a
rolling-30-day percent, so there is nothing to act on when the owner arrives.

**Proves it real.** Run `getAnomalyInsights(db, new Date('2026-08-31T12:00:00Z'))` against a copy of .mizan/mizan.db: it
returns exactly one row, spending-category-spike, message "Home spending is up 12816% versus the
prior 30 days". Then sweep `now` daily across the ledger's span and count firing days; 726/1066
reproduces. `SELECT substr(date,1,7), SUM(-amount) FROM transactions t LEFT JOIN categories c ON
c.id=t.category_id LEFT JOIN categories p ON p.id=c.parent_id WHERE pending=0 AND
COALESCE(p.name,c.name)='Home' GROUP BY 1` shows the Home series is 3 rows in the current window
against 1 row in the prior one.

**Proves it fixed.** A healthy-case test in tests/anomalyInsights.test.ts built from a monthly-cadence bill (same charge,
~30 days apart, straddling the window boundary) and from a steady spender with ordinary month-to-
month variance, asserting `getAnomalyInsights` returns []. Plus the daily sweep above over a
realistic multi-year fixture holding under a few firings per year rather than 726/1066. A fix has to
stop comparing one rolling window to its neighbour on a category whose history is lumpy: require a
stable prior baseline (several comparable periods, not one), and either bound or drop the percent
when previous_spend is small, since 12816% is not a reading.

---

## 5. [CRITICAL] A credentials decrypt failure is swallowed into "nothing is configured", and the startup guard whose comment claims to surface it is unreachable

`sync` | 3/3 kept | finder confidence: verified | found by: error-handling

**Evidence.** server/src/services/credentials.ts:136-144, `loadCredentials()` wraps the read+decrypt in try/catch
and on ANY failure does `console.error(...)`, `_cache = {}`, `return _cache`. It has no throw path
outside that try (fs.readFileSync, JSON.parse and decrypt() are all inside it), so the function is
total. server/src/index.ts:79-86, the startup pre-warm: comment says "Decryption depends on the OS
keychain, which can fail (locked keychain, moved .mizan dir). Surface that clearly rather than dying
anonymously", then `try { loadCredentials(); } catch (err) { console.error('[fatal] Could not load
stored credentials...'); throw err; }`. That catch can never run for the failure the comment names.
server/src/services/credentials.ts:164-168, `getCredentials()` = stored spread +
`getEnvCredentials()`; server/src/services/credentials.ts:153-162 shows the env override covers
Coinbase only, so SimpleFIN has no fallback source. server/src/services/syncManager.ts:599 (`if
(creds.simplefin?.accessUrl)`) and :632 (`if (creds.coinbase)`), both branches are simply skipped,
writing no sync_run_items at all. server/src/services/syncManager.ts:734-736, `finishSyncRun(...,
status: deferredError ? 'partial' : 'succeeded', message: ... 'Sync complete')`; `deferredError` is
still null. server/src/services/syncHealth.ts:190, `incomplete: row.status === 'partial' ||
row.status === 'failed'` → false. client/src/hooks/useSyncStatus.ts:40-45, `sync_complete` with
`partial` false fires a green `{type:'success', message:'Sync complete'}` toast.
client/src/views/Instrument.tsx:440-452, the beam's calibration comment names `sync_runs` as "the
only place that distinction is durable" and feeds `syncHealthQ.data?.last_run?.incomplete` into
`readCalibration` (Instrument.tsx:489-496). Amplifier: server/src/services/credentials.ts:147-151
`saveCredentials` writes whatever `loadCredentials()` returned; :170-174
`updateCoinbaseCredentials`, :176-180 `updateSimplefin`, :203-207 `updateAiKey` all do
`loadCredentials()` → mutate → `saveCredentials()`.

**Failure scenario.** macOS keychain is locked / `@napi-rs/keyring` cannot read the `mizan/encryption_key` entry (or
`.mizan` was moved and the legacy key file is gone, so `getDerivedKey()` at credentials.ts:88-101
mints a fresh random key). `decrypt()` then fails GCM auth on `.mizan/credentials.json`.
`loadCredentials()` logs once to stderr and returns `{}`. The server boots normally. Every hourly
`runFullSync()` skips SimpleFIN and skips Coinbase, records zero provider run items, runs the post-
sync stages, and finishes with `status='succeeded'`, `message='Sync complete'`; the client shows a
green "Sync complete" toast, `last_run.incomplete` is false, and the balance beam stays fully
calibrated on a sheet no provider refreshed. `_cache` is module-level, so the poisoning persists for
the process lifetime. If the owner then reacts to "SimpleFIN not connected" in Settings by re-
linking, `updateSimplefin()` re-encrypts `{simplefin:{accessUrl}}` over the file and the Coinbase
key and all stored AI provider keys are destroyed with no warning.

**Proves it real.** Run the server with `.mizan/credentials.json` present but its ciphertext corrupted by one byte (or
with the keychain entry deleted). Confirm: stderr shows `[credentials] Failed to decrypt
credentials`, the process does NOT exit despite index.ts:84's `[fatal]` copy, and the next
`sync_runs` row is `status='succeeded'` with zero `sync_run_items` for simplefin/coinbase. Then hit
`PUT /api/settings/simplefin` and confirm the re-encrypted file no longer contains the Coinbase or
AI keys.

**Proves it fixed.** `loadCredentials()` distinguishes "no credentials file" from "credentials file present but
unreadable", e.g. it throws (letting index.ts:83's guard become live) or returns an explicit `{
unreadable: true }` that `runFullSync` records as a failed/partial run item and that every mutating
`update*` refuses to overwrite. A test that writes a migratedTestDb-adjacent fixture with a corrupt
credentials file and asserts (a) the sync run is not `succeeded`, and (b) `updateSimplefin` refuses
rather than clobbering the other keys.

---

## 6. [CRITICAL] The server never binds to loopback: MIZAN_HOST is inert under both documented commands, and the app listens on every interface

`security-boundary` | 3/3 kept | finder confidence: verified | found by: security-localguard

**[independently verified]** Reproduced end to end: `ViteExpress.listen` passes no host, Node binds `::`, and with
MIZAN_HOST=127.0.0.1 explicitly set the bind is still `::`. Then, using the app's own `localGuard`
on a no-database harness, a GET and a POST from this machine's LAN address (10.29.160.206) with a
forged `Host` header both returned HTTP 200.

**Evidence.** server/src/index.ts:166-168, `const server = IS_PROD ? app.listen(PORT, HOST, announce) :
ViteExpress.listen(app, PORT, announce);`. `IS_PROD = process.env.NODE_ENV === 'production'`
(index.ts:38). `npm run dev` = `tsx watch --env-file-if-exists=.env server/src/index.ts` and `npm
start` = `node --env-file-if-exists=.env dist/server/src/index.js` (package.json:10,17), neither
sets NODE_ENV, and `.env` holds only COINBASE_KEY_NAME, COINBASE_PRIVATE_KEY, ANTHROPIC_API_KEY,
MIZAN_AUTO_SYNC_ON_STARTUP (4 keys, verified by name-only grep). So the `!IS_PROD` branch is always
taken. node_modules/vite-express/dist/main.js:317-319, `function listen(app, port, callback) {
const server = app.listen(port, () => bind(app, server, callback)); return server; }`, no host
argument, and dist/main.d.ts:34 has no host parameter, so one cannot be passed. Empirically
confirmed the default: `app.listen(0, cb)` reports `{"address":"::","family":"IPv6"}` (dual-stack,
all interfaces). The claims this contradicts: README.md:266 "It binds to loopback (`MIZAN_HOST` to
change), so it is not reachable from the LAN."; CLAUDE.md:317 "The server binds to loopback
(`MIZAN_HOST`, `server/src/index.ts`)"; index.ts:39-42 "bind to loopback so the API (and all the
financial data behind it) isn't reachable from the LAN by default." The "binding beyond loopback"
warning at index.ts:163-165 is gated on `IS_PROD && !HOST_IS_LOOPBACK`, so it can never print, the
owner is never told.

**Failure scenario.** Owner runs `npm run dev` on campus wifi or any shared LAN. Port 3001 is open on every interface.
localGuard is the only remaining defense and it is a browser-only defense: a non-browser peer forges
the Host header. `curl -H 'Host: localhost:3001' http://<laptop-ip>:3001/api/settings/backup-json`
-> localGuard.ts:72 finds 'localhost:3001' in allowedHosts, method is GET so the Origin check at
localGuard.ts:75 is skipped entirely -> the full ledger (2,723 transactions, 14 accounts, all
balances) comes back as JSON. Writes are just as open: localGuard.ts:75 only checks Origin `&&
req.origin`, and tests/localGuard.test.ts:39 asserts exactly this ("allows a POST with no Origin
header (curl / non-browser clients)"), so `curl -H 'Host: localhost:3001' -X DELETE
.../api/settings/data` or any POST reaches the write path with no Origin header at all.

**Proves it real.** On a machine with `npm run dev` running, `lsof -nP -iTCP:3001 -sTCP:LISTEN` shows `*:3001`, not
`127.0.0.1:3001`. Then from a second machine on the same network: `curl -s -H 'Host: localhost:3001'
http://<ip>:3001/api/health` returns 200 with data instead of connection-refused.

**Proves it fixed.** `lsof -nP -iTCP:3001 -sTCP:LISTEN` shows `127.0.0.1:3001` under `npm run dev`, and a curl from
another host gets connection-refused regardless of Host header. Structurally: replace
`ViteExpress.listen(app, PORT, announce)` with `const server = app.listen(PORT, HOST, announce);
ViteExpress.bind(app, server, announce);` (vite-express exports `bind(app, server, cb)` , 
main.js:296) so the same HOST governs both branches, and move the "binding beyond loopback" warning
out from behind `IS_PROD`. Regression test: start the real `main()` on port 0 with MIZAN_HOST unset
and assert `server.address().address === '127.0.0.1'`.

---

## 7. [CRITICAL] Two definitions of a goal's saved amount: `/` free-to-spend is understated by $1,001.70 today

`money-boundary` | 3/3 kept | finder confidence: verified | found by: duplicated-logic

**[independently verified]** Verified on live data: goal `Emergency Fund` carries current_amount 100170 and its linked
Wealthfront Cash account carries current_balance 0, so safe-to-spend subtracts $1,001.70 for a goal
/plan reports as $0 saved.

**Evidence.** `server/src/services/goalProgress.ts:18-28` is the shared definition: when a goal is linked to an
account it OVERRIDES the stored `goals.current_amount` with `Math.max(account_balance, 0)` for a
savings goal. Four consumers use it: `server/src/routes/goals.ts:59,68` (the `/plan` screen),
`server/src/routes/insights.ts:438,466`, `server/src/services/aiContext.ts:1143`,
`server/src/services/advisorTools.ts:467` (Cmd+K). One bypasses it:
`server/src/services/safeToSpend.ts:96-99` reads `SELECT current_amount FROM goals WHERE is_archived
= 0 AND type = 'savings'` raw and reduces it into `allocatedGoals`, which `GET /api/insights/safe-
to-spend` (`server/src/routes/insights.ts:150-170`) serves as `allocated_goals` and subtracts from
`free`.  Live DB (read-only copy), one active goal:   `SELECT COALESCE(SUM(current_amount),0) FROM
goals WHERE is_archived=0 AND type='savings'` -> **100170** (what safeToSpend subtracts)   `SELECT
MAX(COALESCE(a.current_balance, g.current_amount),0) FROM goals g LEFT JOIN accounts a ON
a.id=g.account_id WHERE g.is_archived=0` -> **0** (what calculateGoalProgress returns; the linked
account is a `savings` account at `current_balance = 0`) Liquid pool for the same sheet: `SELECT
SUM(current_balance) FROM accounts WHERE is_hidden=0 AND type!='closed' AND is_liability=0 AND type
IN ('checking','savings','cash')` -> 671202 cents.  The contradiction lands on ONE screen.
`client/src/views/instrumentReadings.ts:62-67` labels the term "goal earmarks" and `:95` renders
"Left in the liquid pool after cards, the next N days of dated bills, budgeted allocations and goal
earmarks", while `client/src/views/Instrument.tsx:560,772` renders the same goal from the goals API
as "$5,000 to go" (0% saved).

**Failure scenario.** A savings goal is linked to an account. The owner moves the money out of that account (or never
funded it), so the linked balance is 0 while `goals.current_amount` keeps whatever was last written.
`/plan` and the AI context both say the goal has $0.00 saved and $5,000.00 remaining. `GET
/api/insights/safe-to-spend` reports `allocated_goals = 1001.70` and subtracts it, so the Balance
screen's subject figure ("free to spend" / "short this month") is off by exactly $1,001.70 against a
liquid pool of $6,712.02, and if the sheet is short, `readStanding` can name "goal earmarks" as the
largest single claim on money nothing else says is earmarked. Inverted case: the linked account
grows past `current_amount` and the earmark is understated, so `free` reads too high.

**Proves it real.** Call `GET /api/goals` and `GET /api/insights/safe-to-spend` against the live database in the same
second: the goal's `current_amount` is 0.00 in the first and its contribution to `allocated_goals`
is 1001.70 in the second, from the same `goals` row. Or run the two SQL statements above.

**Proves it fixed.** `computeSafeToSpend` computes each goal's earmark through `calculateGoalProgress` over the same
`LEFT JOIN accounts` row shape the other five call sites use, so the six consumers read one
definition. Regression test: `migratedTestDb()` fixture with a savings goal whose `current_amount`
is nonzero and whose linked account balance is 0, asserting `computeSafeToSpend(...).allocatedGoals`
equals the goals route's `current_amount` in cents, and a second case with the linked balance above
`current_amount` so the test fails in both directions rather than only pinning zero.

---

## 8. [CRITICAL] An empty or unreadable Coinbase 200 zeroes the entire crypto position, and the same run snapshots the zero as measured

`sync` | 3/3 kept | finder confidence: inferred | found by: sync-writepath

**Evidence.** server/src/services/coinbase.ts:376 (`return response.data as T`, no shape check); :471 (`for (const
account of data.accounts || [])`); :479 (`if (balanceValue <= 0) continue`); :499-502 (`hasNext =
data.has_next || false`); :504-515 (stale-coin zeroing pass, no emptiness guard); :518-534
(`totalCents` from the just-zeroed holdings, then `UPDATE accounts SET current_balance = ?`).
Contrast the SimpleFIN side, which has both guards: server/src/services/simplefin.ts:204-212
(`simplefinAccountsOrThrow` refuses a 200 with no accounts array) and :393-398 (`if
(seenAccountIds.size === 0) return []`, "Total absence is the 'unknown' case, never the 'closed'
case"). The claim that they are aligned is at simplefin.ts:91-93: "coinbase.ts already zeroed its
side; this brings the two providers into line." Then server/src/services/syncManager.ts:499-513 runs
`takeSnapshot()` in the same run. Live DB: the Coinbase account holds 48685 cents across 8 holdings,
and every one of the 41 net_worth_snapshots rows is `is_estimated = 0`.

**Failure scenario.** The v3 brokerage accounts endpoint answers 200 with a body that has no usable `accounts` array (a
maintenance/HTML page, a JSON error envelope, an empty default portfolio, or every coin reporting
`available_balance.value` absent so `parseCoinbaseNumber(value ?? '0')` at coinbase.ts:293-299
returns 0 and :479 skips it). `seenCurrencies` ends empty, so all 8 holdings are set to quantity 0 /
institution_value 0, `totalCents` is 0, and `accounts.current_balance` for Coinbase is written 0.
Nothing throws, so the stage is recorded 'succeeded'. `takeSnapshot()` then writes today's
net_worth_snapshots row with `is_estimated = 0` and `covered_accounts = total_accounts = 14`,
understating net worth by $486.85 and recording it as an observed fact for the day. The balances
return on the next good sync; the poisoned snapshot does not.

**Proves it real.** Split the write half of `syncCoinbase` out the way `applySimplefinResponse` was split from
`syncSimplefin`, then drive it against `migratedTestDb()` with a seeded 8-coin Coinbase account and
a response body of `{}`, `{accounts: []}`, and `'<html>maintenance</html>'`. Assert current_balance
and every institution_value after each. Today there is no seam at all: grep shows `syncCoinbase` is
referenced only by syncManager.ts:635 and routes/coinbase.ts:85,130, and by no test file, so this
path has never been executable without the network.

**Proves it fixed.** The accounts pull refuses an unreadable body (a `coinbaseAccountsOrThrow` mirroring
simplefin.ts:204-212), and the zeroing pass at coinbase.ts:504-515 returns early when
`seenCurrencies.size === 0`, with a test that seeds holdings, feeds an empty response, and asserts
every institution_value and the account balance are unchanged. Silence on the healthy case (one coin
genuinely sold out of eight) must be asserted in the same file.

---

## 9. [HIGH] rebuild-part-3.md Decision 1 commits to "Bone and Signal"; the commit that added the file shipped a different palette, and the plan was never amended

`docs` | 2/3 kept | finder confidence: verified | found by: drift-part3

**Evidence.** .claude/plans/rebuild-part-3.md:47 ("Decision 1: build Bone and Signal, with three grafts") through
:330, all added by commit 4a2db38, whose subject is "Go pure black and white, and carry every
meaning on its own primary". `git log --oneline -- .claude/plans/rebuild-part-3.md` returns exactly
one commit: 4a2db38. What shipped, from client/src/index.css:282-338: `--mz-paper-c: 255 255 255`
and dark `--mz-paper-c: 0 0 0` (index.css:532), every neutral r==g==b, semantic chroma measured by
me from the shipped triplets as sage 0.1595, sage-deep 0.1596, clay 0.1351, gold 0.1248, info
0.2001, review-text 0.2097, estimate 0.0547.

**Failure scenario.** Bone and Signal is specified as a warm paper at 20-neutral CIELAB Cab mean 3.62 with six semantic
hues spread at a minimum 32.6 degree gap; the shipped palette is pure white / pure black with every
neutral at chroma 0.000 exactly. Every measured table in Decision 1 (the L* 52-55 / L* 60-62 line-2
budget, the clay L* 28-31 sweep, the Fault 1/3/4 comparison table, the 0.0336 inverted-chroma
margin, the "nine rail exceptions all clear" figures at 5.85 / 6.78 / 6.43 / 6.01) is a measurement
of triplets that are not in the repo. A reader who opens the tracked long-form record to answer "why
is this token this value" gets seventy figures that do not re-derive from index.css. Two commitments
that only make sense under Bone and Signal read as separate failures downstream: rebuild-
part-3.md:424 promised railGround.test.ts's exception list would go empty, and
tests/railGround.test.ts:22-25 instead records `gold` at four sites plus one style-prop site as
still failing; rebuild-part-3.md:461 promised "it does not move any call site", and 4a2db38 touched
15 files under client/src.

**Proves it real.** `git log -1 --format=%s 4a2db38` beside `git show --stat 4a2db38 | grep rebuild-part-3`, then grep
any Decision 1 figure (e.g. "3.62", "32.6 degrees", "L* 52") against a re-derivation from the
current index.css triplets. None reproduces. Contrast with .claude/plans/relink-and-close.md:498
("Correction to rebuild-part-3.md Decision 6") and :212 ("Two figures in the brief above did not
reproduce, and both are corrected in place"), which prove the errata mechanism is in active use and
was simply never applied to the palette decision.

**Proves it fixed.** An amendment block at the head of Decision 1 stating which palette shipped and on what date, with
every superseded figure either struck or re-derived from the shipped triplets, in the same style as
relink-and-close.md:498. `git ls-files` already tracks the file, so the amendment is reviewable.

**Dissent (1 of 3 refuters).** REFUTED as noise: the pivot the finder says "was never amended" is recorded everywhere the record is
load-bearing, and two of the three legs are wrong.  Facts the finder got right:
`.claude/plans/rebuild-part-3.md:47` and `:617` do commit to "Bone and Signal" (warm paper,
20-neutral CIELAB Cab 3.62)

---

## 10. [HIGH] Every SimpleFIN backfill floor was rewritten to 2026-07-31 in the database, freezing 384 provider rows against their own provider and falsifying three recorded claims

`sync` | 3/3 kept | finder confidence: verified | found by: drift-relink

**Evidence.** Live DB: `SELECT account_name, backfill_floor_date FROM accounts WHERE backfill_floor_date IS NOT
NULL` -> all nine SimpleFIN accounts read 2026-07-31 (Coinbase alone still reads 2025-09-04).
`SELECT t.source_type, COUNT(*) FROM transactions t JOIN accounts a ON a.id=t.account_id WHERE
a.backfill_floor_date IS NOT NULL AND t.date < a.backfill_floor_date GROUP BY 1` -> import 2195,
simplefin 384. Per account the oldest provider row runs 2026-04-08..2026-06-22, so every floor now
sits above provider history it was never meant to cover. Four written records contradict the live
values: server/src/services/balanceHistory.ts:129-131 ("every one of the 2,196 rows below a floor in
the live database is `source_type = 'import'`, and BofA Cash Rewards' ledger genuinely reaches
2023-09-16 under a 2026-04-27 floor" -- BofA's floor is 2026-07-31 and 384 provider rows are below
floors); server/src/services/liabilitySign.ts:131 ("Discover's backfill_floor_date is 2026-06-16");
server/src/db/migrations/055_simplefin_relink_proposals.sql:23 with .claude/plans/relink-and-
close.md:68 ("9 of 9, running 2026-04-08 to 2026-06-22"); and data/backfill/floors.json (untracked,
written 2026-07-27) which still carries the per-account dates. No code in server/src writes this
column; the only writer is scripts/backfill/floor-map.ts:49-66 `--apply`. Nothing in the repo or the
plans records the change.

**Failure scenario.** An institution revises any of those 384 posted rows -- a partial reversal, a corrected amount, a re-
posted charge -- and the next sync hits simplefin.ts:837, increments `skipped`, and drops it.
`skipped` is the same counter used for amount-parse failures (simplefin.ts:847), so the sync panel
cannot distinguish "this row is below a floor you set" from "this row would not parse", and neither
is named. The ledger keeps the stale figure permanently with nothing on screen saying it was
refused. This also silently changed what `resolveStart` (balanceHistory.ts:136-160) depends on: it
truncates an account's series at the floor exactly when no `source_type='import'` row sits below it,
and the comment above it asserts that case cannot arise. It still does not fire today only because
all nine accounts happen to retain at least one import row below floor, which is a coincidence the
comment presents as a property.

**Proves it real.** Re-derive per account: `SELECT a.account_name, a.backfill_floor_date, MIN(CASE WHEN t.source_type
NOT IN ('import','manual') THEN t.date END) FROM accounts a JOIN transactions t ON t.account_id=a.id
GROUP BY a.id` -- every SimpleFIN row shows a floor strictly later than its own oldest provider
date. Then drive `applySimplefinResponse` over a copy with a response re-serving any 2026-06
provider row: the write is skipped and the only visible effect is the `skipped` count.

**Proves it fixed.** Floors re-derived per account from each account's own oldest provider-served date (or a recorded,
dated decision in the plan files stating why a uniform 2026-07-31 freeze was applied and what it is
protecting), plus the three comment sites corrected to the values the live database actually holds,
plus a distinct counter/reason for below-floor skips so they are not pooled with parse failures.

---

## 11. [HIGH] The excluded-flows accounting the data-quality panel points the owner to does not exist on any screen

`reporting` | 3/3 kept | finder confidence: verified | found by: drift-claudemd

**Evidence.** server/src/services/dataQuality.ts:205-212 justifies the panel's silence: "Excluding transfers,
investment and crypto flows from income and spending totals is the intended behaviour ... and the
counts still reach the owner where they belong: `ReportSummary.excluded_flows` on the Reports screen
and in the advisor's financial context." At HEAD there is no Reports screen: client/src/views/
contains no Reports.tsx, and client/src/App.tsx:75 redirects `{ from: '/reports', to:
'/?window=this-month' }`. `grep -rn "excluded_flows" client/src/views client/src/components` returns
nothing; `grep -rn excluded_flows client/src` returns only client/src/lib/advisorPrompts.ts:199,225,
and its owner `buildReportAdvisorPrompt` (advisorPrompts.ts:185) has zero callers anywhere in
client/src. The server half is alive and correct: server/src/services/reporting.ts:952
getExcludedFlowSummary, routes/reports.ts:139, aiContext.ts:999. So exactly half the sentence is
true: the counts reach the advisor's context, and reach the owner nowhere.

**Failure scenario.** The owner confirms a routine checking-to-savings transfer pair. Both legs leave income, spend, net
and savings-rate on `/` (server/src/services/transactionFilters.ts:17 excludedFromTotalsSql). The
data-quality panel deliberately says nothing, on the recorded ground that the count is visible on
the Reports screen. No screen renders it, so the headline flow figures move by that amount with no
account of what was removed anywhere the owner can look. Latent aggravator, inferred:
confirmTransferPair (transactionIntegrity.ts:570) and confirmDuplicateGroup (:559) do not
recategorize, while getExcludedFlowSummary's only membership test is `JOIN
excluded_report_categories excluded ON excluded.id = t.category_id` (reporting.ts:966). A pair or
duplicate confirmed on rows outside the cat_xfer/cat_inv/cat_crypto trees would therefore leave the
totals AND be invisible to the summary itself. Measured 0 such rows on the live copy today (all 54
confirmed transfers sit inside the trees; 0 rows carry duplicate_status='confirmed'), so that half
is latent, not live.

**Proves it real.** `grep -rn "excluded_flows" client/src/views client/src/components` returns nothing, and `grep -rn
buildReportAdvisorPrompt client/src` returns only the definition. Open `/` after confirming a
transfer pair and look for any rendered count of what was excluded.

**Proves it fixed.** Either render `ReportSummary.excluded_flows` on Instrument and correct dataQuality.ts:211 to name
that surface, or keep the panel's silence and rewrite the comment to claim only what is true (the
counts reach the advisor's context). Pin it the way tests/rehomedCapabilities.test.ts:210 already
pins 'no screen cites the retired review inbox': a test that fails when a comment names a surface no
file renders. Separately, make getExcludedFlowSummary's membership the negation of
excludedFromTotalsSql plus the category trees, not the trees alone, with the healthy case asserting
silence.

---

## 12. [HIGH] The nav rail claims "Not synced yet" on every page load, on a ledger with 162 successful syncs

`client` | 3/3 kept | finder confidence: verified | found by: drift-uioverhaul

**Evidence.** client/src/store/index.ts:39 initialises `lastSynced: null`. client/src/hooks/useSyncStatus.ts:41 is
the ONLY call to `setLastSynced` in the whole client (`grep -rn setLastSynced client/src` returns
store/index.ts:40 and useSyncStatus.ts:41,96 and nothing else), and it fires only inside `case
'sync_complete'`. server/src/routes/sync.ts:53-79: `GET /api/sync/status` writes `': keepalive'` on
connect and nothing else, so there is no state replay. client/src/components/NavRail.tsx:111-118
renders `'Not synced yet'` whenever `lastSynced` is null. Live DB: `SELECT status, COUNT(*),
MAX(completed_at) FROM sync_runs GROUP BY status` -> succeeded 162, last 2026-08-31T23:19:20.408Z.
The data to answer correctly is already on the client: client/src/views/Instrument.tsx:454-457
fetches `syncApi.health()` under key ['sync','health'], and server/src/services/syncHealth.ts:150
returns `last_success_at` per connection.

**Failure scenario.** Owner reloads http://localhost:3001/ five minutes after the 23:19:20Z successful sync. The Zustand
store rehydrates to null, the SSE stream sends only a keepalive, so the rail's bottom line reads
"Not synced yet" while the Balance screen beside it is rendering a fully calibrated beam off
`/api/sync/health`, which knows the connection is fresh. It stays wrong until the next hourly sync
completes, i.e. up to MIZAN_SYNC_INTERVAL_MINUTES (60 default). This is ui-overhaul.md bug 6,
unclosed. NavRail's own docstring at :31-33 says the sync dot was removed because "a word that says
the state cannot disagree with itself" - the word is still disagreeing, it just no longer has a dot
next to it. tests/navigation.test.ts:170 asserts `markup.includes('Not synced yet')`, which is
exactly the test-the-defect-case pattern CLAUDE.md warns about: it proves the sentence exists, never
that it is shown only when true.

**Proves it real.** Start the app, let one sync finish, hard-reload the page, read the rail. Or add a test that renders
NavRail with a seeded successful sync run and asserts the label is not 'Not synced yet' - it cannot
pass today because no code path can make `lastSynced` non-null on first render.

**Proves it fixed.** NavRail derives its label from `syncApi.health()` (or `syncApi.history(1)`), which it can share with
Instrument's existing cache entry, and says 'Not synced yet' only when `sync_runs` genuinely holds
no successful run. A regression test that seeds one succeeded run into a migrated fixture and
asserts the rail does NOT render the never-synced sentence, plus the existing test kept for the
genuinely-empty case.

---

## 13. [HIGH] AccountDetail asserts "No transactions for this account yet." while the query is in flight, and permanently if it fails

`client` | 2/3 kept | finder confidence: verified | found by: drift-uioverhaul

**Evidence.** client/src/views/accounts/AccountDetail.tsx:101-104 fetches `txPage` with no `isLoading`/`isError`
destructured. Line 122: `const transactions = txPage?.data ?? [];`. Line 124's only loading guard is
`if (isLoading)`, and `isLoading` comes from the ACCOUNTS query at line 85, not the transactions
one. Line 212 then renders `No transactions for this account yet.` on `transactions.length === 0`.
`grep -n 'isError|QueryErrorBanner|QueryState|error' client/src/views/accounts/AccountDetail.tsx`
returns nothing - the file has no error surface at all. Contrast
client/src/views/Instrument.tsx:461-462, which builds a `failableQueries` list under the comment "A
dead request must not render as a quiet zero: the banner names what is missing." Live DB: 11 of 14
accounts have at least one transaction.

**Failure scenario.** Owner clicks an account from /accounts. The ['accounts'] query is already cached from that list
screen, so `isLoading` is false on first render and the skeleton branch is skipped entirely;
`txPage` is still undefined, so the page states as fact that the account has no transactions. On 11
of the owner's 14 accounts that sentence is false. Worse: if `/api/transactions?accountId=...`
errors, `txPage` stays undefined forever and the sentence stands permanently with no banner, no
retry and no indication a request died - a failed fetch rendering as a factual claim about the
ledger. The same shape silently deletes the whole Holdings block at :187 (`holdings &&
holdings.length > 0`). This is ui-overhaul.md bug 8's named instance, still open, and it breaks rule
2 and rule 3 directly.

**Proves it real.** Throttle or block `/api/transactions` in devtools and open any account with transactions: the page
reads "No transactions for this account yet." and never corrects. Or navigate /accounts ->
/accounts/:id and watch the sentence flash before the list paints.

**Proves it fixed.** The empty sentence is gated on the transactions query having actually resolved (skeleton while
pending, a named error banner on failure), and the same for holdings. A test that renders the view
with the transactions query in an error state and asserts the words 'No transactions' do not appear
- the healthy-silence assertion the repo requires of every claim.

**Dissent (1 of 3 refuters).** REFUTED as record noise. The behavior is real at HEAD, but the finding adds essentially nothing the
record does not already state at line precision, and its one novel clause is false.  1. Already
recorded, verbatim. `/Users/mahdi/code/mizan/.claude/plans/ui-overhaul.md:107-109` (bug 8, "High"):
"Six

---

## 14. [HIGH] Confirming an AI "adjust this occurrence" draft stores the amount 100x too large (toCents applied twice)

`money-boundary` | 3/3 kept | finder confidence: verified | found by: money-boundary

**Evidence.** server/src/services/advisorDrafts.ts:961 passes `adjusted_amount:
toCentsOrNull(payload.adjusted_amount)` into `upsertRecurringAdjustment`. That service converts
again: server/src/services/recurringAdjustments.ts:105 `adjusted_amount:
toCents(input.adjusted_amount)` inside `normalizeAdjustmentInput`. The comment above the call
(advisorDrafts.ts:954-956) states the payload is dollars and "must be stored in cents" - which the
service already does. Reproduced against a `migratedTestDb()` fixture: the HTTP route path
(server/src/routes/recurring.ts:236, `upsertRecurringAdjustment(db, id, req.body)`) stored 8000 for
$80.00; `confirmAdvisorDraft(db, draft, true)` on a payload carrying the same 80.00 stored 800000.
Contrast the sibling handler `confirmManualCostBasis` (advisorDrafts.ts:975), which correctly passes
dollars through raw because `setManualCostBasis` converts; and `confirmBudget`/`confirmGoalTarget`,
which convert once and write SQL directly.

**Failure scenario.** The background worker or Cmd+K drafts `create_recurring_adjustment` with `action: 'adjust'`,
`adjusted_amount: -80` (advisorDrafts.ts:496 builds it in signed dollars, and the card the owner
reads shows `after: -80`). The owner confirms. `recurring_occurrence_adjustments.adjusted_amount`
becomes -800000 cents. `buildOccurrence` (server/src/services/recurringForecast.ts:79-81)
substitutes that value for the pattern's base amount outright, so `forecast.bills` gains $8,000,
`computeSafeToSpend.upcomingBills` gains $8,000, `free` drops by $8,000, and routes/insights.ts
fires the critical `cash-projection-negative` "Projected cash shortfall" row. The Ledger's 30-day
spine renders the bill at $8,000.

**Proves it real.** Reproduced end to end, twice, on a migrated fixture: route path -> 8000 cents, draft-confirm path ->
800000 cents for the identical $80.00 input. Note this is certain-but-latent on the live ledger:
`SELECT COUNT(*) FROM recurring_occurrence_adjustments` returns 0, and no
`create_recurring_adjustment` draft exists among the 310 advisor_drafts, so nothing is corrupted
today. It is also the only in-app route to an amount adjustment: `recurringApi.upsertAdjustment` has
exactly one client caller (client/src/views/Ledger.tsx:349) and it always sends `action: 'skip'`, so
every amount adjustment this app can create goes through the double-converting path. The HTTP route
itself accepts 'adjust' correctly from any external caller.

**Proves it fixed.** Delete the `toCentsOrNull` at advisorDrafts.ts:961 (the service owns the conversion) and add a
regression test that drives an `action: 'adjust'` draft through `confirmAdvisorDraft` and asserts
the stored `adjusted_amount` equals `toCents(payload.adjusted_amount)` exactly. Existing coverage
structurally cannot catch this: tests/recurringAdjustments.test.ts:64-69 pins the service's dollars-
in/cents-out contract (-900 -> -90000) but never goes through the draft path, and
tests/aiFeedback.test.ts:257 is the only draft-path test and uses `action: 'skip'`, which nulls the
amount before it reaches either conversion.

---

## 15. [HIGH] Per-unit holding price is rendered at whole-dollar precision, printing a live $0.09 price as "$0"

`client` | 3/3 kept | finder confidence: verified | found by: money-boundary

**Evidence.** client/src/views/Investments.tsx:92 renders `@ {formatWholeCurrency(holding.institution_price)}`.
`formatWholeCurrency` (client/src/lib/formatters.ts:23-32) sets `maximumFractionDigits: 0`.
`institution_price` is REAL DOLLARS PER UNIT, the one column server/src/services/money.ts:8-10
documents as deliberately NOT cents "because rounding them to whole cents would destroy sub-cent
precision"; schemaDoc.ts:845 repeats it. The UI then rounds the same column to whole dollars, which
is 100x cruder than the rounding money.ts refused.

**Failure scenario.** Opening the holding detail modal for the POL position on the live ledger (quantity 237.3,
institution_price 0.090195, institution_value 2140 cents) renders "237.3 shares @ $0" beside a
market value of "$21". Verified with the exact formatter: `Intl.NumberFormat('en-
US',{style:'currency',currency:'USD',maximumFractionDigits:0}).format(0.090195)` returns "$0"; the
$0.003 token money.ts names as the motivating case also returns "$0". A second live row (FSKAX at
212.529234) renders "$213", a 47-cent overstatement of the quoted price.

**Proves it real.** Ran the formatter on the nine distinct `institution_price` values in the live holdings table. POL
(0.090195) formats to "$0"; AVAX 7.225 -> "$7"; LINK 11.2915 -> "$11"; FSKAX 212.529 -> "$213". The
modal is reachable from any row in the holdings list (Investments.tsx:399 `onClick={() =>
setSelectedHolding(h)}`), and POL sits in the Coinbase crypto_wallet account, which is inside
`portfolio_account_ids`.

**Proves it fixed.** Render the price through a precision-preserving formatter (the file's own `formatPayoffFigure`
precedent in client/src/views/instrumentReadings.ts:186 is the argument: a figure that is the
subject of its own clause must not round to zero), and add a test asserting the rendered string for
a sub-dollar per-unit price is non-zero - e.g. that formatting 0.090195 as a price contains "0.09".
No current test renders `institution_price` at all.

---

## 16. [HIGH] Settings > Rules renders "N matches" from a raw SQL LIKE that is not the matcher the app applies, and it contradicts the AI's autonomous-retire gate

`shared-predicates` | 3/3 kept | finder confidence: verified | found by: sql-predicates

**Evidence.** server/src/routes/rules.ts:40 and :61 compute match_count as `SELECT COUNT(*) FROM transactions t
WHERE lower(COALESCE(t.merchant_name, t.original_name, '')) LIKE '%' || lower(mr.pattern) || '%'`.
The predicate the app actually resolves rules by is server/src/services/rules.ts:110-168
(`normalizeMerchantMatchValue` strips punctuation, the stopwords
store/pos/purchase/debit/card/online/payment and 2+ digit runs; `normalizedMatch` then does
equality, BIDIRECTIONAL containment once the shorter side is 4 chars, or a 0.86 bigram score). The
true per-rule count is server/src/services/rules.ts:387 `countTransactionsHeldByRule`, which also
applies the precedence prefix. The route's number is what reaches the screen:
client/src/views/settings/RulesSection.tsx:338 prints `· ${rule.match_count} matches` on the same
row as the Delete button; fetcher client/src/lib/api.ts:329, mount server/src/index.ts:140. Live DB,
pure SQL, no reimplementation: 63 of the 248 live rules reach 572 transaction rows by REVERSE
containment alone (merchant name sits inside the rule pattern), a direction `LIKE '%pattern%'` can
never see. Reimplementing normalizeMerchantMatchValue/normalizedMatch/countTransactionsHeldByRule
faithfully in Python over the live DB: of 248 live rules, 103 have match_count != held; 42 render a
non-zero count while holding 0 rows; the worst single case renders "2 matches" against 106 rows
actually held, another renders "39 matches" against 0. Three AI-authored rules render 25, 3 and 8
matches while held = 0 - and held = 0 is exactly the gate `checkRuleIsRetirableByAi` reads
(server/src/services/aiWriteGuards.ts:347) to let `retire_merchant_rule` run unattended. No test
asserts match_count (grep over tests/ returns nothing).

**Failure scenario.** Owner opens Settings > Rules. A rule typed as a full provider descriptor (e.g. a 38-char SimpleFIN
string) renders "2 matches" because only 2 rows contain that literal substring, while the resolver
hands it 106 rows via reverse containment; the owner reads it as inert and deletes it, silently
recategorizing 106 transactions. In the other direction, an AI rule renders "25 matches" while
countTransactionsHeldByRule returns 0, so the background worker may retire it autonomously - the
screen says the rule is doing work, the gate that authorizes an unattended write says it does none,
and both numbers answer the same question.

**Proves it real.** Run `countTransactionsHeldByRule(db, id)` for every row returned by GET /api/rules on a copy of the
live DB and diff against the response's match_count. Expect 103 of 248 to differ. The 63-rule /
572-row reverse-containment gap is reproducible with SQL alone: join merchant_rules against the
distinct-name set on `instr(lower(pattern), lower(name)) > 0 AND instr(lower(name), lower(pattern))
= 0` with `length(name) >= 4`.

**Proves it fixed.** routes/rules.ts stops carrying its own SQL predicate and serves the count from the one definition in
rules.ts (countTransactionsHeldByRule, or a batched form of it), so the list, the resolver and the
retire gate cannot disagree. Regression test: a fixture with one rule pattern that is a long
descriptor containing the merchant name and one that is a short name inside a noisy descriptor,
asserting the served match_count equals countTransactionsHeldByRule for both, and that a rule the
gate calls retirable renders 0.

---

## 17. [HIGH] Spending-spike insight claims "no comparable spending in the prior 30 days" over a prior window that held 10 transactions, and inflates the money metric by the refunds

`detectors` | 3/3 kept | finder confidence: verified | found by: sql-predicates

**Evidence.** server/src/services/anomalyInsights.ts:66-76 sums SIGNED spend per category (`-t.amount`, correctly,
via expenseSideSql at :64), so `previous_spend` can be NEGATIVE when a window's refunds outweigh its
purchases. The HAVING at :72-74 is one-sided only against zero: `(previous_spend = 0 OR
current_spend >= previous_spend * 1.75)` is trivially satisfied by any negative previous, and
`current_spend - previous_spend >= 20000` gets easier the more negative it is. At :119-121
`increase` is computed only when `previous_spend > 0`, so a negative previous falls to the null
branch, and :129 then prints "... after no comparable spending in the prior 30 days" - a claim the
query never checked, since previous_spend < 0 means there WERE rows, their credits just exceeded
their purchases. :131 emits `metric: money(delta)` where delta = current - previous, so a negative
previous inflates the headline figure. Live DB, replaying the exact HAVING and ORDER BY for every
`now` from 2024-01-01 to 2026-08-31: the top-ranked spike had previous_spend < 0 on 22 days, and was
the emitted insight on 2026-08-16 through 2026-08-21 and on 2026-08-27 - 7 of the last 16 days. On
2026-08-16: category Shopping, current_spend 102019 cents, previous_spend -140414 cents over 10
transactions in the prior window. tests/anomalyInsights.test.ts covers only a positive-previous
spike and a transfer-category silence case; nothing constructs a net-refund prior window.

**Failure scenario.** Prior 30 days hold 10 Shopping transactions whose refunds exceed purchases by $1,404.14; current 30
days hold $1,020.19 of Shopping spend. The panel renders severity 'warning', "Shopping spending is
$1,020 in the last 30 days after no comparable spending in the prior 30 days", with the metric
$2,424.33 - a money figure 2.4x the spending it describes, attached to a false statement about a
window that contained ten rows.

**Proves it real.** Call getAnomalyInsights(db, new Date('2026-08-16')) against a copy of the live DB and read the
returned message and metric for id 'spending-category-spike'.

**Proves it fixed.** Follow the shape the income arm at :139-146 already uses - state both figures rather than assert an
absence - or require `previous_spend > 0` before the spike can fire at all, and make the metric the
current spend rather than a delta across a sign change. Regression test in the repo's own rule-3
shape: a healthy fixture whose prior window nets negative from real rows, asserting either silence
or copy that names the prior window's actual figure, never "no comparable spending".

---

## 18. [HIGH] The liability-sign detector re-files an identical unverifiable finding every hour, because its only silence condition cannot occur on this feed

`sync` | 2/3 kept | finder confidence: verified | found by: sync-writepath

**Evidence.** server/src/services/liabilitySign.ts:92-96 (`pendingAfter` counts `pending = 1` rows) and :158-159
(`if (count === 0) doubt ??= ...`), the sole path that suppresses an `unverifiable` entry.
server/src/services/simplefin.ts:907 issues `/accounts?start-date=...` with no pending parameter,
and :857-859 stores `pending: txn.pending === true ? 1 : 0`. Live DB: 0 of 2723 transactions have
`pending = 1`; `SELECT pending, COUNT(*) FROM transactions GROUP BY 1` returns only `0|2723`.
server/src/services/syncManager.ts:365-374 records the run item whenever `signs.unverifiable.length
> 0`, with no de-duplication against the previous run, immediately below the `news` filter at
:356-363 that exists to stop exactly this for corrections. Rendered verbatim on a 'succeeded' item
at client/src/components/SyncActivityPanel.tsx:233-235. Live DB, grouped on the exact message: one
BofA Cash Rewards sentence written 10 times between 2026-08-06T18:46 and 2026-08-07T03:51, a second
variant 3 times, a Discover sentence twice on 2026-08-29, and a Chase Freedom Flex sentence once. 16
of the 21 liability-sign run items carry a message.

**Failure scenario.** A credit card's provider balance leads the settled ledger by an authorized-but-not-posted charge,
which is the ordinary state of a card. The direction test at liabilitySign.ts:149 trips, the
magnitude test at :150 fails, `pendingAfter` returns 0 because no row in this database is ever
pending, so `doubt` is set and `unverifiable` reports "the direction of this balance is in doubt".
The next hourly sync recomputes the same disagreement from the same anchor and writes a byte-
identical run item. Ten consecutive hours of the sync panel read the same standing accusation about
BofA Cash Rewards, and the owner has no action that clears it: it is not a correction they can
confirm, and nothing they can do to the ledger makes the provider's authorized balance equal the
settled sum.

**Proves it real.** Already reproduced from the live database: group `sync_run_items` on `error_message` where
`connection_id = 'liability-sign'` and read the repeat counts and first/last run timestamps. The
structural half is `SELECT COUNT(*) FROM transactions WHERE pending = 1` returning 0 against a
ledger of 2723 rows spanning 2023-09-16 to 2026-08-30.

**Proves it fixed.** Either the SimpleFIN request asks for pending rows so the escape hatch can fire, or `unverifiable`
is filtered the way `news` is: report an entry only when the (account, anchor date, stored balance,
implied balance) tuple differs from what the previous run reported for that account. The regression
test drives two consecutive `runPostSyncStages` calls over an unchanged migrated fixture holding one
lagging card and asserts the second run records no liability-sign item at all.

**Dissent (1 of 3 refuters).** REFUTED. The finding's two structural halves check out, but both load-bearing consequence claims are
empirically false against the live data, and the failure scenario it names is contradicted by the
owner's own sync-change log.  WHAT SURVIVES (true, but small) - `pending = 1` is genuinely
unreachabl

---

## 19. [HIGH] The chat tool tells the model (and through it the owner) that a reverted batch left its merchant rule standing, which HEAD's revert makes false in every reachable case

`ai` | 3/3 kept | finder confidence: verified | found by: ai-authority

**Evidence.** server/src/services/advisorChatTools.ts:1014, the `guardNote` text for `status === 'reverted'`:
"The revert walks category writes only, so a merchant rule this call created still exists and is
listed in Settings." And advisorChatTools.ts:1097-1102 (`createMerchantRuleTool`) returns `{
rule_created: outcome.applied, rows_applied: 0, ... }` on a reverted batch with the comment "the
revert takes back category writes and nothing else: the rows the rule swept in are back where they
were and the merchant_rules row is still there. Collapsing that into `applied: false` would claim a
deletion that never ran." Both statements were true of the old harness and are false at HEAD:
aiGuards.ts:1078 calls `undoRuleWrites` inside `revertBatch`, aiGuards.ts:960-966 retires a rule
whose pre-batch state was 'absent', and aiGuards.ts:1081-1084 throws (yielding `status:
'revert_failed'`, not 'reverted') if any rule write is still standing. So `status === 'reverted'` is
precisely the case where the created rule WAS retired. `report.reverted_rules` carries the count and
neither site reads it. No test pins either sentence (grep for the note text across tests/ returns
nothing).

**Failure scenario.** The owner asks the advisor in Cmd+K to create a rule for a merchant. `createMerchantRuleTool` runs
it under `guardedChatWrites`; the month's totals move by more than the swept rows account for, so
the batch breaches and reverts, and `revertBatch` retires the freshly created rule. The tool then
hands the model `rule_created: true` plus a note saying the rule "still exists and is listed in
Settings", and the model reports exactly that to the owner. The owner believes a standing rule
exists that will file future transactions, goes to Settings, and finds nothing live; or, believing
it standing, does not re-create the rule they actually wanted.

**Proves it real.** Build a migrated fixture, run `createMerchantRuleTool` inside a batch engineered to breach (mutate a
window row's amount from inside the batch so `diffWindowLedger` reports an unexplained movement),
and compare the returned `guard.note` against `SELECT retired_at FROM merchant_rules WHERE id =
<created>`: the note claims the rule exists while `retired_at` is non-NULL and
`report.reverted_rules` is 1.

**Proves it fixed.** The note is generated from the report rather than written beside it: it names
`report.reverted_rules` and says the created rule was retired back out, and `rule_created` reflects
post-revert state rather than `outcome.applied`. A test asserts the sentence against the actual
`merchant_rules.retired_at` after a forced breach, and asserts silence (no rule sentence at all) on
the clean path.

---

## 20. [HIGH] Forward Cash Flow lists 10 of 17 scheduled occurrences with no statement that it truncated, under totals that cover all 17

`ai-context` | 3/3 kept | finder confidence: verified | found by: ai-context-truth

**Evidence.** /Users/mahdi/code/mizan/server/src/services/aiContext.ts:1016-1017: `lines.push('  Next scheduled
items:')` then `for (const occurrence of forecast.occurrences.slice(0, 10))`. Nothing counts or
totals the remainder. Against the live copy, `buildRecurringForecast(db, 60)` returns 17
occurrences; the rendered section prints `Scheduled income: $4,897.62 / Scheduled bills: $153.70 /
Scheduled net: $4,743.92` (all 17) and then 10 lines ending at 2026-10-02. The three October bills
(spotify 2026-10-03 $6.99, mit dining cafe 2026-10-14 $13.69, backblaze 2026-10-17 $17.15, $37.83
together) and four payroll occurrences ($2,176.72) are absent with no note. Two other sections in
the same file do account for what they drop: aiContext.ts:1372-1375 ("Top 10 holdings of N (the
totals above cover all N)") and aiContext.ts:1113-1116 ("N smaller categories are not listed,
together $X"). No test pins the cap (`grep -rn "Next scheduled" tests/` is empty).

**Failure scenario.** Owner asks Cmd+K "what bills are coming out over the next two months?". The model has a section
headed "Forward Cash Flow - next 60 days" whose list ends 2026-10-02 with no truncation marker, so
it answers with 4 bill occurrences totalling $115.87 and omits three real October charges, while the
same section states $153.70 of scheduled bills. The itemization and the total disagree by $37.83 and
nothing in the prompt lets the model detect that its list is short.

**Proves it real.** `buildRecurringForecast(db, 60).occurrences.length` is 17 on the live copy while the rendered
section contains 10 `    2026-` lines; diff the two sets.

**Proves it fixed.** The heading or the list line states "showing the next 10 of N" and the omitted occurrences are
counted and totalled, matching the pattern already used for holdings and category movement; a test
builds a forecast of >10 occurrences and asserts the omitted count and total appear.

---

## 21. [HIGH] The account reconciliation report reaches no screen: the check the code calls "the one check that decides whether every other number in the app is true" is client-invisible

`client-server-seam` | 2/3 kept | finder confidence: verified | found by: client-server-seam

**Evidence.** Route and its own claim: /Users/mahdi/code/mizan/server/src/routes/insights.ts:106-149 ("GET
/reconciliation - does the ledger explain each account's balance? The one check that decides whether
every other number in the app is true. Nothing checked this relationship before, and the app's
silence about it read as a claim of completeness."). It serves `unreconciled`,
`unreconciled_residual`, `residual_all_accounts`, `measured_snapshot_count` and `flow_conservation`.
Client side: `insightsApi` (/Users/mahdi/code/mizan/client/src/lib/api.ts:476-480) defines only
`list`, `safeToSpend`, `quality`, there is no reconciliation fetcher. `grep -rin "reconcil"
client/src` returns only the unrelated Investments holdings-vs-balances note
(client/src/views/Investments.tsx:151,160,195,227,387) and two source comments. `grep -in "reconcil"
shared/types/index.ts` returns zero: no shared type was ever declared for this response. I verified
the report is not folded into the insights list either: `reconcileAccounts`, `unreconciledResidual`
and `findFlowConservationViolations` are used at insights.ts:112, 124 and 137 only, all inside the
`/reconciliation` handler, and `router.get('/')` begins at insights.ts:181; `insightsApi.list()` has
exactly one caller (client/src/views/Instrument.tsx:365) and it renders that list, not a residual.
The only owner-reachable path is the advisor: server/src/services/advisorChatTools.ts:194
(`get_reconciliation` tool) and server/src/services/aiContext.ts:259-266.

**Failure scenario.** An account's transactions stop explaining its balance (a missed feed window, a deleted row, a
provider gap). `reconcileAccounts` computes a non-zero `adjusted_residual`, `unreconciledResidual`
sums it, `findFlowConservationViolations` adds any cross-account violation, and `GET
/api/insights/reconciliation` returns all of it correctly. The owner opens Balance, Accounts,
Ledger, Investments, Plan and Settings and sees the net-worth figure, the account balance and the
spending totals rendered with no indication that the ledger behind them does not add up. The finding
exists, is correct, and is not on any of the six screens; it surfaces only if the owner happens to
ask Cmd+K.

**Proves it real.** `curl -s localhost:3001/api/insights/reconciliation | jq '.data.unreconciled | length,
.data.flow_conservation | length'` returning non-zero while no screen in client/src renders either
array. Equivalently: `grep -rn "unreconciled\|residual\|flow_conservation" client/src` returns
nothing, which it does today.

**Proves it fixed.** A fetcher in client/src/lib/api.ts with a real caller that renders `unreconciled`,
`residual_all_accounts` and `flow_conservation`, plus a shared type for the response; and, per the
repo's third rule, a test that constructs the healthy ledger (empty `unreconciled`, empty
`flow_conservation`, non-zero `residual_all_accounts` from the exempt market-driven accounts) and
asserts the screen renders no accusation at all for it.

**Dissent (1 of 3 refuters).** Every factual claim in the finding verified; the classification as a high-severity defect did not.
1. FACTS CONFIRMED (verified, not softened). The route exists at
/Users/mahdi/code/mizan/server/src/routes/insights.ts:109 and serves accounts / unreconciled /
unreconciled_residual / residual_all_acc

---

## 22. [HIGH] The frozen liquid/investment/crypto columns are published to the model as plain cents, and two measured live rows say the portfolio held $0 when it held $1,661.66

`ai / net-worth history` | 2/3 kept | finder confidence: verified | found by: investments

**Evidence.** server/src/routes/reports.ts:402-407 states that `investment_assets` is frozen from the account
types in force at write time, that both Fidelity accounts were auto-typed `checking` before
correction, and that the column therefore reads $0.00 for two days when the portfolio held $1,661.66
- and that endpoint refuses to read it, deriving the value from `breakdown` instead.
server/src/services/schemaDoc.ts:202-204 publishes `liquid_assets`, `investment_assets`,
`crypto_assets` to the model as `{ unit: CENTS }` with no note, on a table whose own purpose line
(schemaDoc.ts:192) says the measured/reconstructed difference is load-bearing; the caveats sit on
`is_estimated` and `covered_accounts` but not on the three columns that are wrong on MEASURED rows.
`run_sql_query` gives the model direct SELECT access. client/src/views/instrumentReadings.ts:123-135
(`bucketsOf`) also reads all three, though only from the latest snapshot. Live data reproduces
reports.ts's figures exactly, on two `is_estimated = 0` rows.

**Failure scenario.** Owner asks Cmd+K how much was invested at the end of June. The model reads schemaDoc, sees
`investment_assets` documented as cents with no caveat, runs `SELECT investment_assets FROM
net_worth_snapshots WHERE date = '2026-06-30'`, and answers $0.00 as a measured fact for a day the
two Fidelity accounts held $1,661.66. The same $1,661.66 sits inside `liquid_assets` on that row, so
a cash question about the same day is overstated by the same amount. Backfill only rewrites
`is_estimated = 1` rows (services/snapshot.ts:635), so these two measured rows keep the wrong split
permanently.

**Proves it real.** On the live copy: `SELECT date, is_estimated, investment_assets, liquid_assets FROM
net_worth_snapshots WHERE date IN ('2026-06-30','2026-07-01')` returns is_estimated 0,
investment_assets 0, liquid_assets 801953 for both, while summing the two Fidelity ids out of the
same rows' `breakdown` gives 166166. Two of 41 snapshots, both measured, both permanent.

**Proves it fixed.** Give the three columns a schemaDoc note carrying the statement reports.ts already makes (frozen from
accounts.type at write time; derive from breakdown for any past date), the way is_estimated and
covered_accounts already carry theirs - or stop serving them for historical rows. Test: assert the
schemaDoc entry for each of the three columns is non-empty and mentions the freezing, alongside the
existing dictionary tests. A stronger fix derives them from `breakdown` at read time in
routes/networth.ts the way routes/reports.ts does.

**Dissent (1 of 3 refuters).** REFUTED as filed. The data claim reproduces exactly, but it reproduces the record rather than
contradicting it, and every surface that could turn the stale columns into an asserted number was
already audited and closed.  VERIFIED (the finder's data is right, and I re-ran it): - `SELECT date,
is_esti

---

## 23. [HIGH] Merging two accounts sums quantity and value in holdings_history but not cost_basis, halving the basis on every colliding day

`sync / account merge` | 3/3 kept | finder confidence: verified | found by: investments

**Evidence.** server/src/services/accounts.ts:286-297: the collision pass sets only `quantity = quantity + (...)`
and `institution_value = institution_value + (...)`; `cost_basis` and `institution_price` are absent
from the SET list, so the merged row keeps the target's basis alone beside a summed value. The
comment two lines above (accounts.ts:271-273) says two rows for the same security on the same day
are two parts of one position once the accounts are one account - a claim about the row, not about
two of its four numeric columns. Reproduced in-process against migratedTestDb. It is invisible to
the suite because tests/accountMerge.test.ts:18-31's `addHistory` helper neither takes nor inserts a
cost_basis, and the collision test at :78-96 asserts only quantity and institution_value.

**Failure scenario.** A SimpleFIN re-link - the exact case services/accounts.ts:238-242 says this code exists for - brings
the same brokerage back under a new provider id holding the same funds, both sides carrying a
provider cost basis. Target holds VT at 4 units / $644.00 value / $600.00 basis, source at 6 units /
$966.00 / $900.00. After the merge the day's row reads quantity 10, value $1,610.00, cost_basis
$600.00. The AI's `holding_history` tool (advisorChatTools.ts:171, which tells the model value and
cost_basis are dollars) then reports a $1,010 gain on that day where the truth is $110, for every
historical date both ids covered.

**Proves it real.** Repro: two brokerage accounts, one security, one holdings_history row each on the same date with
cost_basis 60000 and 90000; call mergeAccounts. The surviving row comes back quantity 10,
institution_value 161000, cost_basis 60000 - value summed, basis not.

**Proves it fixed.** Add cost_basis to the same SET clause, summed when both sides are non-NULL and NULL when either side
is NULL (a part-unknown total is unknown, which is the repo's own 'unknown, never zero' doctrine
from migration 043). Extend tests/accountMerge.test.ts's addHistory helper to carry a basis and
assert the summed value, plus a case where one side's basis is NULL and the merged row comes back
NULL rather than the known half.

---

## 24. [HIGH] /accounts renders $0 net worth, $0 assets, $0 liabilities and "No accounts yet" when the accounts query fails, the exact defect QueryErrorBanner's docstring records as fixed

`client` | 3/3 kept | finder confidence: verified | found by: error-handling

**Evidence.** client/src/views/accounts/Accounts.tsx:131, `const { data: accounts, isLoading } = useQuery(...)`;
`isError` is never destructured and the file never imports QueryErrorBanner (confirmed by grep over
the file). client/src/views/accounts/Accounts.tsx:171-176, `(accounts ?? []).filter(...)` for
`visible`/`hidden`/`liveVisible`. client/src/views/accounts/Accounts.tsx:193-195, `assets`/`owed`
are `.reduce(...)` over that empty array, `netWorth = assets - owed` → all three are 0.
client/src/views/accounts/Accounts.tsx:338-365, those zeros are rendered as `<Figure
scale="subject" label="Net worth">` (the 44px money numeral), `<Figure scale="lead"
label="Assets">`, and a `<Figure>` whose label and state sentence are COMPUTED from the value, so
`owed === 0` selects the label "Liabilities" and the state string `'nothing outstanding'`.
client/src/views/accounts/Accounts.tsx:380-393, `{isLoading && <SkeletonRows/>}` then `{!isLoading
&& liveVisible.length === 0 && closed.length === 0 && ("No accounts yet. Connect SimpleFIN or
Coinbase or add one manually.")}`. An errored query is `!isLoading`, so this branch fires.
client/src/components/QueryErrorBanner.tsx:39-42 records this precise class as fixed: "Nine of the
app's eleven views destructured only `data` from their queries and never referenced `isError`, so a
dead server or a 500 rendered as an EMPTY state: 'Nothing due in the next 30 days', '$0', 'no goals
yet'." Instrument.tsx:461-477, Ledger.tsx:200-207, Plan.tsx:590-599 and Investments.tsx:221-225 all
carry the banner; Accounts.tsx and AccountDetail.tsx are the two money screens that do not.
client/src/views/accounts/AccountDetail.tsx:85-86, 132-143, same shape: a failed accounts query
leaves `account = null` and the screen renders "Account not found.", a claim about the ledger
derived from a transport failure. Partial mitigation, stated honestly: client/src/main.tsx:14-26 has
a global `QueryCache.onError` that fires ONE toast per 3-second burst. It is transient and auto-
dismisses; the fabricated $0 and "No accounts yet" persist with no in-page signal and no retry
affordance.

**Failure scenario.** Owner navigates to /accounts (or hard-refreshes it) while the server is restarting, or `GET
/api/accounts` 500s, or the Vite dev middleware serves index.html for the path so apiFetch throws
"Unexpected non-JSON response" (client/src/lib/api.ts:92-97). With `retry: 1` (main.tsx:30) the
query settles as errored. One toast flashes and disappears. The screen then permanently reads: Net
worth $0 · Assets $0 · Liabilities $0 "nothing outstanding" · "No accounts yet. Connect SimpleFIN or
Coinbase or add one manually." On the live ledger the true figures are 14 accounts with liabilities
summing 427,870 cents (the comment at Accounts.tsx:350-353 records the same query). Every one of
those four statements is false and none of them is marked as unmeasured.

**Proves it real.** Start the client, stub `GET /api/accounts` to return 500 (or stop the server and load /accounts
cold), and screenshot the page after the toast auto-dismisses. Assert the DOM contains the subject-
scale "$0" under "Net worth" and the "No accounts yet" copy with no role="alert" element present.

**Proves it fixed.** Accounts.tsx and AccountDetail.tsx take `isError` and render `<QueryErrorBanner items={...} />` like
the other four money screens, and the headline Figures render nothing (not $0) while
`accountsQ.isError`. A test in the style of the existing `summarizeQueryFailures` tests that mounts
Accounts with an errored accounts query and asserts no money numeral and no "No accounts yet" string
is emitted.

---

## 25. [HIGH] The Coinbase sync stage has no error channel at all: a swallowed per-coin pricing failure or ledger-import failure still records status 'succeeded'

`sync` | 3/3 kept | finder confidence: verified | found by: error-handling

**Evidence.** server/src/services/coinbase.ts:12-17, `CoinbaseSyncResult` is `{accountCount, transactionCount,
staleAccountCount, balanceChanges}`. There is no `errors` field, so the stage has nowhere to put a
partial failure. Contrast server/src/services/simplefin.ts:170 (`errors: string[]`) consumed by
`recordSimplefinStage` / `triageSimplefinErrors` at server/src/services/syncManager.ts:216-273.
server/src/services/coinbase.ts:481-491, the comment says "a single unpriceable/delisted coin must
not abort the whole run. Mark it seen so its last-known holding is kept (not zeroed), and skip",
then `catch (err) { console.warn(...); seenCurrencies.add(currency); continue; }`. Nothing is
returned to the caller. server/src/services/coinbase.ts:518-520, 534, the account balance is then
`SELECT COALESCE(SUM(institution_value),0) FROM holdings WHERE account_id = ?` written straight into
`accounts.current_balance`, so the skipped coin's stale `institution_value` (last sync's price times
last sync's quantity) is summed into the account balance as if it were this run's measurement.
server/src/services/coinbase.ts:544-549, the v2 ledger import: `catch (err) {
console.warn('[coinbase] Ledger sync failed (non-fatal): ...') }`, again with no return channel.
server/src/services/syncManager.ts:635-644, if `syncCoinbase()` returns without throwing, the run
item is recorded unconditionally as `status: 'succeeded'` with no `error_message` and no
`recovery_action`. server/src/services/syncHealth.ts:190, the run is therefore not
`partial`/`failed`, so `last_run.incomplete` is false and client/src/views/Instrument.tsx:489-496
leaves the balance beam fully calibrated. Live check (has NOT fired yet): all 8 crypto_wallet
holdings share a single `updated_at` of 2026-08-31T23:19:16.457Z (`SELECT COUNT(DISTINCT
h.updated_at) ...` returns 1), so no coin has been skipped on the live ledger. The defect is latent,
not active.

**Failure scenario.** Coinbase delists a coin, or `GET /v2/prices/<X>-USD/spot` 404s or times out for one currency during
an hourly sync. `getUsdSpotPrice` throws, coinbase.ts:486 logs to stderr and continues. That coin's
`holdings` row keeps last sync's `quantity` and `institution_value`. coinbase.ts:518 sums it into
`accounts.current_balance` for the consolidated Coinbase account, `takeSnapshot()` writes that into
`net_worth_snapshots` with `is_estimated = 0`, and syncManager.ts:640 records `Coinbase |
succeeded`. The owner's net worth on / and /accounts now contains a crypto valuation priced at
whatever the token was worth an hour (or a week, if it keeps failing) ago, presented as a measured
balance, with a fully-calibrated beam and nothing in the sync panel to look at. The same is true of
a failed v2 ledger import: crypto converts/sends/receives silently stop arriving while every run
reads 'succeeded'.

**Proves it real.** Stub `https://api.coinbase.com/v2/prices/<TICKER>-USD/spot` to 404 for one held ticker and run a
sync against a migratedTestDb fixture. Assert that (a) that holding's `updated_at` and
`institution_value` are unchanged, (b) `accounts.current_balance` for the Coinbase account still
includes the stale value, and (c) the `sync_run_items` row is `status='succeeded'` with
`error_message IS NULL`.

**Proves it fixed.** `CoinbaseSyncResult` gains an `errors: string[]` (and the ledger-import failure pushes into it), and
syncManager.ts:635-644 records it the way `recordSimplefinStage` does, status derived from the
errors, `error_message` set, `recovery_action` set. A test where one coin's price fetch throws
asserts the run item is not a bare `'succeeded'` with no message, and a companion test asserts an
all-coins-priced run is silent (no advisory, status `'succeeded'`).

---

## 26. [HIGH] npm start never enters production mode, so helmet's CSP, the prod CORS policy, and dist/client are all dead code

`config` | 3/3 kept | finder confidence: verified | found by: security-localguard

**Evidence.** package.json:17, `"start": "node --env-file-if-exists=.env dist/server/src/index.js"`, with no
`NODE_ENV=production`, and `.env` sets no NODE_ENV (4 keys, verified). `IS_PROD` (index.ts:38) is
therefore false under `npm start` as well as `npm run dev`. Everything gated on it is unreachable
via any documented command: helmet's full defaults (index.ts:100 passes `{contentSecurityPolicy:
false}` in the non-prod branch), the CORS policy (index.ts:103-105 falls back to the localhost dev
origins instead of `CORS_ORIGIN` / `false`), the CORS_ORIGIN startup notices (110-116),
`express.static(clientDist)` and the `app.get('*')` SPA fallback (152-158), the loopback bind and
its warning (163-167). README.md:250-253 documents `npm run build` then `npm start` as the way to
run the built app; `dist/client/index.html` exists (built 19:38) and is never served , 
`ViteExpress.listen` starts a Vite dev server against `client/src` instead.

**Failure scenario.** Owner follows the README: `npm run build && npm start`. The build artifact at dist/client is
silently ignored; the app is served by a Vite dev server compiled from source (which also means
finding 2's `/@fs/` surface is present in what the owner believes is a production run). No CSP
header is sent. If the owner sets CORS_ORIGIN expecting the startup notice at index.ts:112 to
confirm it, nothing prints and the value is not applied.

**Proves it real.** `npm start`, then `curl -sI http://127.0.0.1:3001/ | grep -i content-security-policy` returns
nothing, and the served HTML references `/src/main.tsx` (dev) rather than `/assets/index-*.js`
(built).

**Proves it fixed.** `"start": "NODE_ENV=production node --env-file-if-exists=.env dist/server/src/index.js"`; then the
same curl shows a CSP header and the HTML references the hashed asset. Note this fix arms finding 4
,  land both together.

---

## 27. [HIGH] GET /api/insights/reconciliation is the app's only data route with zero client callers: the check the code calls "the one check that decides whether every other number in the app is true" renders on no screen

`reconciliation / client` | 2/3 kept | finder confidence: verified | found by: dead-code

**Evidence.** server/src/routes/insights.ts:106-146 defines the route; its own comment reads "The one check that
decides whether every other number in the app is true. Nothing checked this relationship before, and
the app's silence about it read as a claim of completeness." client/src/lib/api.ts:476-480 is the
entire insightsApi: `{list, safeToSpend, quality}` -- no reconciliation member. A full grep of
client/src for 'reconcil' returns only comments (api.ts:549, ledger/modals.tsx:245) and an unrelated
local field in Investments.tsx:151. I bipartite-matched all 131 route handlers against every /api/
string in client/src (including raw `fetch` calls at api.ts:711 and :724 that an apiFetch-only grep
misses): after eliminating false positives, insights/reconciliation is the ONLY route with 0 client
call sites. CLAUDE.md devotes a whole section ("Reconciliation, and the artifact it used to report
as a gap", ~line 203) to boundary_amount and direction_conflict as if this were a live surface.

**Failure scenario.** The ledger stops explaining an account's balance (a missed transaction, a mis-signed row, a provider
gap). reconcileAccounts computes the residual correctly and the route would report it, but no
fetcher requests it and no screen renders it, so the condition is invisible in the UI indefinitely.
Note honestly: no number currently on screen is wrong, and the report is not fully unreachable --
reconcileAccounts is consumed by services/aiContext.ts:23 (buildFinancialContext, so it reaches
every prompt) and by the get_reconciliation chat tool (services/advisorChatTools.ts:194,1124). The
owner can only get it by asking the AI; the app's own surfaces stay silent, which is precisely the
silence the route's comment says it was written to end.

**Proves it real.** grep -rn 'reconcil' client/src --include='*.ts' --include='*.tsx' returns no fetch, no apiFetch, no
query key. Boot the app and watch the network tab across all six screens:
/api/insights/reconciliation is never requested.

**Proves it fixed.** Either an insightsApi.reconciliation fetcher with a component that renders unreconciled accounts and
unreconciled_residual, plus a test asserting the panel is silent on a fully reconciled ledger (rule
3); or, if the deliberate decision is that the AI is the only surface, delete the route and say so
in CLAUDE.md. This is the one census item where subtraction is the wrong verb.

**Dissent (1 of 3 refuters).** REFUTED as noise under the record lens. The factual observations hold, but the defect as framed does
not.  1. The claimed failure does not exist at HEAD. The scenario is "an unreconciled condition
stays invisible in the UI indefinitely." On the live data there is no such condition: `unreconciled`
is

---

## 28. [HIGH] `list_goals` chat tool bypasses `calculateGoalProgress`, so the advisor contradicts its own system context inside one conversation

`ai` | 3/3 kept | finder confidence: verified | found by: duplicated-logic

**Evidence.** `server/src/services/advisorChatTools.ts:419-431` (`listGoalsTool`, registered as `list_goals` at
`:97` and dispatched at `:1114`) runs its own SQL: `SELECT name, type, target_amount,
current_amount, target_date FROM goals WHERE is_archived = 0 ORDER BY name`, with no `LEFT JOIN
accounts` and no call to `calculateGoalProgress`. It returns `current: toDollars(r.current_amount)`
and `progress_pct: Math.round((r.current_amount / r.target_amount) * 100)`.  The same conversation's
system context is built by `server/src/services/aiContext.ts:1120-1153`, which joins
`a.current_balance AS account_balance` and calls `calculateGoalProgress(goal)` at `:1143`.  On the
live ledger the one active goal is stored at `current_amount = 100170` with a linked account at
`current_balance = 0`, so `list_goals` returns `current: 1001.70, progress_pct: 20` while the prompt
the model is reading says `$0.00 saved of $5,000.00 (0%), $5,000.00 remaining`.  This is the failure
mode `tests/advisorToolParity.test.ts:9-14` exists to prevent ("the advisor's aggregate tools used
to run their own SQL, and drifted from the Reports page"), and that test covers only the
spend/income tools; nothing pins `list_goals` against `routes/goals.ts` or `aiContext`.
`server/src/services/safeToSpend.ts:20-23` states the standard being broken: "Lives on the server
because the advisor and the Today screen must not be able to disagree about it."

**Failure scenario.** The owner asks Cmd+K "how is my house fund doing?". The system context says 0% saved. The model
calls `list_goals`, gets 20% and $1,001.70, and answers with whichever it weights higher, or notices
the conflict and hedges. Latent second error in the same function: for a `debt` goal,
`calculateGoalProgress` computes progress as `max(starting_amount - account_balance, 0)`, while
`listGoalsTool` computes `current_amount / target_amount`; those are different quantities and for a
linked debt goal they move in opposite directions as the balance is paid down. The live ledger has
no debt goal, so that half is unexercised.

**Proves it real.** Run `runAdvisorTool(db, 'list_goals', {})` and `buildFinancialContext(db)` against the live database
copy and compare the goal figures in each. Files: `server/src/services/advisorChatTools.ts:419` and
`server/src/services/aiContext.ts:1143`.

**Proves it fixed.** `listGoalsTool` selects the same columns `aiContext` does and reports `calculateGoalProgress(row)`.
Add a case to `tests/advisorToolParity.test.ts` asserting `list_goals`'s `current` and
`progress_pct` equal what `calculateGoalProgress` yields on a fixture carrying one linked savings
goal AND one linked debt goal, so the debt direction is pinned too.

---

## 29. [HIGH] The spending-spike card says "no comparable spending in the prior 30 days" when the prior window was net-negative, and prints a delta larger than the figure it names

`detector-copy` | 3/3 kept | finder confidence: verified | found by: test-quality

**Evidence.** server/src/services/anomalyInsights.ts:119 branches on `previous_spend > 0`, so a NEGATIVE prior
window falls into the same `increase === null` arm as a zero one; :128-129 renders that arm as
"...after no comparable spending in the prior 30 days." while :132 still prints `metric:
money(toDollars(delta))` with delta = current - previous. The HAVING at :72-76 admits a negative
`previous_spend` (it only requires `current_spend >= 30000` and `current_spend - previous_spend >=
20000`). Replaying the real `getAnomalyInsights` against the live DB copy at 2026-08-17 emits:
"Shopping spending is $1,020 in the last 30 days after no comparable spending in the prior 30 days"
with metric $2,424. SQL over the prior window (2026-06-19..2026-07-18, transfer/duplicate filters
applied) returns Shopping = -$1,404.14 across 7 purchase rows and 3 credit rows. Eight further
distinct days in the last 12 months hit the same arm. tests/anomalyInsights.test.ts has exactly two
tests (:31 detection, :50 a transfer-exclusion case) and never constructs a negative prior window,
even though /Users/mahdi/code/mizan/CLAUDE.md documents that state by name ("July 2026 Shopping was
-$1,203.63 because that month's credits exceeded its purchases").

**Failure scenario.** A category's prior 30 days contain purchases plus larger refunds, netting negative (live: Shopping,
7 purchases, net -$1,404.14). The card tells the owner there was "no comparable spending in the
prior 30 days" (false: there were 7 purchases) and puts a $2,424 delta beside a $1,020 figure, so
the number the card leads with is smaller than the change it claims. Both halves of the card are
wrong at once and they contradict each other.

**Proves it real.** Run `getAnomalyInsights(db, new Date('2026-08-17'))` against a copy of .mizan/mizan.db and read the
emitted message and metric; then run the prior-window SUM for Shopping over 2026-06-19..2026-07-18
and observe a negative total with a non-zero purchase-row count. The route passes message and metric
through unchanged (routes/insights.ts:336), so what the service emits is what renders.

**Proves it fixed.** In anomalyInsights.ts, split the null arm into `previous_spend === 0` (the honest "no comparable
spending" case) and `previous_spend < 0` (which must state the prior window netted negative rather
than claim there was none), and stop publishing a delta that exceeds the figure it accompanies
without saying why. Add a fixture to tests/anomalyInsights.test.ts with a prior window holding
purchases plus larger refunds, asserting the emitted copy does not contain "no comparable spending"
and that the metric is reconcilable with the stated figure.

---

## 30. [HIGH] The spending-spike detector fires on 303 of 365 days of the owner's real ledger, in unbroken runs up to 94 days; its test file proves detection twice and silence never

`detector-silence` | 3/3 kept | finder confidence: verified | found by: test-quality

**Evidence.** Replaying `getAnomalyInsights` against the live DB copy for every date from 2025-09-01 to
2026-08-31: `spending-category-spike` fires on 303 of 365 days across 8 categories (Shopping 107
days, Home 39, Travel 34, Transport 23, Pets 17, Entertainment 15, Taxes 13, Health 5), in 10
unbroken runs, the longest 2026-02-07..2026-05-11 (94 days) and 2026-05-15..2026-07-15 (62 days).
Driving routes/insights.ts over HTTP against the live copy today returns it inside the 6-row payload
the Plan screen renders: "warning | Spending spike detected | Home spending is up 12816% versus the
prior 30 days. | metric $2,030" (a $15.84 prior window against ~$2,046 current). Thresholds at
anomalyInsights.ts:72-76 are $300 current / $200 delta / 1.75x, which an ordinary lumpy category
clears most months. tests/anomalyInsights.test.ts holds two tests (:31, :50); neither constructs an
ordinary healthy ledger and asserts an empty result. This contradicts .claude/plans/part-4-the-last-
mile.md:375-382 ("V6 [GOOD NEWS, verified by execution] The detectors are silent on the owner's real
data ... This refutes the obvious projection that a month unattended would leave standing findings
the owner cannot act on"), which measured only sync health, data quality and personal-finance
invariants and never ran this detector.

**Failure scenario.** The owner buys furniture in one month and nothing the next. Shopping/Home clears $300 current, $200
delta and 1.75x, so a red 'Spending spike detected' warning occupies one of the six insight slots on
/plan for up to three months at a stretch, reporting percentages like 12816% off a near-zero base.
There is no action that clears it and nothing is actually anomalous; the six-slot panel is the
scarce resource it crowds out.

**Proves it real.** Replay `getAnomalyInsights(db, d)` over a year of dates against a copy of .mizan/mizan.db and count
firing days and consecutive runs; separately drive routes/insights.ts over HTTP against the same
copy and confirm the row is inside the sliced top six. Caveat stated honestly: the date replay uses
today's ledger state at historical dates, so recategorizations since could shift individual days;
the HTTP check of today's payload is immune to that objection and is the anchor.

**Proves it fixed.** Either raise the bar so an ordinary lumpy category cannot clear it (a floor on the prior window, or
a requirement that the current window beat a multi-month baseline rather than one neighbouring
window), or make the finding actionable and dismissable. Then add a healthy-silence test: a fixture
with several months of lumpy but ordinary category spending asserting `getAnomalyInsights` returns
[], and re-run the year-long replay expecting firing days in the single digits rather than 303.

---

## 31. [HIGH] Undoing a create_merchant_rule action does not hold: the rule survives and the next sync's auto-categorization re-files every row that was uncategorized before the sweep

`ai / undo` | 3/3 kept | finder confidence: inferred | found by: ai-context-truth

**Evidence.** /Users/mahdi/code/mizan/server/src/services/advisorDrafts.ts:1599-1629 `undoAdvisorAction` calls
only `revertRevisions` (transaction categories) and `undoRuleRetirements` (restores retired rules);
nothing deletes a rule the action created, and the docstring at advisorDrafts.ts:1592-1595 says so
deliberately ("A merchant rule the action created is left in place… undo here means 'put the ledger
back'"). `revertRevisions` restores each row's prior category and source, which for a previously-
uncategorized row is NULL. /Users/mahdi/code/mizan/server/src/services/rules.ts:663-665
`autoCategorizeTransactions` runs on every sync (server/src/services/syncManager.ts:478) and calls
`applyMerchantRulesToExistingTransactions(db, { onlyUncategorized: true })`; rules.ts:599-600
selects `WHERE category_id IS NULL` and rules.ts:629-648 has no exclusion for rows carrying an AI
revision. /Users/mahdi/code/mizan/CLAUDE.md states "`POST /api/ai/actions/:id/undo` reverts an
action's whole blast radius, including rows a merchant rule swept in."

**Failure scenario.** The worker autonomously creates an AI rule for a merchant with `apply_existing: true`; it sweeps 30
previously-uncategorized rows. The owner disagrees and clicks Undo in Settings. The 30 rows go back
to `category_id NULL`. The rule is still live. Within the hour the scheduled sync runs
`autoCategorizeTransactions`, the same rule matches the same 30 rows, and they are re-filed under
the same category with `category_source = 'rule'`. The owner's reversal is silently undone, the rows
now look owner-neutral rather than AI-authored, and `refilableTransactions`' revision guard keeps
the model from ever revisiting them. This is the self-reverting repair trap CLAUDE.md names for
provider amounts, reached through the rule path.

**Proves it real.** On a `migratedTestDb()` fixture: insert uncategorized rows for one merchant, confirm a
`create_merchant_rule` draft with `apply_existing: true`, call `undoAdvisorAction`, assert the rows
are NULL, then call `autoCategorizeTransactions(db)` and assert they are categorized again by the
same rule.

**Proves it fixed.** Either undo retires (not deletes) the rule the action created, or the re-apply path excludes rows
whose newest `transaction_category_revisions` row is a revert of that rule's action; a regression
test runs undo followed by `autoCategorizeTransactions` and asserts the rows stay reverted. The
CLAUDE.md sentence about the blast radius is amended or becomes true.

---

## 32. [HIGH] Dismissing a recurring pattern deletes the row that records the dismissal, so the bill returns two syncs later

`sync` | 3/3 kept | finder confidence: inferred | found by: budget-recurring

**Evidence.** routes/recurring.ts:301-309 dismisses by setting is_active = 0, is_confirmed = 0 and NULLing
recurring_id on every linked transaction. services/recurring.ts:440 is the guard that honours that
decision: `if (!existing.is_active && !existing.is_confirmed) continue;`.
services/recurring.ts:535-540 then DELETEs `WHERE is_active = 0 AND is_confirmed = 0 AND NOT EXISTS
(SELECT 1 FROM transactions t WHERE t.recurring_id = recurring_patterns.id)` - the identical
predicate, plus a condition dismiss itself just made true. The comment at recurring.ts:530-534
claims the delete is "Deliberately narrow ... A confirmed pattern is the user's own decision", but a
dismissal is equally the user's decision and is exactly the shape being deleted. Reachable from the
UI: client/src/views/Ledger.tsx:367 -> client/src/lib/api.ts:446.

**Failure scenario.** Owner dismisses a detected bill on the Ledger. Sync N runs detectRecurring: step 3 finds the
merchant group (its >=3 transactions are still in the ledger and still pass the pool filter), hits
the line-440 guard and correctly skips it; step 7 then deletes the pattern row. Sync N+1 runs
detectRecurring: `SELECT ... FROM recurring_patterns WHERE merchant_name = ?` now returns undefined,
so the else branch at recurring.ts:459-479 INSERTs a fresh row with is_active = 1, is_confirmed = 0,
and step 5 relinks the transactions. Two hours after the dismissal the bill is back on the Bills
list, back in buildRecurringForecast's bills and net totals, and back in
getMonthlyBudgetsWithProjection's expected_recurring for its category. On the live DB all 5 active
patterns are in this position; none is currently dismissed, so this is latent, not observed.

**Proves it real.** migratedTestDb with a merchant that has >=3 monthly transactions. Run detectRecurring (pattern
created). POST /api/recurring/:id/dismiss. Run detectRecurring twice. Assert the pattern row exists
after run 1 and is gone; assert after run 2 that a pattern for that merchant_name exists again with
is_active = 1. tests/recurringDetect.test.ts:234 cannot catch this: its 'stranded' fixture is a bare
pattern row with no transactions anywhere in the ledger, so it never distinguishes a renamed
leftover (nothing to re-detect) from a dismissal (a live merchant group waiting to be re-detected).

**Proves it fixed.** Give dismissal a durable marker the delete cannot swallow - a dismissed_at column, or exclude from
step 7 any pattern whose merchant_name still matches a live detectable group - and fix the comment
to state the real narrowing rule. Both halves must be tested: a dismissed pattern survives three
detectRecurring runs and never reappears in buildRecurringForecast, AND the original stranded case
(a pattern whose merchant_name no longer normalizes out of any live group) is still deleted, so the
guard does not simply disable the cleanup migration 029 exists to obviate.

---

## 33. [HIGH] anomalyInsights.test.ts asserts no healthy case, and its only silence assertion is vacuous

`detectors / tests` | 3/3 kept | finder confidence: inferred | found by: detector-silence

**Evidence.** tests/anomalyInsights.test.ts is 61 lines and holds two tests. :31 asserts detection of both rows.
:50-61 ('anomaly insights exclude transfer categories from spending spikes') is the only assertion
of silence; its fixture inserts -50 cents and -2500 cents in cat_xfer_in and -80 cents in cat_food.
server/src/services/anomalyInsights.ts:72-73 gates on `current_spend >= 30000` and `current_spend -
previous_spend >= 20000`. Grouped as 'Transfers', current_spend is 2500 cents; grouped as 'Food &
Drink', 80 cents. Both are two orders of magnitude below the gate.

**Failure scenario.** Delete EXCLUDED_REPORT_ROOT_CATEGORY_IDS and its WITH RECURSIVE arm from anomalyInsights.ts
entirely, so transfers, investment flows and crypto flows all count as spend. The test at :50 still
passes, because the fixture never reaches the HAVING gate under either version of the code. The
suite therefore contains no assertion that the exclusion works, and no assertion that the detector
is ever silent on a healthy ledger - which is the coverage gap that let the finding above ship. This
is the failure CLAUDE.md names in the Tests section: 'Tests that assert the defect case do not catch
the failures this codebase actually has.'

**Proves it real.** Comment out the EXCLUDED_REPORT_ROOT_CATEGORY_IDS filter (both the CTE and the `NOT IN (SELECT id
FROM excluded_report_categories)` clauses) and run `node --test --import tsx
tests/anomalyInsights.test.ts`. Both tests still pass. I read this rather than mutating it, hence
'inferred'.

**Proves it fixed.** Raise the exclusion fixture above the $300/$200 gates so removing the exclusion list turns the test
red, and add a separate healthy-ledger test asserting []. Confirm both by mutation: each new test
must fail when the behaviour it names is removed.

---

## 34. [HIGH] localGuard is mounted on /api only, so the Vite dev file server serves .mizan/mizan.db and .mizan/credentials.json unguarded

`security-boundary` | 2/3 kept | finder confidence: inferred | found by: security-localguard

**Evidence.** server/src/index.ts:130, `app.use('/api', localOriginGuard(localGuard));`. Everything outside /api
is handled by `vite.middlewares`, injected at listen time by vite-express (node_modules/vite-
express/dist/main.js:166, mounted at `config.base` = '/'), which is appended after the /api guard.
Resolved the real config without starting a server (`resolveConfig` on vite.config.ts, vite 6.4.1):
`root = /Users/mahdi/code/mizan/client`, `fs.strict = true`, `fs.allow =
['/Users/mahdi/code/mizan']`, `fs.deny = ['.env','.env.*','*.{crt,pem}','**/.git/**']`, and
`fsDenyGlob('/Users/mahdi/code/mizan/.mizan/mizan.db') === false`,
`fsDenyGlob('.../.mizan/credentials.json') === false` (`.env` correctly returns true). Vite's
`serveRawFsMiddleware` (node_modules/vite/dist/node/chunks/dep-D4NMHUTW.js:35469) serves `/@fs/<abs
path>` through `sirv('/')` with `dev: true`, and in dev mode sirv resolves via `viaLocal` with no
dotfile filtering (the `opts.dotfiles` check at :35312 is only in the `!opts.dev` file-map branch).
`.mizan/mizan.db` is 3,264,512 bytes, mode 0644. Honest scoping: Vite has its own host check
(`hostCheckMiddleware`, :38696-38698, default `allowedHosts: []`) which rejects a rebound `Host:
evil.com`, so the DNS-rebinding path that localGuard's comment (localGuard.ts:1-12) claims to close
is closed here by Vite, not by mizan. But `isHostAllowedWithoutCache` (:32166) returns true for any
IPv4-literal hostname and for `localhost`, so the LAN path opened by finding 1 is wide open.

**Failure scenario.** With the server on all interfaces (finding 1), a LAN peer runs `curl -H 'Host: localhost:3001'
http://<ip>:3001/@fs/Users/mahdi/code/mizan/.mizan/mizan.db -o ledger.db` and gets the entire SQLite
file, every transaction, balance, holding and advisor action, without touching an API route,
without CORS mattering (curl is not a browser), and without localGuard being in the path at all.
`/@fs/.../.mizan/credentials.json` yields the AES-GCM envelope (useless without the keychain key,
but it is exfiltrated). The absolute path is discoverable from the dev server's own output: Vite-
transformed modules carry sourcemaps whose `sources` are absolute, and the error overlay prints
absolute paths.

**Proves it real.** With `npm run dev` up: `curl -s -o /dev/null -w '%{http_code} %{size_download}\n' -H 'Host:
localhost:3001' 'http://127.0.0.1:3001/@fs/Users/mahdi/code/mizan/.mizan/mizan.db'` returns `200
3264512`. The inferred half is exactly this HTTP round trip, I read the middleware chain and
resolved the config but did not run the server.

**Proves it fixed.** The same curl returns 403. Fix is to mount the guard at the app root
(`app.use(localOriginGuard(localGuard))` before the routers) rather than at '/api', and additionally
set `server.fs.deny` in vite.config.ts to include `.mizan/**`. Regression test: drive the assembled
app over HTTP and assert a `/@fs/`-prefixed request for a file under `.mizan/` is refused, and
assert a foreign Host on a non-/api path is refused.

**Dissent (1 of 3 refuters).** REFUTED as framed. The mechanism is largely real, but the named defect (localGuard's mount point) is
not the cause of the named harm, and the guard-at-'/' repair the title implies would not block the
finding's own proof-of-concept.  What I confirmed (so the record is honest about what survives): - `

---

## 35. [MEDIUM] CLAUDE.md describes the money write path as it was before the last two commits, in both directions

`docs` | 3/3 kept | finder confidence: verified | found by: drift-part2

**Evidence.** CLAUDE.md:179-180 states the liability-sign correction "adopts the ledger's implied value only when
it is negative, the stored value is positive, and the magnitudes match to the cent".
server/src/services/liabilitySign.ts:149-150 gates on `Math.sign(expectedOwed) ===
Math.sign(account.current_balance)` and `Math.abs(expectedOwed) !==
Math.abs(account.current_balance)`, i.e. either direction; the comment at :133-142 says so
explicitly and cites a 2026-08-01 correction in the other direction worth $5,433.49. Separately
CLAUDE.md:183-184 states "Mis-signed transactions are reported and not corrected, for a structural
reason worth keeping: `upsertSimplefinTransaction` compares and overwrites `amount`, so a repair
reverts within the hour." server/src/services/simplefin.ts:564-565 sets `ownerOwnsAmount =
existing.amount_source === 'human'` and keeps the stored amount, and transactions.ts:474 / :628-660
ship the owner correction and its release path. .claude/plans/relink-and-close.md Phase 1 records
this landing on 2026-08-01.

**Failure scenario.** Anyone touching the sync money path reads CLAUDE.md first (it is the file this repo hands every
agent, and it is gitignored so nothing else records it). They conclude the sign correction can only
ever move a stored positive to a negative, and that correcting a mis-signed amount is structurally
impossible because the provider overwrites it hourly. Both are false at HEAD. The first understates
the authority of a write path that changes net worth; the second is the stated reason the 14
Fidelity rows stay wrong, and it was removed a month ago.

**Proves it real.** Read liabilitySign.ts:147-150 against CLAUDE.md:179-180, and simplefin.ts:563-565 against
CLAUDE.md:183-184. Live corroboration for the amount half: transactions carries an amount_source
column with 134 rows at 'provider' and none at 'human', which the CLAUDE.md sentence says cannot
exist as a concept.

**Proves it fixed.** CLAUDE.md's Sync section states the current gate (signs disagree, magnitudes match exactly, either
direction) and the current amount contract (a human-owned amount survives resync and the provider's
competing figure is filed as provider_rejected), with the release path named. The record's own
instruction applies: back the file up outside git, since nothing else carries it.

---

## 36. [MEDIUM] rules.ts still prints "236 live rules over 41 distinct timestamps, 173 of them sharing one" beside the query that now returns 248 / 55 / 171

`docs` | 3/3 kept | finder confidence: verified | found by: drift-part3

**Evidence.** server/src/services/rules.ts:502-504 states "`merchant_rules` is dense in exactly those ties (236
live rules over 41 distinct timestamps, 173 of them sharing one: `SELECT created_at, COUNT(*) FROM
merchant_rules WHERE retired_at IS NULL GROUP BY created_at ORDER BY 2 DESC`)"; rules.ts:433 repeats
"236 live rules share 41 distinct". Running that exact query against the live copy: `SELECT
COUNT(*), COUNT(DISTINCT created_at) FROM merchant_rules WHERE retired_at IS NULL` returns 248 and
55, and the largest single-timestamp group is 171. .claude/plans/rebuild-part-3.md:610 scheduled
this repair explicitly ("The stale `rules.ts` docstring is re-derived ... Re-run the query, paste
the output, print the query beside it") and it is the only Phase 15 item of the six that is
untouched.

**Failure scenario.** All three figures are wrong, in the present tense, in the docstring for `id ASC` -- the tiebreak
whose entire justification is how dense the `created_at` ties are. The next person deciding whether
`id ASC` is still load-bearing reads that 41 of 236 timestamps are distinct (17%) when the live
ratio is 55 of 248 (22%), and the "173 sharing one" figure is the specific evidence for the
comparator. The docstring prints the query beside the number, which is exactly the construction rule
2 asks for, and the query refutes the number.

**Proves it real.** `sqlite3 .mizan/mizan.db "SELECT COUNT(*), COUNT(DISTINCT created_at) FROM merchant_rules WHERE
retired_at IS NULL"` -> 248|55, and the GROUP BY the comment prints -> top group 171. Reproduced
against the read-only copy.

**Proves it fixed.** The three figures re-derived and dated, or replaced by a test that recomputes them the way
tests/contrastClaims.test.ts recomputes the palette prose. A dated figure with no re-derivation goes
stale again by the next sync.

---

## 37. [MEDIUM] The focus ring is still dead on all 42 `.mz-field` inputs, and index.css states the opposite

`client` | 3/3 kept | finder confidence: verified | found by: drift-uioverhaul

**Evidence.** Compiled the real config to a scratchpad probe (`./node_modules/.bin/tailwindcss -c
tailwind.config.js -i client/src/index.css -o probe.css`). probe.css:673 emits
`input:where([type='text']):focus, ... input:where([type='number']):focus, ... textarea:focus,
select:focus { outline: 2px solid transparent; outline-offset: 2px; ... }` from the
@tailwindcss/forms base strategy (tailwind.config.js:165). probe.css:886 emits `:focus-visible {
outline: 2px solid var(--mz-sage) }` from client/src/index.css:676-680. Specificity:
`input:where(...):focus` is (0,1,1) because `:where()` contributes zero; `:focus-visible` is
(0,1,0). The forms rule wins on every input, textarea and select regardless of source order.
probe.css:1468-1474 shows `.mz-field:focus` setting `--tw-ring-shadow: ... calc(0px + ...)`, which
also kills the plugin's own blue ring. What is left is `border-color: line-2 -> line-3`.
client/src/index.css:684-689 says: "No `focus:outline-none` here. It used to override the global
:focus-visible rule above, which left the `border-line-2` to `focus:border-line-3` swap below as the
field's whole focus affordance. That swap is `line-3` on `line-2`, 1.57:1 light and 1.53:1 dark ...
The outline is the affordance. The border swap is not, at either figure."

**Failure scenario.** Owner tabs into any amount field in the Plan budget/goal dialogs, the Investments cost-basis dialog,
or any of the other 42 `.mz-field` call sites. No sage outline is painted, because the forms
plugin's higher-specificity `:focus` rule sets the outline transparent, and `focus:ring-0` (still
present at client/src/index.css:694) suppresses the fallback ring. The visible focus indicator is a
1px border swap the file's own comment measures at 1.57:1 and explicitly rejects as insufficient.
ui-overhaul.md Phase 0 called for dropping both `focus:outline-none` and `focus:ring-0`; only the
first was dropped, and the plugin's transparent outline was never accounted for. The comment is
therefore a claim the code does not honor - rule 2 - written into the very block that documents the
defect.

**Proves it real.** Open any modal with an input, press Tab, look for the sage outline. Or run the compiled probe and
compare the two selectors' specificity, which is what three auditors did for the original `/alpha`
finding.

**Proves it fixed.** `.mz-field` re-establishes the outline explicitly (e.g. `focus-visible:outline focus-
visible:outline-2 focus-visible:outline-sage`) or the global rule is raised above the plugin's
specificity, and `focus:ring-0` is removed or justified. A test in the shape of
tests/edgeToken.test.ts that compiles the config and asserts a non-transparent outline wins on a
focused `input[type=text]` carrying `.mz-field`.

---

## 38. [MEDIUM] ui-overhaul.md was tracked into git but never trimmed, so the repo now ships 73 lines of false diagnosis

`docs` | 2/3 kept | finder confidence: verified | found by: drift-uioverhaul

**Evidence.** `git ls-files .claude/plans/` lists ui-overhaul.md; it entered at 906c75e and has never been
modified since (`git log --oneline -- .claude/plans/ui-overhaul.md` returns one commit).
.claude/plans/rebuild-part-3.md:639-648, Decision 4, specifies: "`.claude/plans/ui-overhaul.md` is
trimmed to a stub and folded, not deleted ... What stays in the file is the `/alpha` diagnosis ...
Trim it to that plus a pointer here, and track it." The tracking half happened; the trim did not.
rebuild-part-3.md:604 also asserts "Both are currently outside git", which was already false for ui-
overhaul.md when that line was written. At HEAD the file's Diagnosis section (lines 11-72)
describes: a `/alpha` build bug that is fixed (tailwind.config.js:5 uses the channel form); `--mz-
paper #f3ede1` and `--mz-card #faf5ea` at 1.07:1, when client/src/index.css:282 is now `--mz-
paper-c: 255 255 255` and :532 is `0 0 0`; "one box-shadow in the entire client" against an e1/e2/e3
ladder at tailwind.config.js:151-155; 28 font sizes against 12 named steps at :119-132; and a 12-dot
nav rail replaced by six words. Nine of the twelve views it cites file:line for (Transactions,
Today, CashFlow, Reports, ReviewInbox, Budget, Goals, Bills, Advisor) no longer exist.

**Failure scenario.** A reader (or a future agent) opens the oldest tracked plan looking for the open UI work and gets a
map of a codebase that was deleted: it names files that do not exist, quotes contrast ratios from a
palette that was replaced on 2026-08-01, and reports as Blocking five bugs of which four are fixed.
The genuinely open items (bugs 6, 8, 12, 14, 20, 22) sit unlabelled among 22 that are fixed or moot,
so the file's signal is roughly one in five and nothing in it says which. The repo's own standard -
never a claim the code did not check - is broken at document scale, and this is the one plan file
whose contents no test, no typecheck and no re-derivation pass ever touches.

**Proves it real.** Read lines 11-72 against client/src/index.css and tailwind.config.js at HEAD, and `ls
client/src/views` against the file:line citations in the Bugs section.

**Proves it fixed.** The file is trimmed to what rebuild-part-3 Decision 4 specifies - the `/alpha` compilation evidence
plus a pointer forward - with the still-open items (6, 8, 12, 14, 20, 22) moved to whichever plan is
live, or each is closed. `git log -- .claude/plans/ui-overhaul.md` shows a second commit.

**Dissent (1 of 3 refuters).** Refuted as noise under the record lens. The staleness itself is factually accurate (verified:
index.css:282 = `--mz-paper-c: 255 255 255`, :532 = `0 0 0` after the pure-black-and-white repalette
in 4a2db38; tailwind.config.js:5 uses the channel form so the /alpha bug is fixed; nine of the
twelve cit

---

## 39. [MEDIUM] The toast container covers the nav rail's sync line and Settings link for four seconds after every sync

`client` | 2/3 kept | finder confidence: verified | found by: drift-uioverhaul

**Evidence.** client/src/components/Toast.tsx:58: `fixed bottom-6 right-6 z-50`. Toast.tsx:30-31: each item is
`min-w-[280px] max-w-[380px]`. The container has no `pointer-events-none`.
client/src/components/NavRail.tsx:129: the rail is `w-[var(--mz-rail-w)]` with `py-[26px]`, rendered
last in the flex row at client/src/components/Layout.tsx:20, i.e. on the right, with no z-index
(static). client/src/index.css:74: `--mz-rail-w: 164px`. NavRail.tsx:162-179: Settings and the sync
button are the last elements in the rail, the sync button ending 26px from the viewport bottom.
client/src/components/CommandPalette.tsx:671 explicitly offsets itself around the rail with
`pr-[calc(var(--mz-rail-w)+24px)]`; Toast does not.

**Failure scenario.** A toast anchored 24px from the right edge and 280-380px wide spans from 24px to 304-404px inward, so
it covers 140 of the rail's 164px. Vertically it occupies roughly 24-70px from the bottom; the sync
button occupies 26-44px. Every `sync_complete` fires `addToast({type:'success', message:'Sync
complete'})` (client/src/hooks/useSyncStatus.ts:45), so the moment the rail would flip from "Not
synced yet" to "Synced just now" - the finding above - a success toast lands on top of it and hides
it for four seconds. Because the container takes pointer events, the Settings link and the manual
Sync button are also unclickable for that window. This is ui-overhaul.md bug 22, never closed.

**Proves it real.** Trigger a sync and watch the bottom-right of the rail, or measure the rendered rects of
`.fixed.bottom-6.right-6` and the rail's sync button in devtools.

**Proves it fixed.** The toast container is offset by the rail the way CommandPalette already is (`pr-[calc(var(--mz-
rail-w)+24px)]`) or moved to a region the rail does not occupy, and carries `pointer-events-none` on
the container with `pointer-events-auto` on each item. A test asserting the toast container's
horizontal inset accounts for `--mz-rail-w`.

**Dissent (1 of 3 refuters).** REFUTED as noise under the record lens, though the geometry itself is real.  Verified mechanics (so
I am not refuting on facts): Toast.tsx:58 is `fixed bottom-6 right-6 z-50` with no `pointer-events-
none`; Toast.tsx:30 gives each item `min-w-[280px] px-4 py-3` with `text-body-lg` at 15px/22px
(tailw

---

## 40. [MEDIUM] Merging two accounts sums holdings_history quantity and value but silently keeps one side's cost_basis

`money-boundary` | 3/3 kept | finder confidence: verified | found by: money-boundary

**Evidence.** server/src/services/accounts.ts:287-296 is the collision handler: `UPDATE holdings_history AS target
SET quantity = quantity + (...source...), institution_value = institution_value + (...source...)
WHERE target.account_id = ?`. `holdings_history` also carries `cost_basis INTEGER` (and
`institution_price REAL`); `cost_basis` appears nowhere in `mergeAccounts` (grep for cost_basis in
accounts.ts returns nothing). The comment immediately above, at accounts.ts:283-286, states the rule
the code half-implements: "two rows for the same security on the same day are two parts of one
position once the accounts are one account."

**Failure scenario.** A SimpleFIN re-link delivers the same brokerage under a new provider id (the case commits 11eeb67 /
9b4675c added merge support for). The owner merges. For a date both accounts recorded the same fund
- say target 4 units / $400.00 value / $380.00 basis and source 6 units / $600.00 value / $570.00
basis - the merged row reads quantity 10, institution_value 100000 cents, cost_basis 38000 cents.
The AI tool `get_holding_history` (server/src/services/advisorChatTools.ts:665-687) serves that
point as value $1,000.00 against a basis of $380.00 and its own description tells the model a non-
NULL basis may be used, so the model reports a 163% gain on a position that gained 5.3%.

**Proves it real.** Read the merge SQL and the holdings_history schema (id, account_id, security_id, date, quantity,
institution_price, institution_value, cost_basis). The test that pins the sum,
tests/accountMerge.test.ts:79-93, asserts only `quantity` and `institution_value`, and its
`addHistory` helper (line 26-29) never inserts a cost_basis at all, so the column is NULL in the
fixture and the omission is invisible. Live data makes the case reachable: 92 of 322
holdings_history rows carry a non-null cost_basis. The AI tool is the sole consumer of this table's
cost_basis - `investmentsApi.holdingHistory` (client/src/lib/api.ts:245) has zero callers anywhere
in client/src, server/src or tests, so no screen renders it.

**Proves it fixed.** Sum `cost_basis` in the same UPDATE with a NULL-preserving rule (a merged basis is unknown if either
side's is unknown, not the known half), and extend tests/accountMerge.test.ts's 'summed, not
silently dropped' case so its fixture sets a cost_basis on both rows and asserts the merged basis.
Also assert `institution_price` is left alone, since a per-unit price is correctly not summed.

---

## 41. [MEDIUM] GET /api/networth/history?months= builds its cutoff in UTC with Date.setMonth, so the 12-month series silently loses its oldest sheet after 20:00 local, and non-12 windows overflow at month end

`money-boundary / read-path clock` | 3/3 kept | finder confidence: verified | found by: time-dependence

**Evidence.** server/src/routes/networth.ts:84-88, `const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth()
- months); ... params.push(cutoff.toISOString().split('T')[0]);` compared against
`net_worth_snapshots.date`, which is a LOCAL 'yyyy-MM-dd' (server/src/services/dates.ts header
comment; written at server/src/services/snapshot.ts:200 as `format(new Date(),'yyyy-MM-dd')`).
Machine TZ verified America/New_York, getTimezoneOffset()=240. Reproduced the cutoff arithmetic in
node: 2026-08-31T12:00 local months=6 -> '2026-03-03' (Feb 31 overflow, 3 days lost);
2026-07-31T12:00 months=1 -> '2026-07-01' (zero months of history returned); 2026-08-31T21:00
months=12 -> '2025-09-01' where the same request at 12:00 gives '2025-08-31'. Live snapshot dates
confirm the estimated half is exactly one sheet per month on the 1st (2025-09-01 … 2026-06-01, 16
estimated + 25 measured = 41 rows). The only client callers are
client/src/views/accounts/Accounts.tsx:132-138 and client/src/views/Instrument.tsx:373-376, both
`networthApi.history(12)` (client/src/lib/api.ts:614-615). No test file covers this route (only
tests/snapshotBackfill.test.ts touches snapshots).

**Failure scenario.** On 2026-09-01 the request `GET /api/networth/history?months=12` returns 41 rows before 20:00 EDT and
40 rows after, with no data change: the cutoff moves from '2025-09-01' to '2025-09-02' and drops the
2025-09-01 sheet. Downstream that changes a printed count, not just a chart: Instrument.tsx:373
feeds `earlierSheets` -> `readWeekChange` (client/src/views/instrumentReadings.ts:233-259), whose
`refused` counter is `eligible.filter(p => !comparable.has(p.date)).length`, and `comparableHistory`
(client/src/components/balance/BalanceScale.tsx:196-207) refuses every estimated sheet. So the
caption `refusedClause` renders "N earlier sheets reached a different set of accounts and are not
comparable to this one" with N one lower in the evening than in the afternoon of the same day. It
also moves the TrendChart's calibrated domain on /accounts. Separately, `months=1` on any 31st
returns only the current month (Jun 31 -> Jul 1).

**Proves it real.** Run the server with TZ=America/New_York and a faked clock at 2026-09-01T12:00 local and again at
2026-09-01T20:30 local; `GET /api/networth/history?months=12` returns a different row count and a
different earliest `date` for the identical database. Or just evaluate the two lines directly:
`const c=new Date('2026-09-01T20:30:00'); c.setMonth(c.getMonth()-12);
c.toISOString().split('T')[0]` yields '2025-09-02'.

**Proves it fixed.** Cutoff computed as `format(subMonths(now, months), 'yyyy-MM-dd')` with date-fns (local, and month-
end clamping), `now` injectable into the handler. Regression tests: (a) same pinned local day at
12:00 and 20:30 returns identical row sets; (b) `months=1` anchored at 2026-07-31 returns rows from
2026-06-30 onward, not 2026-07-01; (c) `months=6` anchored at 2026-08-31 does not skip
2026-03-01/02.

---

## 42. [MEDIUM] A no-op merchant-rule re-proposal is counted as `applied` and toasted to the owner as an applied change, on the same pass that deliberately declines to record it as an action

`ai` | 2/3 kept | finder confidence: verified | found by: ai-authority

**Evidence.** server/src/services/advisorDrafts.ts:779-785 computes `wroteNothing` (`upsert.status === 'unchanged'
&& storedPattern === payload.pattern.trim() && applied === 0`) and advisorDrafts.ts:1776 uses it to
SKIP the `advisor_actions` insert, with the comment that recording it "produces exactly what the
refusal path was fixed to stop producing, an action with no blast radius and an Undo that reverts
nothing". But `confirmAdvisorDraft` still returns `{success: true, changed: 0}`, and
server/src/services/aiJobs.ts:459-462 increments `applied++` and marks the draft 'confirmed' purely
on the absence of a throw, it never inspects `wroteNothing` or `changed`. That count reaches the
owner at aiJobs.ts:751-759: `if (counts.applied > 0)` emits `ai_pass_applied` with "AI review
applied N change(s)", rendered as an info toast at client/src/hooks/useSyncStatus.ts:48-56. Live DB,
consistent with the loop the code's own comment predicts ("The worker re-proposes a rule the ledger
already has on every pass"): `SELECT COUNT(*), COUNT(DISTINCT
lower(json_extract(payload,'$.pattern'))) FROM advisor_drafts WHERE kind='create_merchant_rule' AND
status='confirmed'` -> 98 rows over 33 distinct patterns, 6 patterns accounting for 71 of the 98;
`SELECT COUNT(*) FROM advisor_actions WHERE kind='create_merchant_rule'` -> 63. The mechanism is
verified in code; attributing the 98-vs-63 gap entirely to `wroteNothing` is inferred.

**Failure scenario.** An hourly pass proposes one `create_merchant_rule` for a pattern the ledger already carries with
identical casing and category. `confirmMerchantRule` writes nothing (no rule row, no revision, no
swept transaction), `confirmAdvisorDraft` correctly writes no `advisor_actions` row, and the pass
still reports `applied: 1`. The owner gets a toast reading "AI review applied 1 change" and every
query cache is invalidated and refetched. Opening the Cmd+K digest to see what changed shows
nothing, because the digest reads `advisor_actions`. The number in the toast is a claim nothing in
the database backs.

**Proves it real.** Seed a migrated fixture with a live AI rule for pattern P at category C, run `persistProposals` (or
a whole `runAiJob` pass) with a single `create_merchant_rule` proposal for exactly P and C, and
assert: `SELECT COUNT(*) FROM advisor_actions` unchanged, `SELECT COUNT(*) FROM
merchant_rule_revisions` unchanged, and the returned `PersistResult.applied` is 1 / the emitted
`ai_pass_applied.applied` is 1.

**Proves it fixed.** `persistProposals` counts a draft as applied only when `confirmAdvisorDraft` reports a write (the
result carries `wroteNothing` or the action id back to the caller instead of discarding it); a pass
whose only proposals were no-ops emits no `ai_pass_applied` event and records `applied: 0`. A
healthy-case test asserts silence: one identical re-proposal produces no toast event and no action
row, while a genuine creation in the same shape produces both.

**Dissent (1 of 3 refuters).** REFUTED as reported. The finder read the code correctly, but the live evidence is misattributed, the
driver is a recorded and already-fixed defect, and the path has never fired at HEAD.  (a) Conceding
the code. The mechanism is real as written: advisorDrafts.ts:779-785 computes `wroteNothing`, advis

---

## 43. [MEDIUM] The AI's own action history reports 63 rule creations as applied with no outcome accounting, and four of its rules no longer exist anywhere the prompt can see

`ai-context` | 2/3 kept | finder confidence: verified | found by: ai-context-truth

**Evidence.** /Users/mahdi/code/mizan/server/src/services/aiContext.ts:613-628 counts `advisor_actions` by kind
with no join to outcome; :648 heads the section "### Actions You Have Already Applied (N)"; :666-680
render per-kind counts. Outcome accounting exists only for `categorize_transaction`
(aiContext.ts:686-700: standing / undone / owner_changed, from `transaction_category_revisions`).
Rendered live: `create_merchant_rule: 63 (63 applied autonomously)` and `### Merchant Rules Already
In Place (248 live)` of which 19 are the model's. Live DB: `SELECT
json_extract(payload,'$.pattern'), COUNT(*) FROM advisor_actions WHERE kind='create_merchant_rule'
GROUP BY 1` yields 28 spellings / 25 case-folded patterns; `SELECT pattern FROM merchant_rules WHERE
source='ai'` yields 21. The four with an action and no rule at all (live or retired) are `Shake
Shack`, `SHELL`, `PERPLEXITY.AI`, `MARATHON`; `SELECT * FROM merchant_rules WHERE
lower(pattern)=lower(…)` returns nothing for any of them, and `merchant_rule_revisions` (16 rows,
earliest 2026-07-30) predates none of their July creation dates so carries no record either. The
only removal path is /Users/mahdi/code/mizan/server/src/routes/rules.ts:273 `DELETE FROM
merchant_rules WHERE id = ?`, a hard delete that writes no revision (cause inferred; ai_incidents =
0 rules out a guard-breach revert). The retirement path by contrast IS surfaced,
aiContext.ts:1206-1226, with "Do not propose them again unless the owner asks."

**Failure scenario.** Owner deletes an AI-authored rule from Settings. Nothing records it. On the next pass the model
reads "Actions You Have Already Applied" (its rule creations counted as facts), the 248-rule live
list (the deleted pattern absent), and the retired list (also absent), concludes no rule covers that
merchant, and proposes it again. `checkRuleDoesNotContradictOwnerRule` and
`checkRuleAgreesWithHistory` do not refuse it, because there is no rule to contradict. This is
exactly the Trupanion-thirteen-times loop the section's own docstring (aiContext.ts:604-611) says it
exists to stop, reached through the delete door instead of the retire door.

**Proves it real.** The four-pattern set difference above, re-derived on the live DB. Then delete an AI rule via DELETE
/api/rules/:id on a fixture and diff `buildFinancialContext()` before and after: the rule vanishes
from the live list, appears in no retired list, and the `create_merchant_rule` count is unchanged.

**Proves it fixed.** The rule delete route retires rather than deletes (or writes a `merchant_rule_revisions` row with
operation = 'delete'), the context surfaces AI rules the owner removed the way it surfaces retired
ones, and a test deletes an AI rule and asserts the pattern is named in the context as removed.

**Dissent (1 of 3 refuters).** REFUTED. The finding's headline evidence collapses under one query.  (1) Cause is unestablished and
the simplest explanation contradicts it. All four orphan patterns' actions are dated
2026-07-16T23:31, 2026-07-24T22:26 (x2) and 2026-07-24T23:54. The oldest row in the ENTIRE
merchant_rules table is

---

## 44. [MEDIUM] A provider-reported balance can be overwritten through PATCH /api/accounts/:id; the only guard is a ternary in a React modal, and the falsified figure is written into net-worth history as a measured snapshot

`money-boundary` | 2/3 kept | finder confidence: verified | found by: client-server-seam

**Evidence.** /Users/mahdi/code/mizan/server/src/services/accounts.ts:106-113 states the policy in a comment that
enumerates the fields and omits the money one: "institution_name/currency are provider-sourced and
only editable on manual accounts. type/is_liability are editable on any account...", and
`manualOnlyFields` on line 110 is exactly `[input.institution_name, input.currency]`.
`current_balance` is then written unconditionally at :158-161
(`values.push(toCents(input.current_balance))`) with no `is_manual` check.
shared/schemas/index.ts:13-23 (`UpdateAccountSchema`) permits `current_balance` on any account.
server/src/routes/accounts.ts:103-128 calls `updateAccount` and then, on `result.balanceChanged`,
calls `takeSnapshot()` immediately. The only thing preventing this today is client-side:
client/src/views/accounts/Modals.tsx:246, `current_balance: account?.is_manual ? currentBalance :
undefined`. Nothing tests it: `grep -rn "manual_only" tests/` and `grep -rln "updateAccount" tests/`
both return nothing. Persistence mechanism, from server/src/services/snapshot.ts:203-241:
`takeSnapshot` upserts the row for today's date with `is_estimated = 0`; the docstring at :484-490
states measured rows are untouchable ("`backfillSnapshots` skips a month holding an `is_estimated =
0` row, and its purge is scoped to `is_estimated = 1`").

**Failure scenario.** `PATCH /api/accounts/<a SimpleFIN account id>` with `{"current_balance": 25000}` from the owner's
own machine (localGuard permits same-origin writes). The service replaces the institution's balance
with 2,500,000 cents and the route immediately calls `takeSnapshot()`, writing today's
`net_worth_snapshots` row with `is_estimated = 0` off the fabricated figure. The next hourly sync
restores `accounts.current_balance` from SimpleFIN, and re-runs `takeSnapshot`, which corrects the
same-day row. But if no sync runs before midnight (MIZAN_AUTO_SYNC_ON_STARTUP=false,
MIZAN_SYNC_INTERVAL_MINUTES=0, or the machine asleep), the date rolls and that row is now a
permanent measured point: reconstruction only rewrites `is_estimated = 1` rows, so nothing ever
corrects it. The falsified point stays on the trend chart, in GET /api/networth/history, and inside
GET /api/reports/networth-attribution's start/end deltas forever. This is also the standing rule the
repo states as absolute, "Never rewrite a number an institution reported", with `liabilitySign.ts`
as the one exactness-bounded exception.

**Proves it real.** Against a dev instance: PATCH a synced (`is_manual = 0`, `connection_type = 'simplefin'`) account
with a `current_balance` and observe a 200 plus a changed `accounts.current_balance`; then `SELECT
date, net_worth, is_estimated FROM net_worth_snapshots ORDER BY date DESC LIMIT 1` shows the
fabricated net worth on an `is_estimated = 0` row. The absence of any server-side refusal is
directly readable at services/accounts.ts:110 and :158-161.

**Proves it fixed.** `current_balance` joins `manualOnlyFields` (or gets its own `!existing.is_manual` refusal returning
`manual_only`), the comment at :106-113 is amended to state the money field's rule explicitly, and a
regression test asserts a synced account rejects a `current_balance` PATCH while a manual one
accepts it, the first test in the suite to touch `updateAccount` at all.

**Dissent (1 of 3 refuters).** REFUTED on reachability, not on mechanism. The finder's code reading is accurate and I verified
every cited line, so I will not pretend the guard exists.  What is true (verified):
server/src/services/accounts.ts:110 sets `manualOnlyFields = [input.institution_name,
input.currency]` and :111 rejects

---

## 45. [MEDIUM] The holding modal prints a per-unit price through the whole-dollar formatter, so a live sub-dollar token reads "@ $0"

`client / money formatting` | 3/3 kept | finder confidence: verified | found by: investments

**Evidence.** client/src/views/Investments.tsx:91-93 renders `{quantity.toLocaleString(...,
{maximumFractionDigits: 4})} shares @ {formatWholeCurrency(holding.institution_price)}`.
client/src/lib/formatters.ts:23-32 sets `maximumFractionDigits: 0`, so any price under $0.50 prints
as `$0`. `institution_price` is deliberately REAL dollars per unit (services/money.ts:8-10,
schemaDoc.ts:845) exactly because rounding it destroys sub-cent tokens, and the one surface that
shows it rounds it to whole dollars. This is the defect class the repo already named in
formatPayoffFigure (client/src/views/instrumentReadings.ts:178-187: a figure printed as $0 says the
opposite of what was measured), applied there and not here.

**Failure scenario.** Live today: the Coinbase POL position is priced at $0.090195 per unit, so opening its row prints
'237.3 shares @ $0' beside a $21 position value. The rounding also breaks the arithmetic the line
invites: the BTC row prints a quantity rounded to 4 decimals and a whole-dollar price whose product
is about $235.52, next to a stated value of $238; LINK prints '@ $11' against a true $11.29. Four of
the eight crypto rows in the live ledger show a price the reader cannot multiply back to the value
beside it.

**Proves it real.** `SELECT s.ticker, h.institution_price, h.institution_value FROM holdings h JOIN securities s ON s.id
= h.security_id WHERE s.type = 'crypto'` on the live copy gives POL at 0.090195, LINK at 11.2915,
AVAX at 7.225, BTC at 78506.255; run each through formatWholeCurrency and compare with
formatCurrency.

**Proves it fixed.** Format a per-unit price with a precision that cannot round it to zero (follow formatPayoffFigure's
rule: fall back to full precision below a dollar), and print enough quantity digits that price times
quantity reconciles with the value on the same line, or drop the '@ price' clause. Test: assert the
rendered string for a $0.090195 price is not `$0`, and that for each live-shaped row the printed
quantity times the printed price rounds to the printed value.

---

## 46. [MEDIUM] Budget projection ignores recurring occurrence adjustments, so a skipped bill still inflates projected_spend

`budgets` | 3/3 kept | finder confidence: verified | found by: budget-recurring

**Evidence.** services/budgetProjection.ts:4 imports only `occurrenceDate, recentSignedAmounts` from ./recurring;
it never imports getRecurringAdjustmentMap. recurringOccurrencesForMonth
(budgetProjection.ts:160-202) walks occurrence dates and pushes `Math.abs(signedAmount)` with no
lookup against recurring_occurrence_adjustments. services/recurringForecast.ts:153 does exactly that
lookup and buildOccurrence (recurringForecast.ts:70-81) honours skip, snooze and adjust. The comment
at budgetProjection.ts:171-172 asserts the opposite: "The forecast and the Bills list quote this
same estimate, so a budget cannot project a different figure for the bill it is projecting." The
skip action is wired in the UI today at client/src/views/Ledger.tsx:349-351; snooze and adjust
arrive through the create_recurring_adjustment draft kind.

**Failure scenario.** Owner skips an upcoming $220 Housing bill on the Ledger (upsertAdjustment action 'skip'). GET
/api/recurring/forecast drops it from bills and net, and the row renders dimmed. GET
/api/budgets/month/:y/:m still adds $220 to that category's expected_recurring, so projected_spend,
projected_remaining, projected_percent and pacing all carry a charge the owner told the app is not
coming. buildBudgetRowMeta (client/src/lib/budgetMath.ts:71) then renders a "projected" line that
the Bills screen contradicts. The snooze case is worse in the other direction: snoozing an
occurrence out of the month leaves the budget projecting it in the month it left, and never projects
it in the month it moved to. An 'adjust' makes the two surfaces quote two different dollar figures
for one bill, which is precisely what the comment says cannot happen.

**Proves it real.** migratedTestDb: one confirmed monthly pattern with a category that has a budget, next_expected
inside the current month. Read expected_recurring from getMonthlyBudgetsWithProjection.
upsertRecurringAdjustment(action 'skip') for that occurrence date. Read again: expected_recurring is
unchanged, while buildRecurringForecast's bills total has dropped by the full amount.

**Proves it fixed.** recurringOccurrencesForMonth calls getRecurringAdjustmentMap over the same pattern ids and applies
the same three rules buildOccurrence applies - drop on skip, use adjusted_date for month membership
on snooze, use adjusted_amount on adjust. Regression test asserting the budget's expected_recurring
and the forecast's per-category bill total agree to the cent under each of the three actions, plus
the healthy case: with zero adjustment rows both numbers are unchanged from today's values, so the
fix is silent on an ordinary month.

---

## 47. [MEDIUM] The Coinbase stage writes its zeroed-holdings count into `transactions_modified`, which the sync panel and the advisor prompt both render as transactions updated

`sync` | 3/3 kept | finder confidence: verified | found by: error-handling

**Evidence.** server/src/services/syncManager.ts:643, `transactions_modified: coinbaseResult.staleAccountCount`.
`staleAccountCount` is set at server/src/services/coinbase.ts:508-514, 559 to `zeroedCount`, the
number of `holdings` rows zeroed because the coin no longer appears in the response. It is not a
transaction count. server/src/routes/coinbase.ts:93 and :141, the same assignment on the connect-
time and manual-resync paths. client/src/components/SyncActivityPanel.tsx:227, renders
`{item.transactions_modified} updated` inside the per-item line "N accounts, N added, N updated, N
removed". client/src/components/SyncActivityPanel.tsx:39-41, `changedCount(run) =
transactions_added + transactions_modified + transactions_removed`, so a zeroed holding is counted
as a changed transaction in the run headline. client/src/lib/advisorPrompts.ts:172 and :280, the
same figure is stated to the model and to the owner as "N updated" transactions / "changed N
transactions". Live: `SELECT COUNT(*), SUM(transactions_modified) FROM sync_run_items WHERE
provider='coinbase' AND transactions_modified > 0` returns 0 rows / 0. Across all 177 coinbase run
items `SUM(transactions_modified)` is 0, so this has never fired on the live ledger. It is latent.

**Failure scenario.** Owner fully sells one coin on Coinbase. Next sync, coinbase.ts:509-514 zeroes that holding and
returns `staleAccountCount: 1`. syncManager.ts:643 stores it as `transactions_modified = 1`. The
sync panel then reads "Coinbase · 1 account, 0 added, 1 updated, 0 removed" and the run headline
counts one changed transaction, when zero transactions were added, modified or removed by that
stage. If the owner asks the advisor what the last sync did, advisorPrompts.ts:280 tells the model
"It saw 1 account and changed 1 transaction: 0 added, 1 updated, 0 removed, 0 skipped", which the
model will repeat as fact.

**Proves it real.** Against a migratedTestDb fixture, seed a Coinbase account with two holdings, run a sync whose
response omits one ticker, and assert the recorded `sync_run_items.transactions_modified` is 1 while
no row in `transactions` was inserted or updated by the run.

**Proves it fixed.** `staleAccountCount` stops being written into `transactions_modified`, either its own
column/`sync_changes` row naming what it is ("1 holding zeroed"), or dropped from the run item
entirely. A test asserting `transactions_modified` on a coinbase run item equals the number of
transaction rows the stage actually modified, on a run that zeroes a holding.

---

## 48. [MEDIUM] No timeout on any SimpleFIN or Coinbase HTTP call: one hung socket latches runFullSync permanently and silently

`sync` | 2/3 kept | finder confidence: verified | found by: boundary-egress

**Evidence.** `grep -n 'timeout\|axios.defaults'` over server/src/services/simplefin.ts, services/coinbase.ts,
routes/simplefin.ts and services/retry.ts returns nothing. The three call shapes carry no config:
simplefin.ts:891-893 `axios.create({ baseURL: accessUrl })`; coinbase.ts:367-376 `axios({ method,
url, data, headers })`; coinbase.ts:305-307 `axios.get(...)`; routes/simplefin.ts:44
`axios.post(decoded)`. axios 1.14.0 ships `timeout: 0` with the doc comment "If set to 0 (default) a
timeout is not created" (node_modules/axios/lib/defaults/index.js:140-143). services/retry.ts:34-48
`withRetry` awaits `fn()` with no deadline of its own. services/syncManager.ts:527-537 , 
`_activeSyncPromise` is cleared only inside `.finally()` of `_runFullSyncInternal()`, and the
comment at :543 confirms "a tick firing mid-sync just no-ops". Contrast
server/src/services/anthropicClient.ts:32-47, which writes out this exact latch failure at length as
the reason every AI call carries a five-minute clock.

**Failure scenario.** SimpleFIN (or api.coinbase.com) accepts the TCP connection and never responds, not hypothetical on
this network: live.db has 10 `ai_runs` rows failed with 'Request timed out.', which the AI calls
survived precisely because they carry the wall clock the bank calls lack, and 8 consecutive
'getaddrinfo ENOTFOUND beta-bridge.simplefin.org' sync failures are recorded in the plan files. The
axios promise never settles, `_activeSyncPromise` never clears, and from that moment every hourly
tick and every POST /api/sync returns the same pending promise. Balances, net worth, the review
queue and the AI pass all freeze at the last-synced values indefinitely, with no thrown error, no
failed run row (the `sync_runs` row stays 'running' forever), and the process still serving happily.
The numbers on screen are not wrong, they are frozen, and staleness is only surfaced once the
syncHealth thresholds trip, which is hours later at best.

**Proves it real.** Point the SimpleFIN access URL at a local server that accepts connections and never writes a
response. Call POST /api/sync; it never returns. Call it again; `isSyncActive()` is true and the
second call returns the same never-settling promise. Wait past MIZAN_SYNC_INTERVAL_MINUTES and
confirm no new `sync_runs` row appears.

**Proves it fixed.** An explicit `timeout` on both axios clients (and on the claim POST), bounded the way
anthropicClient.ts bounds its callers by `timeout x (maxRetries + 1)` against the sync cadence.
Regression test: a non-responding local server makes `runFullSync()` reject within the bound and
`isSyncActive()` returns false afterwards.

**Dissent (1 of 3 refuters).** REFUTED AS A DUPLICATE OF THE RECORD, not as a false claim. The code fact is real and I confirmed it
independently; the finding is nonetheless a verbatim restatement of an item the current plan already
carries as verified and already schedules as the very next piece of work.  WHAT I CONFIRMED (the m

---

## 49. [MEDIUM] GET /api/ai/context ships a 30,560-character financial context to a preview panel that does not exist; nothing in the app shows the owner what leaves

`boundary` | 2/3 kept | finder confidence: verified | found by: boundary-egress

**Evidence.** server/src/routes/ai.ts:75, "GET /api/ai/context - return the financial context snapshot (for the
UI preview panel)". The response carries `context` (the full `buildFinancialContext()` output plus
an Advisor Workflow Actions block, aiContext.ts:207-218) and `tools`. There are exactly two client
consumers: client/src/views/settings/Settings.tsx:840 reads only `.configured` and
`.credential_source`; client/src/components/AskPanel.tsx:182 reads only `.actions` and
`.configured`. A grep of client/src finds no read of `.context` or `.tools` anywhere. Measured size
of the discarded field against a copy of live.db: 30,560 chars, 596 lines.

**Failure scenario.** There is no surface in Mizān that shows the owner the 11 account names and balances, 248 merchant
patterns (a map of everywhere they shop), 40 recent transactions, goals, holdings and free-text
profile that go to whichever AI provider is selected. The route comment asserts that surface exists,
so anyone auditing disclosure, including a future maintainer reading this file to answer 'what do
we send?', stops at that sentence. That is rule 2 (a claim the code did not check) and it is what
gives the unattended-shipment finding above its teeth: the owner cannot see what left even if they
think to look. Secondarily, the entire context is rebuilt server-side (sync health, 3-month
cashflow, 12-month spending report, 60-day forecast, budget projection, the whole snapshot series,
248 rules, 40 transactions) and serialized to the browser on every mount of the ['ai-context']
query, then thrown away. It is at least pure: running buildFinancialContext against a DB copy left
the file byte-identical (md5 unchanged), so the localGuard GET exemption is not violated here.

**Proves it real.** `grep -rn 'aiContext\.\|context?\.' client/src`, every hit is `.configured`, `.credential_source`
or `.actions`. Neither `.context` nor `.tools` is read anywhere in client/src.

**Proves it fixed.** Either render the context in Settings behind a disclosure row (the codebase's own doctrine that a
payload with no consumer is a dropped capability, not dead weight), or drop `context` and `tools`
from the response and delete the claim from the route comment. A test asserting the response shape
matches what a consumer actually reads would hold it.

**Dissent (1 of 3 refuters).** The finding's facts check out; its consequence does not.  VERIFIED FACTS (I re-derived all of them):
- server/src/routes/ai.ts:76 does carry "(for the UI preview panel)", and :79-88 returns the full
snapshot. - aiContext.ts:212-218 composes `context` = buildFinancialContext() + Advisor Workflow
Acti

---

## 50. [MEDIUM] Backup copy enumerates what the export contains and omits the entire advisor chat transcript, AI memory and AI audit tables, under a sentence that reads as the complete privacy caveat

`boundary / user-facing copy` | 3/3 kept | finder confidence: verified | found by: boundary-retention

**Evidence.** `client/src/views/settings/DataSection.tsx:543`: "Download or restore accounts, transactions,
categories, budgets, goals, investments, snapshots, and sync history. Provider credentials are not
included."  The file it produces (`server/src/routes/settings.ts:118-128`, `GET /backup-json`, a
plaintext JSON attachment named `mizan-backup-YYYY-MM-DD.json`) is built from `LOCAL_BACKUP_TABLES`
verbatim, which also carries `advisor_actions` (:58), `advisor_drafts` (:59), `ai_feedback` (:63),
`ai_memory` (:64), `ai_runs` (:68), `ai_incidents` (:70), `conversations` (:73) and `messages`
(:74). `messages.content` is the full text of every chat turn in both directions.  This is a rule-2
case rather than a defect in the backup set: the table list is correct and well argued, and the
closure test guards it. It is the sentence describing the file that does not match the file. Nothing
in the plan files records this omission, so it is not known-and-accepted.

**Failure scenario.** Owner exports a backup before reinstalling and drops it in iCloud / a shared drive / an email to
themselves, having read a manifest that names only financial tables plus a reassurance that
credentials are excluded. The file contains every question they ever asked the advisor, every
answer, every AI memory statement they recorded (`AdvisorMemorySection.tsx` invites free-text
personal statements: 'A statement is recorded exactly as you write it'), and every draft the model
ever proposed including dismissed ones. Live today that is 8 conversations / 30 messages / 310
advisor_drafts / 204 advisor_actions; `ai_memory` is 0 rows so that part is latent.

**Proves it real.** Hit `GET /api/settings/backup-json` and grep the downloaded JSON for `"messages"` and
`"conversations"`; both arrays are populated. Read `DataSection.tsx:543` beside it.

**Proves it fixed.** The sentence names the AI tables, or names a category that covers them ("...and your advisor
conversations, memory and action history"). Better, since three copies of a table list is exactly
the failure mode this repo keeps hitting: derive the sentence from `LOCAL_BACKUP_TABLES` groups
rather than typing it, so a table added to the backup cannot leave the copy behind. Fixed when a
test asserts every group in the backup set is named by the copy.

---

## 51. [MEDIUM] `.mizan/logs/server.log` is an unrotated 6.8 MB plaintext file holding three months of request URLs including the ledger's search terms verbatim, and no reset or export path touches it

`logging / retention` | 2/3 kept | finder confidence: verified | found by: boundary-retention

**Evidence.** `server/src/index.ts:93-95`: `createWriteStream(..., { flags: 'a' })` with `morgan('combined')`. No
size cap, no rotation, no reaper anywhere in the repo (`grep -rn 'rotat\|maxSize\|logrotate'
server/src` -> zero hits on logging). Live file: 6,770,252 bytes, first line `[01/Jun/2026:21:05:15
+0000]`, last `[31/Aug/2026:23:38:46 +0000]`.  `combined` logs the full request line, so `GET
/api/transactions?...&search=<term>` persists the Ledger search box verbatim. Live file holds ~25
distinct `search=` values, e.g. `search=city+of+cambridge`, plus short queries that read as a
medical specialty and as named individuals or businesses, enough to reconstruct what the owner was
looking into and when, at minute resolution, for three months.  What the log does NOT hold is worth
stating: I grepped for `access_url`, SimpleFIN setup/claim tokens, `sk-ant`/`sk-proj`, `Bearer ` and
`api_key` and found none. Credentials travel in POST bodies, which morgan does not log, and `PUT
/api/ai/providers/:provider/key` puts the key in the body. That part is clean.  It also survives
everything: `DELETE /api/settings/data` (`server/src/routes/settings.ts:294-315`) iterates
`LOCAL_RESTORE_TABLES` and runs `DELETE FROM "<table>"` only, it touches no file on disk. The
Danger Zone copy at `client/src/views/settings/DataSection.tsx:733` reads "Permanently delete
accounts, transactions, budgets, goals, rules, snapshots, and sync history"; the modal at :755-758
does say "from the database", which is the honest half. And the log is evidence it outlives schema
decisions: it still contains 24 `POST /api/plaid/link-token` and 5 `POST /api/plaid/exchange-token`
lines from a provider migration 014 removed.  Separately, and relevant to the brief's first
question: nothing but morgan is ever written to this file, so despite the name it contains no server
events. Every AI-path `console.*`, `aiJobs.ts:470,472,649,661,694,704,709,732,762,772` (guard
refusals, out-of-scope refusals, invariant breaches, pass failures) and `routes/ai.ts:665` (per-chat
provider/model/cache/token accounting), goes to stdout via `morgan('dev')`'s sink and is lost when
the terminal closes.

**Failure scenario.** Owner runs Clear All Data before handing the machine on, or hands over a copy of the project
directory (the data lives in the repo dir, not the home dir, per `MIZAN_DIR` in
`server/src/db/index.ts`). The database is empty; `.mizan/logs/server.log` still names every
merchant they searched for, every account page they opened, and the exact minute of each, going back
to the first boot. Nothing in the app ever shows them the file exists or offers to clear it.

**Proves it real.** `ls -l .mizan/logs/server.log` (6.8 MB, one file, never rolled) and `grep -oE 'search=[^ &"]+'
.mizan/logs/server.log | sort -u`. Then confirm `server/src/routes/settings.ts:294-315` contains no
filesystem call.

**Proves it fixed.** Smallest honest addition, in order of value: (a) redact or drop the query string for the routes that
carry free text, so the access log keeps method/path/status without the search terms; (b) bound the
file, a size-capped rotation with a small retained count, so it stops being an unbounded
transcript; (c) have the factory reset truncate it, or say in the Danger Zone copy that it does not.
Fixed when a request with `?search=<term>` produces a log line that does not contain the term, and
when the file has a ceiling a test or a startup assertion can state.

**Dissent (1 of 3 refuters).** Every factual claim verifies, but the finding's framing as a medium-severity defect does not
survive.  VERIFIED TRUE: /Users/mahdi/code/mizan/.mizan/logs/server.log is 6,805,689 bytes, 31,729
lines, one unrotated file spanning [01/Jun/2026:21:05:15] to [01/Sep/2026:02:01:09].
server/src/index.ts:93-

---

## 52. [MEDIUM] advisorPrompts.ts: 14 of 16 prompt builders and 9 of 11 declared prompt sources have no production caller -- the contextual "ask the advisor about this" capability was dropped in the 12-to-6 consolidation and nobody walked its builders

`client / ai` | 2/3 kept | finder confidence: verified | found by: dead-code

**Evidence.** client/src/lib/advisorPrompts.ts is 824 lines. Only buildSyncRunAdvisorPrompt (called at
client/src/components/SyncActivityPanel.tsx:112) and buildImportRunAdvisorPrompt
(client/src/views/settings/DataSection.tsx:708) have production callers. The other 14 --
buildReportAdvisorPrompt:185, buildReportDrilldownAdvisorPrompt:291,
buildReportEvidenceAdvisorPrompt:321, buildNetWorthEvidenceAdvisorPrompt:358,
buildDashboardCardAdvisorPrompt:403, buildRecurringForecastAdvisorPrompt:434,
buildRecurringOccurrenceAdvisorPrompt:483, buildBudgetAdvisorPrompt:529,
buildRolloverLedgerAdvisorPrompt:562, buildGoalAdvisorPrompt:588, buildTransactionAdvisorPrompt:633,
buildAccountAdvisorPrompt:670, buildHoldingAdvisorPrompt:711,
buildInvestmentAllocationAdvisorPrompt:765 -- are reached only from tests/advisorPrompts.test.ts and
tests/creditReadingScreens.test.ts. askAdvisor() (client/src/lib/askAdvisor.ts:56) has exactly 2
call sites app-wide. AdvisorPromptSource (askAdvisor.ts:14-25) declares 11 sources; only 'sync' and
'import' are reachable, so 'dashboard', 'reports', 'budget', 'goal', 'transaction', 'account',
'investment', 'recurring', 'review' are dead enum members. Also dead in the same file:
ReportAdvisorTab, ReportAdvisorPromptContext, DashboardAdvisorCardKind,
DashboardCardAdvisorPromptContext, RecurringForecastAdvisorPromptContext,
InvestmentAllocationAdvisorPromptContext.

**Failure scenario.** This is the exact pattern CLAUDE.md names: "A fetcher with no caller is a capability that was
dropped, not dead code... Consolidating twelve screens into six left seven fetchers with zero
callers... If you retire a view, walk its fetchers." A reader (human or model) sees a 824-line file
of carefully written per-record prompts plus a passing test file and concludes the app offers "ask
about this budget / this goal / this holding" everywhere. It offers it on exactly two surfaces. The
green test suite is what makes the fiction durable.

**Proves it real.** grep -rn 'askAdvisor(' client/src --include='*.tsx' --include='*.ts' | grep -v lib/askAdvisor.ts
returns exactly 2 lines. Per-builder: grep -rn '<name>' client/src | grep -v lib/advisorPrompts.ts
returns 0 for all 14.

**Proves it fixed.** Two defensible outcomes, and the repo's doctrine ("Six were re-homed, one was deleted with an
argument") asks for a per-builder decision, not a blanket one. Either re-home each builder to a real
affordance (a per-row ask on the ledger, the budget rows in Plan, holdings in Investments), or
delete the 14 builders, the 6 dead context interfaces, the 9 unreachable AdvisorPromptSource members
and their test coverage -- roughly 700 of 824 lines. WHAT IS LOST BY DELETING: the drafted wording
for asking about a budget, goal, transaction, account, holding, allocation, recurring forecast,
rollover ledger and report drilldown. That is real design work, not boilerplate; it is the only
reason this is a re-home-or-argue decision rather than a plain delete. Gate either way: npm test
plus the three typechecks.

**Dissent (1 of 3 refuters).** The arithmetic is right and everything else about the finding is wrong.  VERIFIED AS STATED. `grep
-rn 'askAdvisor(' client/src | grep -v lib/askAdvisor.ts` returns exactly 2 lines
(SyncActivityPanel.tsx:112, DataSection.tsx:708). I ran a per-builder count across all 16 exports:
14 return client=0,

---

## 53. [MEDIUM] bucketsOf subtracts in dollars, so a fully accounted sheet renders a phantom "Other $0" row on Balance

`client` | 3/3 kept | finder confidence: verified | found by: visual-argument

**Evidence.** client/src/views/instrumentReadings.ts:123-133 `bucketsOf` computes `other: Math.max(0,
s.total_assets - (liquid + equity + crypto))` on API dollars. server/src/routes/networth.ts:12-19
dollarizes total_assets, liquid_assets, investment_assets and crypto_assets independently via
toDollars (cents/100), so the client receives four separately divided floats.
client/src/views/Instrument.tsx:545-552 filters `assetRows` on `row.amount !== 0`; :708-709 renders
each through BarRow (Instrument.tsx:177-213), which prints formatWholeCurrency(amount). Replayed
over all 41 live net_worth_snapshots: the integer-cent residual total_assets -
(liquid+investment+crypto) is exactly 0 on all 41 rows, but the float dollar subtraction returns
1.8189894035458565e-12 on 3 of them (2026-07-01, 2026-08-01, 2026-08-10). This module's own
docstring at instrumentReadings.ts:136-139 states "every figure this section prints is settled in
cents and divided once on the way out", and CLAUDE.md records the identical float-dust class as the
fixed Reports.tsx payoff bug ("Settle in cents, format once").

**Failure scenario.** A balance sheet whose three named buckets exactly account for total assets (the healthy case) yields
other = 1.82e-12 instead of 0. That survives the `!== 0` filter, so "Where it sits" gains a fourth
row reading "Other" with a zero-width SignedBar and "$0". The screen asserts there is $0 of other
assets where the code established there are none, and it is not silent on an ordinary healthy sheet.
Snapshot 2026-08-10 was the newest recorded sheet from 2026-08-10 through 2026-08-22 (next sheet
2026-08-23), so the live Balance screen rendered that row on all 13 of those days; 2026-08-01 was
newest for 4 days and 2026-07-01 for 2.

**Proves it real.** Call bucketsOf directly with the dollarized values of the 2026-08-01, 2026-08-10 or 2026-07-01
snapshot and assert other > 0 while the cent residual is 0. Equivalently, render Instrument against
a fixture snapshot where liquid + investment + crypto equals total_assets in cents and count the
rows in "Where it sits": four instead of three.

**Proves it fixed.** Compute the residual with the module's own `cents()` helper (instrumentReadings.ts:141) and divide
once, so bucketsOf returns exactly 0 whenever the cent residual is 0. Per repo rule 1 and rule 3,
add a regression test that builds a healthy sheet from migratedTestDb where the three buckets sum
exactly to total_assets and asserts "Where it sits" renders three rows with no Other, alongside the
existing detection case where a real Other balance exists.

---

## 54. [MEDIUM] Three current-tense beam-width claims quote a NavRail that HEAD does not have, guarded by a test that cannot fail

`client` | 3/3 kept | finder confidence: verified | found by: visual-argument

**Evidence.** client/src/components/NavRail.tsx:129 sets the rail to `w-[var(--mz-rail-w)]` with no responsive
variant; client/src/index.css:74 declares `--mz-rail-w: 164px` once, with no media or data-theme
override. client/src/views/Instrument.tsx:657-660 states "beside NavRail's w-14 / xl:w-[148px] ...
1024 - 56 - 72 = 896px of beam at 1024, 1280 - 148 - 96 = 1036px at 1280, 1440 - 148 - 96 = 1196px
at 1440". client/src/components/balance/BalanceScale.tsx:43-44 and CLAUDE.md's "Charts and the
balance beam" both state "181px of the 1196px beam a 1440px window gives it". Screen.tsx:22 is `px-6
... lg:px-9 xl:px-12`. git log -S shows commit e008514 replaced `w-14 ... xl:w-[148px]` with the
164px token; the Instrument comment was written earlier at 9302305 and the test line at 92a5272, and
neither was updated. tests/accountBalanceView.test.ts:190-193 asserts `1440 - 148 - 2 * 48 ===
1196`, `Math.min(1240, 1024 - 56 - 2 * 36) === 896` and the 181 derived from 1196: literal
arithmetic that reads nothing from NavRail or index.css.

**Failure scenario.** At HEAD the beam actually gets 1024 - 164 - 72 = 788px at a 1024px window, 1020px at 1280 and 1180px
at 1440. The 1024 figure, which is the narrowest and therefore most binding width the design
argument commits to supporting, is quoted as 896px and is 12 percent wide. The stated headline
resolution of the instrument ("181px of the 1196px beam") is really about 179px of 1180px. Changing
the rail width again moves nothing in the test, so the next drift is silent too.

**Proves it real.** Read NavRail.tsx:129 and index.css:74 together: there is no 56px or 148px rail anywhere in
client/src (grep for `w-14`, `w-[56px]`, `xl:w-` in NavRail.tsx and Layout.tsx returns nothing). Or
measure the rendered beam container at 1024, 1280 and 1440 in a browser and compare against 896 /
1036 / 1196.

**Proves it fixed.** Re-derive the three widths from 164px in Instrument.tsx and BalanceScale.tsx (and CLAUDE.md's copy),
and make tests/accountBalanceView.test.ts parse `--mz-rail-w` out of index.css and the padding steps
out of Screen.tsx rather than restating integer literals, so changing the rail token fails the test
instead of passing it.

---

## 55. [MEDIUM] walkRolloverLedger derives a budget's first month from a UTC timestamp but compares it to a local month, so a budget created in the last hours of a local month loses that month from every later carryover figure

`money-boundary / budget carryover` | 3/3 kept | finder confidence: inferred | found by: time-dependence

**Evidence.** server/src/services/budgetProjection.ts:369 `const createdMonth = budget.created_at.slice(0, 7);`
and :370 `if (createdMonth > throughMonth) continue;` and :373 `monthRangeForLedger(createdMonth,
throughMonth, months)`, against :344-345 `const now = options.now ?? new Date(); const openMonth =
format(now, 'yyyy-MM');`, `openMonth` is LOCAL, `created_at` is UTC ISO (written at
server/src/routes/budgets.ts:163 `const now = new Date().toISOString();` and used for both the
INSERT at :181-183 and the advisor path in server/src/services/advisorDrafts.ts). The result feeds
`rolloverCarriedIntoMonth` -> `getMonthlyBudgetsWithProjection` :246-249 (`rolloverBalance` ->
`availableAmount` -> `projected_remaining`), which is what `computeSafeToSpend` :86-91 turns into
`allocated_budgets` and therefore `free` on the Plan claim sheet. Live budget is unaffected:
created_at 2026-07-09T22:50:37.383Z = 2026-07-09 18:50 local, same month either way.

**Failure scenario.** Owner creates a rollover budget on 2026-07-31 at 21:00 America/New_York. created_at is stored
'2026-08-01T01:00:00.000Z', so createdMonth = '2026-08'. July is never walked:
`range.firstComputedMonth` is August, so July's `budget_amount - actual_spend` never enters the
carryover and every subsequent month's `starting_rollover`/`ending_rollover` is short by that amount
permanently. On the live ledger's own numbers that quantity is the size of one month's budget net of
spend (the recorded 2026-07 row is starting 0, budget 50000, spend -120363, ending 170363 cents), so
the error class is thousands of cents, and it propagates into `rollover_balance`,
`projected_remaining`, `allocated_budgets` and the 'free to spend' figure the Plan sheet prints.

**Proves it real.** Insert a budget with `created_at = '2026-08-01T01:00:00.000Z'` (what production writes for a
2026-07-31 21:00 EDT creation) plus July spend in its category, run `computeBudgetRolloverLedger(db,
{ now: <2026-08-15 local> })` under TZ=America/New_York, and observe the returned entries start at
2026-08 with July's contribution missing from `starting_rollover`. Note that no existing test can
see this: every rollover fixture writes a bare date string for created_at
(tests/budgetProjection.test.ts:24-25, :111, :144, :348, :608), a shape production never produces.

**Proves it fixed.** `createdMonth` derived as `format(new Date(budget.created_at), 'yyyy-MM')` (or a stored local
`created_month`), so the UTC instant is converted to the same local calendar the rest of the walk
uses. Regression test with a UTC-ISO created_at whose UTC month and local month differ, asserting
the walk begins in the local creation month, run under a fixed TZ.

---

## 56. [MEDIUM] withRetry re-runs syncCoinbase after it has already written the account balance, so a retried sync silently reports no Coinbase movement

`sync` | 2/3 kept | finder confidence: inferred | found by: lifecycle-concurrency

**Evidence.** server/src/services/syncManager.ts:635 wraps the whole of syncCoinbase in withRetry.
server/src/services/retry.ts:18-27 retries when the error's status is >= 500 or undefined.
server/src/services/coinbase.ts:388 throws CoinbaseApiError carrying that status (class at
coinbase.ts:47-52) and coinbase.ts:390 rethrows the raw axios error, whose status is undefined, when
there was no response. Inside syncCoinbase: coinbase.ts:443-445 reads current_balance into
existingAcct before any await, coinbase.ts:534 writes the newly computed balance, and only then does
coinbase.ts:542 await syncTradeHistory. coinbase.ts:522-533 uses existingAcct.current_balance as
previousBalance and balancesDiffer (server/src/services/balanceChanges.ts:38-40) to decide whether
to report anything at all. The contrast is in the same sync: syncSimplefin
(server/src/services/simplefin.ts:883-909) is fetch-then-apply with a single await, so its retry re-
fetches with no partial write behind it.

**Failure scenario.** Attempt 1 finishes the account paging loop, writes accounts.current_balance at coinbase.ts:534, then
Coinbase answers 5xx or drops the connection inside syncTradeHistory. withRetry sleeps and calls
syncCoinbase() again from the top. Attempt 2 reads current_balance as attempt 1 left it, so
previousCents equals totalCents, balancesDiffer is false, and no AccountBalanceChange is pushed: the
sync panel reports no Coinbase movement for a pass in which Coinbase moved. If spot prices drift
between attempts the movement instead surfaces as a small residual delta whose stated "previous"
balance is a value the account held for one second, not the pre-sync balance. zeroedCount is also 0
on the second attempt because attempt 1 already zeroed, so the run item's transactions_modified at
syncManager.ts:643 under-reports the stale coins.

**Proves it real.** Against a fixture whose stored Coinbase balance differs from the provider's, stub syncTradeHistory
to throw a 503 on its first call and let withRetry take the second pass. Assert that the returned
balanceChanges array is empty and staleAccountCount is 0, while the account's balance did in fact
change.

**Proves it fixed.** Either capture previousCents once outside the retried function and carry it across attempts, or move
the balance write after the last network call so syncCoinbase takes syncSimplefin's fetch-then-apply
shape. A regression test must assert the balance change is still reported after exactly one retry.
tests/retry.test.ts exercises withRetry in isolation and pins nothing about the idempotency of what
it wraps.

**Dissent (1 of 3 refuters).** MECHANISM: partly real, and I confirmed the cited lines at HEAD. coinbase.ts:444 reads
existingAcct.current_balance before any await; :522 uses it as previousCents; :534 writes the new
total; :542 then awaits syncTradeHistory, which is NOT in a try/catch (unlike syncCoinbaseLedger at
:545-550, which

---

## 57. [MEDIUM] detectRecurring's fuzzy grouping is O(rows x groups) with a full bigram comparison per pair and no early exit, and it runs on every hourly sync

`sync` | 3/3 kept | finder confidence: inferred | found by: perf-size

**Evidence.** server/src/services/recurring.ts:330-345: for every transaction in the 13-month window the loop
scans the entire accumulated `groupNames` array calling `compareTwoStrings(normalized, gName)`, and
never stops once it has a match above the 0.85 threshold. Both operands grow with ledger size, so
the pass is roughly quadratic in transactions.  Measured on live.db, as a standalone re-
implementation of the same loop driven by the real merchant names and this repo's own
node_modules/string-similarity (I did not import the service, to keep the DB copy read-only): the
window is 1,243 rows collapsing to 524 groups, about 326,000 `compareTwoStrings` calls, 975 ms.
Treat 975 ms as same-order rather than exact: my replica of `normalizeMerchant`
(recurring.ts:90-107) approximates the real suffix/state-code stripping, so the group count and
therefore the pair count shift slightly.  This is called on every sync at syncManager.ts:409-411,
i.e. hourly by default, and it is the largest local stage: median full sync is 5.4s and the local
stages together were 2.5s in the 7,580s run, so about a second of that is this loop, on the single
Node thread that also serves the API and the SSE.

**Failure scenario.** Today the owner loses roughly one second of event loop per hour, which is tolerable. The consequence
is the growth curve: at four times the current ledger the same loop is about sixteen times the work,
so around sixteen seconds of fully synchronous blocking every hour, during which every API request
and the sync SSE itself are stalled. Because the sync is fire-and-forget from the scheduler, nothing
on screen would attribute the stall to it.

**Proves it real.** Run the loop in-process against a copy of the DB with a timer around recurring.ts:330-345 and
confirm the order of magnitude, then re-run against a synthetically tripled ledger and confirm the
near-quadratic scaling.

**Proves it fixed.** Either exit the scan on the first match above 0.85 (a minor semantic change: the loop currently
takes the best match, not the first qualifying one, so the fix should be argued rather than assumed
equivalent) or prefilter candidate groups by a cheap blocking key (first token, length band) before
any bigram comparison. Proof: a test that asserts the grouping output is unchanged on the real
merchant-name corpus, plus a bound on the number of comparisons for a fixture of known size so a
future change cannot silently reintroduce the full scan.

---

## 58. [LOW] ProgressBar's negative-category comment states a figure no re-derivation reproduces, in either the record's value or the live one

`client` | 2/3 kept | finder confidence: verified | found by: drift-part1

**Evidence.** client/src/components/balance/ProgressBar.tsx:105, :108 and :148 all state "July 2026 Shopping is
-$1,203.63" with no re-derivation date and no query beside it. rebuild.md's own annotation section
already corrected that to -$1,028.63 on 2026-07-31 at migration 054 and flagged the Amazon component
as unreconstructable. Running getSpendingReport(db, {startDate:'2026-07-01', endDate:'2026-07-31',
parentOnly:true}) against the copied live DB at migration 056 returns cat_shop amount -89241 cents,
that is -$892.41. Three values, none of which the comment's number is. Contrast
TrendChart.tsx:34-40, which states the same class of figure with its date, its migration and its
query, and is therefore compliant.

**Failure scenario.** A future reader treats -$1,203.63 as a still-live measurement of the hazard SignedBar exists for,
tries to reproduce it to check whether the diverging bar is still needed, cannot, and either deletes
the component as unnecessary or writes a fourth number in beside it. This is the rule-2 pattern the
repo names explicitly: a figure in a comment with no query beside it and no date on it.

**Proves it real.** npx tsx -e running getSpendingReport over the copied live DB for 2026-07, which returns -89241 cents
for cat_shop, against the literal -$1,203.63 at ProgressBar.tsx:105.

**Proves it fixed.** The comment either carries the query, the date and the migration the way TrendChart.tsx:34-40 does,
or drops the figure and keeps only the structural claim that a category total can be negative, which
is what the component actually depends on.

**Dissent (1 of 3 refuters).** Every factual claim in the finding checks out, and it still does not stand as a reportable defect.
VERIFIED FACTS. ProgressBar.tsx:105, :108, :148 do carry "-$1,203.63" with no date and no query; git
blame puts all three in b01baf8 (2026-07-31 13:54), five hours before the re-derivation commit 8bfe

---

## 59. [LOW] Record-hygiene items Phases 12 and 15 committed to: no palette emitter, no `--mz-info` alias, index.css census still stale, ui-overhaul.md tracked but not trimmed

`docs` | 2/3 kept | finder confidence: verified | found by: drift-part3

**Evidence.** (a) Gate 0, .claude/plans/rebuild-part-3.md:374-383, called `scripts/palette-figures.mjs` "the
highest-value gate in the plan". `ls scripts/` shows only `backfill/` and `cleanup/`; `find . -name
'palette-figures*'` returns nothing, and the triplets and the prose landed together in one hand-
written commit (4a2db38) rather than the two the gate specified. Mitigating, and it should be said:
tests/contrastClaims.test.ts (857 lines, new in the same commit) recomputes contrast figures from
the declarations, and I spot-checked it -- Modal.tsx's "`line-3` on `card-alt` is 4.74:1 light"
recomputes to 4.745 and "`bg-ink/25` composites to rgb(191 191 191) on light" is exact. (b) Gate 2,
rebuild-part-3.md:402, "add the missing composed `--mz-info` alias": `grep -c -- '--mz-info:'
client/src/index.css` is still 0 against three `--mz-info-c` declarations at :338, :575, :654. (c)
rebuild-part-3.md:362-372 said to correct index.css's census; index.css:82-84 still reads "the ~32
raw `var(--mz-x)` references ... (TrendChart, BalanceScale, CategoryPicker, Today, Reports)" when
the real count is 40 across 13 files and neither Today.tsx nor Reports.tsx exists -- index.css:200
says so itself sixty lines further down. (d) Decision 4, rebuild-part-3.md:637, said ui-overhaul.md
is "trimmed to a stub and folded"; `git ls-files` shows it tracked (the tracking half landed) but it
is still 276 lines carrying its full 2026-07-27 diagnosis, including "16 call sites are silently
dead" and `bg-line/70` in SkeletonLoader, which is `bg-track/60` at HEAD.

**Failure scenario.** Each item is a claim or an absence that misleads the next reader rather than a wrong figure on
screen. (c) is the sharpest: index.css's own header points a maintainer at Today.tsx and Reports.tsx
for raw `var(--mz-*)` references, two files that no longer exist, and gives a count 20 percent below
the real one, so anyone auditing the raw-reference surface from the header alone checks the wrong
files and stops eight references short. (d) matters because tracking ui-overhaul.md without trimming
it put a stale 2026-07-27 diagnosis into git as if it were current: it names class strings (`bg-
line/70`) that no longer appear anywhere in client/src and asserts 16 dead call sites on a config
that was fixed three phases ago. (b) is latent only -- I confirmed every `var(--mz-*)` reference
under client/src resolves to a declared alias, so nothing renders wrong today, but the file's own
stated duality invariant (index.css:100) is false for exactly one token and nothing checks it. (a)
leaves the non-contrast figures -- the OKLCh chroma and L* claims, the rung table in Card.tsx --
maintained by hand, which is the mechanism that produced the stale `tan 0.041` claim the plan exists
to prevent.

**Proves it real.** Each is a single grep or ls listed above. On (b) I checked the consequence: every `var(--mz-*)`
reference under client/src resolves to a declared alias, so the missing `--mz-info` is latent, not a
live rendering fault.

**Proves it fixed.** (a) either the emitter, or a note that contrastClaims.test.ts is the accepted substitute for the
contrast half and that the OKLCh and L* claims are covered by nothing; (b) one line in the base
block; (c) re-run the two greps and paste the counts; (d) trim ui-overhaul.md to the `/alpha`
diagnosis plus a pointer, as Decision 4 specified, now that it is in git and its staleness is part
of the record. Note that Phase 15's CLAUDE.md item is NOT in this list: relink-and-close.md:539
settles it explicitly ("CLAUDE.md stays gitignored. The owner's position is that it should never be
committed"), which is the recorded-reason branch the plan allowed.

**Dissent (1 of 3 refuters).** REFUTED as record-restatement (noise), with one factually false supporting claim inside it.  (b)
`--mz-info` has no composed alias: recorded verbatim at .claude/plans/rebuild-part-3.md:282-284,
including the identical mitigation the finder repeats ("nothing catches it because nothing
references `var

---

## 60. [LOW] CLAUDE.md's opening claim that the migration-numbering hook is absent from a fresh clone is false

`docs` | 3/3 kept | finder confidence: verified | found by: drift-claudemd

**Evidence.** CLAUDE.md:13-16 states "`.claude/hooks/migration-guard.sh` is neither ignored nor added, so it is
also absent from a fresh clone: the migration-numbering guard described below does not exist on a
machine that has only cloned this repo." `git ls-files --error-unmatch .claude/hooks/migration-
guard.sh` succeeds, and `git log --oneline -1 -- .claude/hooks/migration-guard.sh` returns dbb2c2c
"Put the migration-numbering guard in the repo instead of on one machine". .gitignore lines 1-15
carry no entry matching it. The same paragraph's other claim is still true: .gitignore line 8 is
`CLAUDE.md`.

**Failure scenario.** A contributor reading the file's own preamble concludes the PreToolUse:Write guard does not ship,
and either re-provisions a second copy or writes a migration on the assumption nothing will catch a
prefix collision. The sentence is also the file's headline example of unversioned guidance decaying,
and it is itself the decayed claim.

**Proves it real.** The `git ls-files --error-unmatch` call above exits 0.

**Proves it fixed.** The sentence names the hook as tracked since dbb2c2c, and the fresh-clone caveat is scoped to
CLAUDE.md itself, which genuinely is gitignored.

---

## 61. [LOW] chartColors.ts names two measurement grounds the palette no longer has, and its one test is built to skip comments

`client` | 3/3 kept | finder confidence: verified | found by: drift-uioverhaul

**Evidence.** client/src/lib/chartColors.ts:15-17: "the slots were searched under the dataviz six checks against
both grounds (paper #e5dbca light, #262119 dark), and re-ordering them invalidates that." Neither
ground exists: client/src/index.css:282 is `--mz-paper-c: 255 255 255` and :532/:611 are `0 0 0`.
The identical sentence in index.css WAS corrected - client/src/index.css:367-373 reads "The
provenance sentence above used to name the grounds as paper #e5dbca light and #262119 dark, which
were the previous palette's ... seriesPalette.test.ts derives both grounds live rather than reading
them from this comment, which is exactly why it kept passing while the comment rotted." The twin
sentence in chartColors.ts was missed. tests/seriesPalette.test.ts:157-159 then exempts it by
construction: "Comments are allowed to quote the ground colours the measurements were taken against,
so only code lines are checked", filtering comment lines before the hex assertion. `grep -rn
'e5dbca|262119' client/src server/src tests shared` returns exactly two hits: the index.css line
that names them as retired, and this one that still asserts them.

**Failure scenario.** A future change to the series ramp reads chartColors.ts:16 as the authority on what the ramp was
measured against, re-derives contrast on #e5dbca / #262119, and concludes the ramp is safe on
grounds the app stopped using on 2026-08-01. Nothing catches it: the only test that reads this file
deliberately does not look at its comments, and the file's own claim that reordering invalidates the
search is stated against grounds that no longer exist. Rule 2, in the file whose header exists to
explain why literal colours were removed.

**Proves it real.** The grep above: two occurrences of the retired hexes, one labelled historical and one still asserted
as current.

**Proves it fixed.** chartColors.ts:16 either names the current grounds (white / black) or points at
tests/seriesPalette.test.ts as the live derivation, matching what index.css:367-373 already did.
Optionally, the comment exemption at tests/seriesPalette.test.ts:158-159 is narrowed so a retired
token value in a comment fails.

---

## 62. [LOW] AccountDetail prints raw float holding quantities, up to 18 characters

`client` | 3/3 kept | finder confidence: verified | found by: drift-uioverhaul

**Evidence.** client/src/views/accounts/AccountDetail.tsx:196: `<div className="text-note text-
muted-2">{h.quantity} units</div>`, with no formatter, sitting directly beside
`formatWholeCurrency(h.institution_value)` at :198. server/src/routes/investments.ts:18 correctly
excludes `quantity` from the money fields (it is a share count, not money), so nothing else formats
it either. Live DB: `SELECT length(CAST(quantity AS TEXT)) L, COUNT(*) FROM holdings GROUP BY L` ->
4 chars x4, 5 x5, 8 x1, 10 x2, 14 x1, 18 x1, across 14 holdings.

**Failure scenario.** Owner opens the crypto or fractional-share account detail and the Holdings row reads an
18-significant-digit float followed by the word "units", set at 12.5px in `muted-2`, next to a
currency figure rounded to the dollar. Four of the owner's fourteen holdings render at 10 characters
or more. This is ui-overhaul.md bug 20 verbatim ("AccountDetail.tsx:106 renders {h.quantity} units
raw"), never closed, only moved to line 196. It does not make a total wrong, but it is a number the
screen presents at full binary precision while every other figure on the same row is deliberately
rounded, so the page reads as if it lost a formatter.

**Proves it real.** Open /accounts/:id for an investment or crypto account and read the Holdings block; or the grouped-
length query above.

**Proves it fixed.** Quantity goes through a share-count formatter with a stated precision rule (per-unit prices stay
REAL by design, so the rule belongs in one place beside them), and a test asserts an 18-digit
quantity renders at that precision.

---

## 63. [LOW] The AI's get_transaction_full tool serves provider_amount in cents beside amount in dollars, under a label saying "Dollars"

`ai` | 3/3 kept | finder confidence: verified | found by: money-boundary

**Evidence.** server/src/services/advisorChatTools.ts:636 returns `transaction: dollarizeFields(row, ['amount'])`
where `row` comes from `getTransactionById` (server/src/services/transactions.ts:149-166), which
selects `t.*` plus `PROVIDER_AMOUNT_SQL` (transactions.ts:120-130) - integer cents, per its own
comment at transactions.ts:112-114. The adjacent `reading.amount` string (advisorChatTools.ts:639)
tells the model "Dollars." for the object. routes/transactions.ts:47 dollarizes both fields, and the
comment at routes/transactions.ts:40-45 states exactly why they must travel together: "A screen that
showed the corrected figure in dollars beside the provider's in cents would be off by a hundred on
exactly the comparison the field exists to make."

**Failure scenario.** The owner corrects a transaction amount from the provider's -$27.13 to -$25.00 (`amount_source =
'human'`, a `provider_rejected` revision filed). They ask Cmd+K about the row. The model receives
`amount: -25` and `provider_amount: -2713` and reports that the institution says the charge was
$2,713 rather than $27.13.

**Proves it real.** Read both call sites and the shared SQL. Latent on the live ledger: `transaction_field_revisions`
holds 0 rows and `amount_source` is NULL on 2589 rows and 'provider' on 134, with no 'human' rows,
so `PROVIDER_AMOUNT_SQL` currently evaluates to NULL everywhere and `dollarizeFields` passes NULL
through untouched. It becomes live the first time the owner overrides a SimpleFIN amount.

**Proves it fixed.** Change advisorChatTools.ts:636 to `dollarizeFields(row, ['amount', 'provider_amount'])`, matching
the route. Regression test: seed a transaction with `amount_source = 'human'` and a matching
`provider_rejected` revision, call `get_transaction_full`, and assert `transaction.provider_amount`
equals `toDollars` of the stored revision value - no current test exercises this tool with a
standing amount disagreement.

---

## 64. [LOW] Coinbase reports the number of holdings it zeroed in the transactions_modified column, so the panel and the AI digest read it as transactions updated

`sync` | 3/3 kept | finder confidence: verified | found by: sync-writepath

**Evidence.** server/src/services/syncManager.ts:643 sets `transactions_modified:
coinbaseResult.staleAccountCount`. That field is `zeroedCount` from
server/src/services/coinbase.ts:508-515 and :559, which counts holdings rows set to zero, not
transactions. It is rendered as "{item.transactions_modified} updated" at
client/src/components/SyncActivityPanel.tsx:227, summed into the run's changed-transaction total at
SyncActivityPanel.tsx:40, and fed to the model at client/src/lib/advisorPrompts.ts:172 and :280
("changed N transactions: ... N updated"). Live DB: all 177 Coinbase run items hold 0, so this has
never fired; `accounts_seen` on the same item is the hardcoded 1 from coinbase.ts:557.

**Failure scenario.** The owner sells out of two coins entirely. The next sync zeroes two holdings and writes
`transactions_modified = 2` on the Coinbase run item. The sync panel says "1 account, 0 added, 2
updated, 0 removed", and the Cmd+K digest tells the owner Coinbase changed two transactions. No
transaction was touched. The count is a figure about holdings presented under a label the code never
checked against the transactions table.

**Proves it real.** Seed a migrated fixture with a Coinbase account holding two coins, run the zeroing half of
`syncCoinbase`, and read the recorded run item. Blocked today for the same reason as the first
finding: `syncCoinbase` has no seam that can be driven without the network, and no test file
references it.

**Proves it fixed.** The zeroed-holdings count travels in a field that names it, or is emitted as a `sync_changes` row on
the Coinbase item describing the positions that closed, and `transactions_modified` carries only
transactions. A test asserts the panel string for a run that sold one coin and changed no
transaction.

---

## 65. [LOW] CLAUDE.md states a market-driven exemption rule that HEAD does not implement

`docs` | 3/3 kept | finder confidence: verified | found by: reconciliation-networth

**Evidence.** CLAUDE.md:211-213: "A market-driven account short-circuits out of `unreconciled` **unless**
direction_conflict is set: a price move can change the magnitude of a brokerage's residual, but it
cannot make the ledger's own external-flow direction disagree with the balance." At HEAD both halves
are false: server/src/services/reconciliation.ts:320-321 forces `direction_conflict: !isMarketDriven
&& ...`, so it is unconditionally false on a market-driven account, and :340 `if
(account.is_market_driven) return false;` is unconditional, with the comment at :336-339 explicitly
arguing "The exemption is unconditional". The change is recorded as deliberate in
.claude/plans/part-4-the-last-mile.md:124, so CLAUDE.md is the stale copy. It matters because
CLAUDE.md is gitignored and unversioned, so nothing else records this sentence and no review will
catch an edit to it.

**Failure scenario.** A future change trusts CLAUDE.md, re-derives the filter as `if (is_market_driven &&
!direction_conflict) return false`, and reintroduces the brokerage alarm reconciliation.ts:65-85
argues against: a $600 deposit during a down month gives observed -60000 against explained +60000,
which under the CLAUDE.md rule flags the brokerage on the most ordinary brokerage event there is.

**Proves it real.** Read CLAUDE.md:211-213 beside reconciliation.ts:320-321 and :340.
tests/reconciliation.test.ts:163-181 asserts the HEAD behaviour, so the suite and CLAUDE.md
disagree.

**Proves it fixed.** CLAUDE.md says the exemption is unconditional and gives the code's own reason (observed_delta on
such an account is transfers plus profit and loss, so no comparison against it separates a mis-
signed transfer from a down month; flowConservation.ts carries that case).

---

## 66. [LOW] Every security SimpleFIN introduces is stored as type 'equity', so the default Investments allocation lens mislabels ETFs, index funds and a money-market sweep

`investments / security metadata` | 2/3 kept | finder confidence: verified | found by: investments

**Evidence.** server/src/services/simplefin.ts:96-99 hardcodes `'equity'` in the INSERT's VALUES list and :136
runs it for every ticker the provider reports that is not already known; nothing anywhere else ever
writes 'etf', 'mutual_fund' or 'cash', though the securities CHECK allows all three. The consequence
surfaces at client/src/lib/investmentAnalytics.ts:336-338, whose group label is
`titleCase(security_type)`, driving the asset_type lens that Investments.tsx:261 selects by default.
client/src/lib/investmentAnalytics.ts:526 would additionally label that lens 'Classified by provider
type', a provenance claim the ingest does not honour (that function currently has no production
caller, so only the mislabel is live).

**Failure scenario.** The live ledger holds a total-world ETF, a total-market index mutual fund and a government money-
market sweep, all stored `type = 'equity'`. The Investments screen's default Asset lens therefore
renders two slices, Equity and Crypto, and reports roughly 84% Equity - folding a cash sweep and two
funds into the same asset class as individual stocks. The three unused classes the schema provides
are unreachable, so no amount of syncing will separate them.

**Proves it real.** `SELECT type, COUNT(*) FROM securities GROUP BY type` on the live copy returns equity 3 and crypto
8, and the three 'equity' rows are VT, FSKAX and SPAXX. Cross-check against simplefin.ts:98, where
the literal is in the SQL rather than derived from anything in the payload.

**Proves it fixed.** Either map the provider's own instrument description onto the CHECK's classes at ingest and record
where the classification came from (the way sector_source already does for sector), or leave the
type unclassified and have the asset lens say so. Test: a SimpleFIN payload describing a money-
market fund must not come back as 'equity', and the lens's quality label must not claim provider
classification for a value this repo chose.

**Dissent (1 of 3 refuters).** REFUTED on consequence, not on mechanism. The mechanism is real and I reproduced every structural
claim; the failure scenario is not.  VERIFIED TRUE: server/src/services/simplefin.ts:97-98 hardcodes
'equity' in the INSERT VALUES; server/src/services/investmentMetadata.ts:219-243
(setSecurityMetadata

---

## 67. [LOW] variance() comment claims a median-centered coefficient of variation; the code centers on the mean

`docs` | 3/3 kept | finder confidence: verified | found by: budget-recurring

**Evidence.** services/recurring.ts:280-289. The comment at line 282 reads "Coefficient of variation: std_dev /
mean, using median as center". The `med` parameter is used only for the `med === 0` early return at
line 281; both the deviation sum (line 285-286) and the divisor (line 288) use `mean`, computed at
line 283. Called at recurring.ts:394 for gapVariance and 395 for amountVariance; amountVariance is
stored on recurring_patterns.amount_variance and is the sole input to the amount_varies flag at
recurringForecast.ts:103.

**Failure scenario.** Not a wrong total, a wrong claim about how a published statistic is computed. A skewed amount
history (one large outlier) pulls the mean away from the median, so the stored amount_variance is
materially different from what the comment says was measured, and the AMOUNT_VARIANCE_MAX = 0.25
gate at recurring.ts:405 and the AMOUNT_VARIES_THRESHOLD = 0.25 at recurringForecast.ts:30 are being
calibrated against a statistic nobody reading the file believes they are calibrating. On the live DB
the active weekly payroll carries amount_variance 0.3615 and the active monthly pattern 0.2588, both
straddling that threshold, so which center is used decides whether the Bills row says the amount
varies.

**Proves it real.** Read the function: `med` appears once, in the guard. Or call variance([100, 100, 100, 700], 100): a
median-centered CV and a mean-centered CV differ, and the returned value matches the mean-centered
one.

**Proves it fixed.** Either center on `med` as the comment says, or correct the comment to "std_dev / mean; the median is
passed only as a zero guard", and re-check the two 0.25 thresholds against whichever definition
survives. Per rule 2 the comment and the code must state one rule; either resolution is fine,
silently leaving both is not.

---

## 68. [LOW] recentSignedAmounts's stated safety argument omits detection's cat_xfer filter, and four live rows already violate it

`sync` | 2/3 kept | finder confidence: verified | found by: budget-recurring

**Evidence.** services/recurring.ts:135-136: "Only `pending` is filtered: detection already applied
excludedFromTotalsSql before linking these rows, so a transfer or a confirmed duplicate never
carries a recurring_id to begin with." The query at recurring.ts:144-150 indeed filters only
`pending = 0`. But detection's pool at recurring.ts:312-320 applies a third predicate the comment
does not mention: `AND COALESCE(category_id, '') NOT LIKE 'cat_xfer%'`. Nothing clears recurring_id
when a row is later recategorized into a transfer category - detectRecurring only ever sets it
(recurring.ts:484-486), and grep confirms services/transactionIntegrity.ts never references
recurring_id at all. Live DB: 4 transactions carry both a recurring_id and a cat_xfer_out category.
(The transfer_status/duplicate_status half of the comment is currently true: 0 such rows. I did not
establish whether that is by construction or by luck, so I am not asserting it.)

**Failure scenario.** A pattern with at least 3 non-transfer occurrences also holds one or more rows since recategorized
to cat_xfer. Detection recomputes average_amount over the non-transfer subset
(recurring.ts:411-413); recentSignedAmounts medians over all six most recent linked rows including
the transfer ones. GET /api/recurring renders the stored column and GET /api/recurring/forecast
renders the recomputed one, so the Bills list and the forecast quote two different amounts for the
same bill - the exact $78 divergence the comment says was eliminated. Not currently on screen: the
one live pattern holding all four rows is is_active = 0 and so is filtered out of both the forecast
(recurringForecast.ts:147) and the budget projection (budgetProjection.ts:147).

**Proves it real.** `SELECT COUNT(*) FROM transactions WHERE recurring_id IS NOT NULL AND COALESCE(category_id,'') LIKE
'cat_xfer%'` returns 4 on the live database. Constructing the divergence: seed a pattern with 6
linked rows, recategorize the two most recent to cat_xfer_out, run detectRecurring, then compare
recurring_patterns.average_amount against recentSignedAmounts for that id.

**Proves it fixed.** Add the same `COALESCE(category_id,'') NOT LIKE 'cat_xfer%'` predicate to recentSignedAmounts (or,
better, have detection clear recurring_id on rows that have dropped out of its pool, which also
stops a dead pattern holding live rows hostage), and correct the comment to name all three of
detection's filters rather than one. Regression test: the stored average_amount and the recomputed
signed median agree for a pattern whose recent window contains a recategorized transfer, and still
agree - unchanged - for a pattern with no such row.

**Dissent (1 of 3 refuters).** REFUTED. The finding's mechanism is partly real but its headline evidence is misapplied and its
stated on-screen failure is structurally blocked at HEAD.  1. The four live rows do not violate the
comment. The comment (server/src/services/recurring.ts:135-136) says "detection already applied
excluded

---


# Refuted, recorded so they are not relitigated


62 findings were killed by 2 or more of 3 refuters. Titles only; the reasoning is in the run journal.

- **[high] All nine SimpleFIN backfill floors were raised out-of-band to 2026-07-31, stranding 384 provider rows below a line three in-repo records still describe as 2026-04-08 to 2026-06-22**
  REFUTED. Every raw observation reproduces, but the mechanism, the direction of harm, and the
severity are all wrong. The raised floor is the protection, not the defect.  1. No code path at
HEAD produc...

- **[high] The AI prompt asserts a cause for every market-driven residual that the code never establishes, and that the live ledger contradicts**
  REFUTED as framed. Three of the finding's load-bearing claims fail against HEAD; the only survivor
is a one-sentence wording nit.  1. "The function it reads from says the opposite reason" is a
misread...

- **[high] A manual account whose balance the owner edits is reported unreconciled forever, and the AI is told to treat that balance as uncertain**
  REFUTED as a defect. Every empirical claim in the finding reproduced; the classification does not
survive.  CONFIRMED FACTS (so the parent does not need to re-verify): I ran `reconcileAccounts`
agains...

- **[high] The 14 mis-signed Fidelity rows are unreachable by every sync path, so Phase 1's recorded correction can never be recorded**
  REFUTED. The finding's mechanism facts are true, but they do not add up to the defect claimed, and
its title is the opposite of what the code does.  What I verified as true (read directly): -
server/s...

- **[high] SimpleFIN's stale-holdings zeroing is unreachable from the sync, and the test that proves it works calls past the gate**
  REFUTED as filed (severity high, "verified", silent wrong numbers). The gate exists as described,
but the three claims that give the finding its severity do not survive reading the code.  1.
CONSEQUEN...

- **[high] A run in which every provider stage failed still writes a measured, fully-covered net-worth snapshot for the day**
  REFUTED. The mechanism (takeSnapshot runs regardless of a failed provider stage, writes
is_estimated=0 and covered=total) is real, but every consequential claim built on it is false at
HEAD.  1. The c...

- **[high] Undoing a merchant-rule CREATION is unimplemented on every owner-facing path, and all three surfaces assert a state the code never checked**
  REFUTED as stated. The headline is false in both halves, and the behavior is a documented
deliberate decision at HEAD, not an unimplemented path.  1. "Unimplemented on every owner-facing
path" is fals...

- **[high] Reconciliation reports a direct balance edit on a manual cash account as an unexplained ledger gap, permanently, and the owner has no move that clears it**
  REFUTED. Every instrument reading in the finding reproduces, but the defect characterization fails
on three independent legs.  WHAT REPRODUCES (so the finder's measurements are not in dispute).
Runnin...

- **[high] The orphan-fetcher sweep the record closed at seven is at 15 today, and its only regression test is a hand-maintained six-name list**
  REFUTED. The 15-orphan count reproduces exactly, but the finding's headline framing ("the sweep
the record closed at seven is at 15 today"), its severity, and its failure scenario all fail
empirically...

- **[high] An account with no ledger at all is put in `unreconciled` forever by `residual_ratio === null -> return true`, and it is standing in the live AI prompt right now**
  MECHANICS VERIFIED REAL; THE DEFECT CLAIM IS REFUTED.  Verified against the live copy: Wallet
(4183bb26..., type='cash', connection_type='manual', is_hidden=0) has 0 transactions; its
breakdown entry ...

- **[high] budget_rollover_ledger holds a frozen actual_spend the writer can no longer reach, and schemaDoc tells the model it is re-derived**
  REFUTED as a reportable finding. The arithmetic is right; the consequence claims are not, and the
structural core is already in the record.  WHAT I CONFIRMED (verified, live.db): -
budget_rollover_led...

- **[high] The stale-pending row advises removing rows the app refuses to remove, and nothing ever clears them**
  REFUTED on reachability and on the copy reading. Every mechanism claim in the finding checks out,
but the premise that makes them add up to a defect (a provider row stuck at `pending = 1`) cannot
be p...

- **[high] The background AI worker ships the whole ledger on an Anthropic credential the owner never gave Mizān**
  REFUTED as framed. I read every cited file plus the installed SDK.  1. The finding's own proof
recipe cannot produce the claimed harm. `hasAnthropicOAuthProfile()` (credentials.ts:50-57) scans
`<confi...

- **[high] background_review's `nothing_to_do` exit has fired 0 times in 68 runs: two of its six conditions are standing sets, and one is fed by the AI's own autonomous writes**
  Mechanism verified, framing refuted. The code is exactly as described (aiWorker.ts:447-503 and
:512-538 are unwindowed SELECTs; the gate at :597-609 is an OR over six legs; ai_runs has 0
skipped rows ...

- **[high] The record's own retention verdict (`part-4-the-last-mile.md:389`) holds for 1 of 3 outbound call sites: chat and bulk-categorization leave no run row at all, so "what left, when, to which model" is unanswerable for roughly half of all provider calls**
  REFUTED. The finder's measurements are accurate; the conclusion is not a defect at HEAD.  VERIFIED
THE FINDER'S FACTS. server.log: 28 POST /api/ai/chat (26x200, 2x400), 32 POST /api/ai/suggest-
categor...

- **[high] Reconciliation has no notion of a manual account, so a hand-typed balance becomes a permanent "the ledger does not fully explain" finding; the record calls it "genuinely unexplained"**
  REFUTED. The observable facts in the finding reproduce, but the defect claim built on them does
not survive reading the code and running the sequence.  What reproduces (I ran it, not read it): -
`reco...

- **[high] Neither financial provider call has an HTTP timeout, and the live ledger shows syncs held open for 30 to 63 minutes while the health panel keeps reading "current"**
  REFUTED. The finding is a true code fact welded to a false consequence story, and its "high"
severity rests entirely on the consequence.  The code fact stands, and I concede it: there is no
HTTP timeo...

- **[high] Backup restore and factory reset mutate every table with no isSyncActive() check, so a suspended sync resumes and writes over them**
  REFUTED. The mechanism is partly real but the finding misreads its own key evidence, its headline
harm is not caused by the race, and the live data actively rules out the corroboration it gestures
at....

- **[medium] Snapshot bucket columns are still frozen classification, still served by /api/networth, consumed by the Balance screen, and published to the model with no caveat**
  FACTS VERIFIED, FRAMING AND SEVERITY REFUTED. Every clause of the title is literally true and I
reproduced the data divergence; what does not survive is the thesis that this is an unlanded fix,
and th...

- **[medium] rules.ts still carries the present-tense rule-count claim its own printed query disproves, which Phase 9 recorded as a defect and nobody fixed**
  The stale digits are real and I confirm them: server/src/services/rules.ts:502-503 says "236 live
rules over 41 distinct timestamps, 173 of them sharing one" and prints its own query; that query
again...

- **[medium] Gate 1, the `/alpha` canary the plan called mandatory before any triplet moved, was never written; the repalette shipped without it**
  REFUTED. The finding's factual core is true but its consequence is nil at HEAD, and its account of
existing coverage is wrong in the direction that matters.  (a) Absence verified. No test or script
co...

- **[medium] Phase 12's proof #5, the money-pair CVD assertion, does not exist; the shipped palette clears it by a wide margin but nothing holds it there**
  Both factual halves of the finding check out, but its causal claim does not, and it identifies no
defect.  VERIFIED FACTS: (1) No test asserts CVD separation for the money pair.
tests/seriesPalette.te...

- **[medium] Gate 2's "extend the dark-block agreement to all 45" did not land; 37 of 45 tokens still have no check that the media query and the attribute selector agree**
  REFUTED as a medium defect; the underlying observation is factually true but is a consequence-free
coverage gap, not something wrong at HEAD.  1. The facts are conceded, verified by my own reading.
te...

- **[medium] Modal.tsx has no role, no aria-modal, no focus trap and no focus restore; the Phase 12 pull-forward landed on CommandPalette instead**
  The raw code observation is true but the finding as framed does not survive, and it is exactly the
class the brief calls noise.  What I confirmed (code lens, read directly): -
client/src/components/Mo...

- **[medium] Phase 13 did not land in any part, and two of its anti-crowding caps are already exceeded at HEAD**
  REFUTED. Every grep the finder ran reproduces; what was measured is not a defect.  **Facts
conceded (all reproduced at HEAD).** No `Rule` primitive in `client/src/components/balance/` and
no `Rule` ex...

- **[medium] The Reports excluded-flows "investments" figure doubles the money moved to investments, and that figure is what the Cmd+K prompt is told**
  REFUTED. The cited code does what it says, but the claimed defect is not a code defect, and the
stated failure scenario does not occur.  1. The failure scenario is factually wrong about the only
surfa...

- **[medium] The premise that justified pinning `amount` (reversing migration 048's stated design) is contradicted by the data the app ingested after it shipped**
  REFUTED as a medium-severity defect. The finding's raw data observation is correct, but the defect
it builds on top of that observation is not real at HEAD.  WHAT I CONFIRMED (the finding's data is
ac...

- **[medium] 14 of 16 contextual advisor-prompt builders have no caller, against the record's claim that the AI needs no tab because it is reachable everywhere**
  The structural fact is true; the defect claim built on it is not.  VERIFIED (the counting half): -
`grep -rn "AdvisorPrompt" client/src | grep -v lib/advisorPrompts.ts` returns exactly four lines,
in ...

- **[medium] Six api.ts fetchers have no caller again, and the test that exists to catch that walks a hardcoded list of the six old ones**
  The finding's two structural facts are true and I reproduced both, but the failure scenario that
earns it "medium" is substantially false.  VERIFIED TRUE (both legs of the mechanism): 1. `grep
-rn "<m...

- **[medium] Modal.tsx still has no role="dialog", no aria-modal and no focus restore, which Phase 12 declared it would ship**
  The greps are accurate: client/src/components/Modal.tsx:42-65 is a bare `<div>` with no
`role="dialog"`, no `aria-modal`, no focus trap and no focus restore, and the only hits in
`client/src` are Comm...

- **[medium] Editing a manual account's balance plants a permanent unreconciled finding the owner has no sequence of actions to clear**
  REFUTED. I read the cited code and its callers, and both load-bearing premises are false at HEAD.
1. "the only way the feature offers to update one" is false. `createManualTransaction`
(server/src/se...

- **[medium] The whole report drilldown/evidence chain has no production caller, and the two money functions in it still compute totals by sign - the pre-fix arithmetic, pinned by tests**
  REFUTED on reachability, not on facts. Every factual claim in the finding reproduces, but the
defect cannot occur at HEAD.  What I verified (code lens): 1. Unreachability is total. `grep -rn
"getRepor...

- **[medium] The stale-account zeroing pass is disabled by this app's own warnings, including the advisory its own 730-day request provokes**
  REFUTED as stated. The finder's mechanism reading of the code is accurate, but its consequence
claims do not survive contact with HEAD or the live ledger.  What is true (verified by reading):
`server/...

- **[medium] Report Summary renders its three deltas with no explicit sign, in a document that signs every other comparison, so a rise reads as the prior period's value**
  REFUTED as a medium defect; the rendering is real but the failure is not established, and no
number is wrong.  What I verified (rendered `buildFinancialContext()` and
`buildAdvisorContextSnapshot()` a...

- **[medium] PUT /api/settings/preferences/:key can re-create the three preference keys the restore path explicitly refuses, including the retired autonomy policy the model can read**
  The mechanical half of the finding is accurate, and I confirmed it by reading the code:
`setPreference` (server/src/services/preferences.ts:57-83) does an unconditional UPDATE-or-INSERT
with no key ch...

- **[medium] holds_position is true for an account whose only holdings are zeroed, so a liquidated account raises a reconciliation note it cannot act on**
  REFUTED at the causal chain, not at the predicate. The finding's kernel is true and I confirmed it
directly: server/src/services/netWorthHistory.ts:166-167 documents holds_position as "1 when the
acco...

- **[medium] The plan record's 'all 14 Fidelity rows carry the wrong sign' is stale: the feed flipped sign at the re-link and no detector reports the discontinuity**
  REFUTED. The finder's raw observations are accurate; the defect framing built on them is not.
Verified as stated (so this is not a fabricated-evidence refutation): live.db holds 18 'Electronic
Funds ...

- **[medium] A sync interrupted by process exit leaves a sync_runs row at 'running' that renders as a forever-spinning run reporting "no tx changes" over a detail listing 111 modified**
  REFUTED as framed. The mechanism is real, but every claim that gives the finding its severity
fails, and the underlying condition is already recorded in the plan files as known, measured, and
cosmetic...

- **[medium] The backup restore path is capped at 10mb while the backup export it must accept has no cap; today's backup is 3.52 MiB of that ceiling**
  REFUTED. The measurement is honest, but the defect it is attached to is not reachable at HEAD, and
the one trigger the finder called "today" describes UI that does not exist.  1. The failure
scenario ...

- **[medium] Helmet's production CSP blocks the inline theme bootstrap, and nothing else ever sets data-theme at load**
  Every mechanical claim in the finding is true, but the failure is not reachable at HEAD.  VERIFIED
AS STATED: - node_modules/helmet/index.cjs:14 - helmet 8.1.0 getDefaultDirectives() emits "script-
src...

- **[medium] 051_ai_runs.sql states a cause for the always-open review gate that the live data does not support**
  REFUTED. The finding's measurements are all correct, but its causal claim is anachronistic: it
judges a 2026-07-31 comment against a gate shape that did not exist until a later commit.
**Decisive evi...

- **[medium] A chat-tool write renders to the owner as "applied on its own" and is reported to the model as "applied autonomously", which is the one thing the code that writes it says it is not**
  REFUTED. I read every cited site and the finding's load-bearing claim is false; what remains is a
documented, tested, latent tradeoff.  1. The central factual assertion is wrong. The finding
states th...

- **[medium] 19 exported symbols are dead everywhere in the tree, including a whole design-system component the ui-overhaul plan flagged and never closed**
  I re-ran the census by hand and the finding's factual core survives but its framing and several of
its own numbers do not.  WHAT HOLDS. With no `import * as` anywhere in the tree (grep over
server/src...

- **[medium] The query-parameter half of the validation layer was built and never adopted: validateQuery and ExportCsvSchema have zero callers, contradicting CLAUDE.md's stated validation story**
  REFUTED at the claimed severity. The finding's greps are accurate, but the consequence it rests on
is not, and I reproduced the difference.  What holds up (verified): -
server/src/middleware/validate....

- **[medium] scripts/ is in none of the three tsconfigs: 11 tracked scripts importing 8 live server services sit outside the four-command gate, the same structural hole CLAUDE.md records tests/ having had**
  REFUTED on the merits (not as prior-round noise): the base fact is true, but the operative claim
is false for a third of the files, and there is no defect reachable at HEAD.  1. Base fact
confirmed, a...

- **[medium] Three DB columns are declared in the schema and in shared/types, populated on zero live rows, and read by no server code; one is read only by a dead prompt builder**
  Every factual observation in the finding is verifiable and true, but none of them constitutes a
defect at HEAD.  VERIFIED FACTS (I reproduced all of them): - live.db: transactions 2723 rows, 0
with so...

- **[medium] `snapshot.ts` counts `type = 'closed'` accounts in net worth; four other surfaces do not, and the Accounts screen's comment claims it matches snapshot.ts**
  REFUTED on three independent grounds; the structural observation is accurate but every claim built
on it fails.  1. The comment claim is an over-read of the comment.
`client/src/views/accounts/Account...

- **[medium] deleteTransaction has no test at all, and createManualTransaction's balance effect is never asserted, on the write paths that move a manual account's stored balance**
  REFUTED. The finding's coverage facts are true, but every failure mode it hypothesizes is
structurally unreachable at HEAD, so this is a coverage note, not a defect.  VERIFIED AS STATED (I
reproduced ...

- **[medium] 44 hand-written money conversions in three routers have no test driving them over HTTP, in a repo that built routeMoneyBoundary.test.ts for exactly that class and applied it to one router**
  REFUTED. The coverage gap is real but there is no defect at HEAD, and no claim in code or copy
that HEAD fails to honor.  1. NO MISSING CONVERSION EXISTS IN THE THREE NAMED ROUTERS. I checked
every mo...

- **[medium] Phase 13's rule ladder picks the one rung that does not clear 3:1 on the palette that actually shipped**
  REFUTED. The finder's arithmetic reproduces exactly; the framing does not survive the code.  I
independently recomputed WCAG 2.1 sRGB contrast from the triplets in client/src/index.css at HEAD
(light ...

- **[medium] sync_run_items stamps started_at and completed_at from two adjacent new Date() calls, so no stage duration has ever been recorded**
  The finding's raw facts are all verified, but its stated consequence is false and its severity is
overstated.  VERIFIED FACTS (I reproduced every one): - server/src/services/syncHistory.ts:68-69
stamp...

- **[medium] The whole markdown parser stack sits in the entry chunk via a static import chain, for a surface that only renders behind Cmd+K in ask mode**
  Every factual claim in the finding is TRUE, and I confirmed it more strongly than the finder did.
What does not survive is the characterization as a medium-severity defect.  WHAT I VERIFIED (all
direc...

- **[low] rebuild.md records the theme toggle as persisted in app_preferences; HEAD persists it in localStorage**
  REFUTED as a defect, though the finder's raw facts are all correct and I confirmed every one of
them.  Verified facts (conceded in full): - `.claude/plans/rebuild.md:222` reads: "- [x] **Theme
toggle*...

- **[low] The two sections this audit was pointed at are stale: all four "Left open, deliberately" items are closed at HEAD, and "Deliberately not done" cites a column that exists**
  REFUTED. The finding is factually wrong where it is checkable, and not-a-defect where it is right.
**1. The finding's one novel falsifiable claim is false.** The headline asserts "all four 'Left
open...

- **[low] Five measured figures in CLAUDE.md and in code comments no longer reproduce, and one of them carries no measurement date**
  REFUTED. The finder's queries and numbers are all arithmetically correct; the interpretation is
wrong, and the one item they built an actual failure scenario around is disproved by direct
reproduction...

- **[low] SimpleFIN holdings ingest persists a malformed market value as zero, bypassing the file's own no-NaN guard**
  REFUTED. The code observation is real; the consequence chain and the reachability are not.  What
survives: the asymmetry at server/src/services/simplefin.ts:117
(`parseFloat(String(holding.market_valu...

- **[low] Code comments still quote figures the project's own 2026-07-31 correction table recorded as no longer holding, and one of them does not reproduce under any variant**
  REFUTED. The finding's headline and only novel claim -- that the $6,267.43 residual "does not
reproduce under any variant" -- is false. I reproduced the corrected figure exactly, and the
finder's re-d...

- **[low] "11 accounts judged" counts three closed accounts with zero balances and no windows of real movement**
  The finding's mechanics are factually accurate, and I reproduced them; what I am refuting is the
defect framing, not the arithmetic.  Reproduced (verified): `reconcileAccounts(db)` run against
the rea...

- **[low] The query-string validator and one schema are dead: validateQuery has zero users and ExportCsvSchema has zero references, so every query string is parsed by hand**
  The mechanical claims are TRUE and I confirmed them: `grep -rn "validateQuery\|ExportCsvSchema"
server/src shared client tests` returns exactly two lines, both declarations
(server/src/middleware/vali...

- **[low] `getReportNetWorthEvidence` baselines its delta on an estimated snapshot, against the rule stated 170 lines below it in the same file**
  REFUTED on reachability, not on accuracy. The refuter bar is conjunctive (real AND reachable at
HEAD); the second prong fails, and the finding concedes it.  1. Code claim: VERIFIED as stated.
/Users/m...

- **[low] snapshot.ts claims recomputation keeps the reconstructed and measured halves of the line consistent; on live data that join is now larger than the gap the comment was written about**
  Refuted on three independent grounds, two of them factual errors in the finding itself.  (1) The
claim under test is honored at HEAD. server/src/services/snapshot.ts:624-630 argues that `if
(existing)...

- **[low] The retired-route guard scans two files; three others write retired paths into rows the owner clicks**
  REFUTED. The premise is partly true, the consequence is false, and there is no defect at HEAD.
What the finding gets right (conceded): tests/insightsRoute.test.ts:250-268 does read only
`server/src/r...
