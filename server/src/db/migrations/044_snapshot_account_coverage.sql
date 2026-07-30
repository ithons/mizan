-- Record how much of the balance sheet each reconstructed month could actually account for.
--
-- THE BUG THESE COLUMNS EXIST FOR. backfillSnapshots() reconstructs the past by taking today's
-- balances and undoing every later transaction, and it stopped the entire backward walk at ONE
-- floor: the LATEST first-transaction date across every account still holding value. One account
-- gated all of them. Chase Freedom Flex opened 2026-03-10 carrying $283.81, so a ledger that
-- reaches back to 2023-09-16 with 1,671 BofA Cash Rewards transactions produced exactly five
-- estimated months. 2,198 of the 2,579 transactions in this database arrived through a seven-step
-- import pipeline whose whole purpose was long history, and nearly all of it was discarded. Every
-- new card the owner opens truncated the chart again.
--
-- Per-account floors end the truncation, but they change what a point on the line MEANS as it
-- goes back. September 2023 can account for one credit card; July 2026 accounts for fourteen
-- accounts. Drawn as a single continuous series with nothing to separate the two, that is a worse
-- lie than the truncation was: it reads as a real climb out of near-zero rather than as accounts
-- entering the ledger. These two columns are what a consumer needs in order to band or annotate
-- the region where the balance sheet is only partly known.
--
-- covered_accounts is how many accounts the month could account for. An account is covered when
-- its own transaction history reaches back to that month, or when it is exempt from needing
-- history at all: at $0 today there is no value to reconstruct, and with no transactions ever its
-- balance is static as far as the ledger knows and cannot introduce false movement.
--
-- Coverage is a label, not a licence, and it does not by itself make a month honest. Per-account
-- floors first reached back to 2023-09 and drew ten consecutive months at exactly $380.00, covered
-- 5 of 14, where the five were a static cash account, three closed accounts at $0, and a card
-- pinned on the reverse-replay clamp. A flat line is a claim regardless of what a column next to it
-- says, so snapshot.ts also requires a month to contain ledger activity on a covered, unclamped
-- account before it writes a row at all. These columns describe months that survived that test.
--
-- total_accounts is how many visible accounts the row was written against. It is deliberately not
-- "how many accounts existed in that month": accounts.created_at records when mizan first saw an
-- account, never when it was opened, so that number is not in this database and will not be
-- invented here.
--
-- Measured rows are backfilled from their own breakdown, where coverage is complete by
-- construction, because a measurement observed every account it lists. Existing estimated rows
-- are left NULL rather than guessed at: the code that wrote them recorded no coverage, and their
-- numbers are stale for a second reason anyway (each was computed against whatever the balances
-- were on the day it was first written, and nothing ever recomputed it). backfillSnapshots
-- recomputes or removes them on its next run.
--
-- That division is the point. This file adds columns; it does not repair data. Migration 040
-- deleted a class of baseless estimated snapshot by hand and scripts/backfill/rebuild.ts recreated
-- five of them two days later, including one at 2026-02-01 that the very code which wrote it would
-- have refused to write the following day, because an estimate was created only when absent and
-- then never looked at again. A repair that is not also a guard decays, so the guard now lives in
-- snapshot.ts where every future run passes through it.

ALTER TABLE net_worth_snapshots ADD COLUMN covered_accounts INTEGER;
ALTER TABLE net_worth_snapshots ADD COLUMN total_accounts INTEGER;

UPDATE net_worth_snapshots
SET covered_accounts = (SELECT COUNT(*) FROM json_each(net_worth_snapshots.breakdown)),
    total_accounts = (SELECT COUNT(*) FROM json_each(net_worth_snapshots.breakdown))
WHERE is_estimated = 0
  AND json_valid(breakdown)
  AND json_type(breakdown) = 'object';
