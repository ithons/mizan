-- Freeze which accounts a net-worth snapshot's portfolio was made of, at the moment it was written.
--
-- THE BUG THESE COLUMNS EXIST FOR. `/api/reports/investments` resolved "the portfolio" from the
-- accounts table AS IT IS TODAY and then applied that one set to every breakdown ever written. The
-- stored numbers never moved, so nothing looked wrong and nothing detected it, but what a point on
-- the chart MEANT was re-decided on every request. Measured against /tmp/phase2.db, a `.backup`
-- copy of `.mizan/mizan.db` taken 2026-08-01 at migration 055, on the 2026-07-30 snapshot:
--
--   portfolio today = Fidelity Individual (brokerage) + Fidelity Roth IRA (ira_roth) + Coinbase
--                     (crypto_wallet) = $2,445.89 on that date's breakdown
--   retype Wealthfront Cash (savings, $1,001.70) to `brokerage`  ->  the same point reads $3,447.59
--   hide Coinbase (DELETE /api/coinbase/disconnect sets is_hidden = 1) ->  the same point reads $2,045.04
--
-- Neither edit touched a snapshot. Both rewrote every point in the series, backwards, for good.
--
-- WHAT IS STORED, AND WHY IT IS THE SET RATHER THAN A SUBTOTAL. `portfolio_accounts` is a JSON
-- array of the account ids the portfolio consisted of when the row was written. A stored subtotal
-- would be cheaper and would answer exactly one question; the endpoint asks three (the value, how
-- many accounts that value covers, and whether two consecutive points sum the same set at all), and
-- only the set answers all three. It also keeps the money in one place: the value stays a sum over
-- `breakdown`, which is the row's record of which account held what, and this column adds only the
-- classification of those accounts. `netWorthHistory.deriveAssetBuckets` argued the same division from
-- the other side until it was deleted on 2026-08-01 for having no production caller, and the bucket
-- columns added by migration 002 are the counter-example: they
-- froze an interpretation as a number, and when the two Fidelity accounts were retyped from
-- `checking` there was no way to recompute them.
--
-- `portfolio_accounts_source` says which of two things the set is:
--
--   'recorded'      the code that wrote this row's balances wrote this set in the same statement,
--                   from the accounts table as it stood then. For an `is_estimated = 1` row that
--                   means the moment of the reconstruction (`created_at`), not the row's own date:
--                   the balances of such a row are derived from the same instant, so the row is
--                   self-consistent, and `backfillSnapshots` rewrites both halves together.
--   'reconstructed' the set was filled in afterwards, by this migration, from an accounts table
--                   that postdates the row. It is a reconstruction and carries exactly the fault
--                   above: if a type was edited between the row being written and this migration
--                   running, it is wrong, and nothing in this database can tell.
--
-- The distinction is the point. Migration 040 deleted rows by hand and a script recreated five of
-- them two days later because nothing recorded what had been derived versus observed; `is_estimated`
-- exists for the same reason one level up. A backfill that presented itself as a measurement would
-- be that failure again, so every row this file touches says `reconstructed` and means it.
--
-- THE SET BELOW IS HARDCODED ON PURPOSE. `PORTFOLIO_ACCOUNT_TYPES` lives in
-- `services/netWorthHistory.ts` and both the writer and the reader import it from there. A migration
-- must produce the same result on a clone in a year's time, so it pins the definition as it stood at
-- 056 instead of tracking a constant that will move.
--
-- Rows whose `breakdown` is not a JSON object are left NULL on both columns. Such a row cannot be
-- read at all (`portfolioInSnapshot` returns null and the endpoint drops the point), so inventing a
-- membership for it would be inventing the only part of it that was ever legible.
--
-- On the ledger this was written against: 33 snapshots, 16 estimated and 17 measured, all 33 with a
-- readable breakdown, so all 33 come out of this file marked `reconstructed`. The 16 estimated ones
-- become `recorded` on the next reconstruction run, which rewrites them from scratch anyway. The 17
-- measured ones stay `reconstructed` forever, because nothing can go back and observe what the
-- portfolio was on a day that has passed.

ALTER TABLE net_worth_snapshots ADD COLUMN portfolio_accounts TEXT;

ALTER TABLE net_worth_snapshots ADD COLUMN portfolio_accounts_source TEXT
  CHECK (portfolio_accounts_source IS NULL
         OR portfolio_accounts_source IN ('recorded', 'reconstructed'));

UPDATE net_worth_snapshots
SET portfolio_accounts = (
      SELECT json_group_array(id)
      FROM (
        SELECT entry.key AS id
        FROM json_each(net_worth_snapshots.breakdown) AS entry
        WHERE entry.key IN (
          SELECT a.id
          FROM accounts a
          WHERE a.is_liability = 0
            AND a.is_hidden = 0
            AND (a.type IN ('brokerage', 'ira_traditional', 'ira_roth', 'crypto_wallet')
                 OR EXISTS (SELECT 1 FROM holdings h WHERE h.account_id = a.id))
        )
        ORDER BY entry.key
      )
    ),
    portfolio_accounts_source = 'reconstructed'
WHERE json_valid(breakdown)
  AND json_type(breakdown) = 'object';
