-- Consolidate the 8 per-coin Coinbase "accounts" into ONE account that holds every coin as a
-- holding (the Fidelity model). Net-worth-invariant: the survivor's current_balance is set to
-- the SUM of all coin balances before the others are deleted, and net_worth_snapshots sums
-- accounts.current_balance, so aggregate assets/net worth are unchanged. Historical snapshot
-- rows are not touched. Children (transactions, holdings, holdings_history) are reassigned to
-- the survivor BEFORE the delete, so ON DELETE CASCADE never removes real history.
--
-- Survivor = the earliest-created Coinbase crypto_wallet account (deterministic). Each source
-- account holds exactly one distinct coin, so reassigning holdings/holdings_history to the
-- survivor never collides on their (account_id, security_id[, date]) unique keys.

CREATE TEMP TABLE _cb_survivor AS
  SELECT id AS sid
  FROM accounts
  WHERE connection_type = 'coinbase' AND type = 'crypto_wallet'
  ORDER BY created_at ASC, id ASC
  LIMIT 1;

-- Move all children of every Coinbase crypto_wallet account onto the survivor.
UPDATE transactions
SET account_id = (SELECT sid FROM _cb_survivor)
WHERE account_id IN (
  SELECT id FROM accounts WHERE connection_type = 'coinbase' AND type = 'crypto_wallet'
);

UPDATE holdings
SET account_id = (SELECT sid FROM _cb_survivor)
WHERE account_id IN (
  SELECT id FROM accounts WHERE connection_type = 'coinbase' AND type = 'crypto_wallet'
);

UPDATE holdings_history
SET account_id = (SELECT sid FROM _cb_survivor)
WHERE account_id IN (
  SELECT id FROM accounts WHERE connection_type = 'coinbase' AND type = 'crypto_wallet'
);

-- Fold the 8 accounts' balances and floor dates into the survivor. The SUM/MIN read the full
-- pre-delete set (SQLite evaluates the SET subqueries against the original row values), so the
-- survivor ends up carrying the combined balance and the earliest backfill floor. native_currency
-- and native_balance retire (coin quantity now lives per-holding); coinbase_account_id clears
-- because the account is no longer a single Coinbase brokerage account.
UPDATE accounts
SET
  current_balance = (
    SELECT COALESCE(SUM(current_balance), 0)
    FROM accounts
    WHERE connection_type = 'coinbase' AND type = 'crypto_wallet'
  ),
  backfill_floor_date = (
    SELECT MIN(backfill_floor_date)
    FROM accounts
    WHERE connection_type = 'coinbase' AND type = 'crypto_wallet'
      AND backfill_floor_date IS NOT NULL
  ),
  coinbase_account_id = NULL,
  native_currency = NULL,
  native_balance = NULL,
  account_name = 'Coinbase',
  updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
WHERE id = (SELECT sid FROM _cb_survivor);

-- Drop the now-empty per-coin accounts (their children were already reassigned above).
DELETE FROM accounts
WHERE connection_type = 'coinbase' AND type = 'crypto_wallet'
  AND id <> (SELECT sid FROM _cb_survivor);

DROP TABLE _cb_survivor;
