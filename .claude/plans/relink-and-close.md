# SimpleFIN re-link, and closing what the audit left open

Written 2026-08-01, after the SimpleFIN subscription lapsed (HTTP 402), was renewed, and every
institution was re-added at the provider. Part I is `rebuild.md`, Part II `rebuild-part-2.md`,
Part III `rebuild-part-3.md`. This file is the ordered work that remains.

Every figure below was measured against a `.backup` copy of `.mizan/mizan.db` taken 2026-08-01, never
against the live file. The command is beside each one.

---

## Phase 0: the re-link, and it blocks everything else

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

## Phase 1: the mis-signed brokerage transfers

The oldest unclosed defect in the repo. 12 of 14 Fidelity "Electronic Funds Transfer Received" rows
carry the provider's wrong sign, about $1,800 of ledger error. It was deliberately never corrected,
for a good structural reason: `upsertSimplefinTransaction` compares and overwrites `amount`, so any
repair reverts within the hour. That is the self-reverting repair trap.

Migration 048 built `amount_source` and `transaction_field_revisions` precisely so a disagreement
between the provider and the owner could be **recorded** rather than silently resolved either way,
and **nothing has ever used it**. The mechanism exists and is idle.

Close it by making the recorded correction real:

- An owner correction writes a `transaction_field_revisions` row and sets `amount_source = 'owner'`.
- `upsertSimplefinTransaction` stops overwriting `amount` when `amount_source = 'owner'`, and instead
  records that the provider still disagrees. The disagreement is surfaced, not resolved.
- Every reader that sums money uses the effective amount, so the correction is visible everywhere at
  once rather than on one screen.

Proves it worked: a sync run over a corrected row leaves the amount alone and appends a disagreement
record; a second sync appends nothing new, because a standing disagreement is not a new event. And
the healthy case: a row nobody corrected syncs exactly as it does today and writes no revision.

Do NOT bulk-correct the 12 rows in a migration. That is the repair-the-database failure this codebase
is built against. Ship the mechanism, then correct them through it.

---

## Phase 2: freeze investment history at write time

`/api/reports/investments` resolves the portfolio account set from **today's** `accounts` table and
applies it to every past snapshot breakdown. Retyping one brokerage to `savings` moves the same two
snapshots from $2,445.89 to $505.92, and the screen stays internally consistent while being
historically false. Reproduced during Phase 9; the route comment states the limitation rather than
claiming the set is right.

The honest fix is to stop deriving membership after the fact:

- `takeSnapshot` records the portfolio subtotal, or the covered account set, at write time.
- The route reads what the snapshot recorded instead of intersecting with today's accounts.
- A migration plus a backfill for existing rows, which must mark reconstructed rows as reconstructed
  rather than presenting them as measured.

This is the largest of the remaining items and the only one needing a migration. It is also the one
that silently rewrites history, so it outranks the two cosmetic ones below.

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

**Bar fills are structurally weak.** `track` buys 1.19 to 1.55 against every ground a bar renders on
and clears `line` on paper by 0.02, so every `ProgressBar` and allocation bar is close to invisible
against its own track. This is a token problem, not prose. It should be solved with whatever palette
direction lands rather than patched twice.

---

## Phase 4: decide `ai_observations` and `ai_briefs`

Both were named in `rebuild.md` Phase 6 and never built. Migrations 050 and 051 delivered
`ai_incidents` and `ai_runs` from the same line. Their function **appears** absorbed by `ai_memory`
and the on-demand digest endpoint, but that is inference, and nobody wrote a decision down.

Take a position and record it. Most likely outcome: formally drop both, with the reason being that
`ai_memory` plus a digest computed on demand covers what a stored observation log was for, and a
second store would be a fifth hand-maintained copy of state the run rows already carry. If that is
right, say so in the plan and delete the line from Phase 6 so it stops reading as unfinished work.
If it is wrong, the gap is real and should be scheduled.

An inferred decision is the same defect as an unchecked claim: nobody can tell later whether it was
decided or forgotten.

---

## Order, and why

0. **Re-link.** It blocks the ledger being correct at all, and every day it waits is a day of stale
   balances. Nothing else matters while net worth can double on one paste.
1. **Mis-signed transfers.** $1,800 of wrong money on screen, and the mechanism to fix it properly has
   been sitting unused since migration 048.
2. **Investment history.** Silently false history is worse than a visibly missing feature.
3. **The three small closures.** Real, bounded, none of them urgent.
4. **The AI store decision.** Costs an hour and stops a question being re-asked forever.

Out of scope, deliberately: `CLAUDE.md` stays gitignored. The owner's position is that it should
never be committed, which settles the question Part III left open.
