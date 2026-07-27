-- Fold the deleted per-coin Coinbase accounts out of historical net-worth breakdowns.
--
-- Migration 033 consolidated 8 per-coin Coinbase accounts into one and deleted the other 7. Its
-- comment is accurate as far as it goes ("Historical snapshot rows are not touched", and totals
-- stay invariant because total_assets is a stored column). What it missed is that
-- net_worth_snapshots.breakdown is a per-account map, and those 7 ids are still in it: 44 of 45
-- snapshots reference accounts that no longer exist, holding up to $209.19 each, while the
-- surviving Coinbase account reads $0 in every one of them.
--
-- reporting.ts joins those ids back to `accounts` (getNetWorthAttribution,
-- getReportNetWorthEvidence). A miss renders as account_name: null, and because the other side
-- of the diff treats an absent id as 0, each ghost reports its whole balance as a movement. The
-- "what moved net worth" panel attributes real dollars to seven nameless rows.
--
-- Fold every id that no longer resolves into the surviving Coinbase wallet, summing on
-- collision. Totals are unchanged by construction (the same numbers, regrouped), which the
-- verification asserts. Guarded on a Coinbase wallet existing, so this is a no-op on an install
-- that never had one, and json_valid keeps a malformed blob from being rewritten into nonsense.

UPDATE net_worth_snapshots
SET breakdown = (
  SELECT json_group_object(account_key, balance)
  FROM (
    SELECT
      CASE
        WHEN EXISTS (SELECT 1 FROM accounts WHERE accounts.id = entry.key) THEN entry.key
        ELSE (
          SELECT id FROM accounts
          WHERE connection_type = 'coinbase' AND type = 'crypto_wallet'
          ORDER BY created_at ASC, id ASC LIMIT 1
        )
      END AS account_key,
      SUM(entry.value) AS balance
    FROM json_each(net_worth_snapshots.breakdown) entry
    GROUP BY account_key
  )
)
WHERE json_valid(breakdown)
  AND EXISTS (
    SELECT 1 FROM accounts WHERE connection_type = 'coinbase' AND type = 'crypto_wallet'
  )
  AND EXISTS (
    SELECT 1 FROM json_each(net_worth_snapshots.breakdown) entry
    WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE accounts.id = entry.key)
  );
