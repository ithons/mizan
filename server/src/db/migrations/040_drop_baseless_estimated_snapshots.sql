-- Remove estimated net-worth snapshots for months the ledger never reached.
--
-- backfillSnapshots() estimates the past by taking today's balance and undoing every later
-- transaction. That carries information only as far back as an account's transaction history
-- goes. Past that point the arithmetic still yields a number, but the number is today's balance
-- restated under an old date: not an estimate, an assertion that nothing ever changed.
--
-- On this database that produced 20 consecutive months (2023-09 .. 2025-04) with byte-identical
-- breakdowns, drawn on the same chart line as measured snapshots with nothing to tell them
-- apart. A second failure stacked on top: a liability whose purchases are known but whose
-- payments are not gets reversed past zero and clamped there (snapshot.ts), so 1,076 real
-- BofA transactions in that window all flattened to $0. The estimate reported net worth of
-- $4,049.84 for 2026-06-01 against $1,068.29 measured four weeks later, overstating by 3.8x,
-- almost entirely by understating debt.
--
-- The floor is the latest month at which EVERY account still holding value has ledger history
-- reaching back that far. Accounts at $0 have nothing to reconstruct; accounts with no
-- transactions at all (a manual cash account) are static as far as the ledger knows and cannot
-- introduce false movement. Both are exempt, matching estimateFloorMonth() in snapshot.ts,
-- which stops generating these going forward.
--
-- Only is_estimated = 1 rows are eligible. Measured snapshots are a record of real balances at
-- a point in time and are never deleted. Deleted rows are pure derivation and regenerate from
-- transactions plus current balances if the rule is ever relaxed.
--
-- The subquery is NULL when no account qualifies, and `date < NULL` is NULL, so this deletes
-- nothing rather than everything on a fresh or transaction-free install.

DELETE FROM net_worth_snapshots
WHERE is_estimated = 1
  AND date < (
    SELECT strftime('%Y-%m-01', MAX(first_transaction))
    FROM (
      SELECT MIN(t.date) AS first_transaction
      FROM accounts a
      JOIN transactions t ON t.account_id = a.id
      WHERE a.is_hidden = 0
        AND a.current_balance != 0
      GROUP BY a.id
    )
  );
