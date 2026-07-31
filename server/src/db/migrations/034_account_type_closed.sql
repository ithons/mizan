-- Add a first-class 'closed' account type. SQLite can't alter a CHECK constraint, so recreate
-- the accounts table (create-new / copy / drop / rename, per 022/014). The new table def must
-- carry EVERY column added after 022, namely type_source (015), backfill_floor_date (030) and
-- name_source (032), or they'd be silently dropped. Only the `type` CHECK changes: + 'closed'.
--
-- Children (transactions/holdings/holdings_history/goals) reference accounts(id); ids are
-- preserved by the copy, so their FKs stay valid (runMigrations runs with foreign_keys OFF and
-- verifies with foreign_key_check before COMMIT).

CREATE TABLE accounts_new (
  id TEXT PRIMARY KEY,
  simplefin_account_id TEXT UNIQUE,
  coinbase_account_id TEXT UNIQUE,
  connection_id TEXT,
  connection_type TEXT NOT NULL CHECK(connection_type IN ('coinbase','simplefin','manual')),
  institution_name TEXT NOT NULL DEFAULT '',
  account_name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('checking','savings','credit','brokerage','ira_traditional','ira_roth','crypto_wallet','cash','other','closed')),
  subtype TEXT,
  mask TEXT,
  current_balance INTEGER NOT NULL DEFAULT 0,
  available_balance INTEGER,
  credit_limit INTEGER,
  currency TEXT NOT NULL DEFAULT 'USD',
  native_currency TEXT,
  native_balance REAL,
  is_manual INTEGER NOT NULL DEFAULT 0,
  is_hidden INTEGER NOT NULL DEFAULT 0,
  is_liability INTEGER NOT NULL DEFAULT 0,
  color TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  type_source TEXT NOT NULL DEFAULT 'auto',
  backfill_floor_date TEXT,
  name_source TEXT NOT NULL DEFAULT 'auto'
);

INSERT INTO accounts_new (
  id, simplefin_account_id, coinbase_account_id, connection_id, connection_type,
  institution_name, account_name, type, subtype, mask, current_balance, available_balance,
  credit_limit, currency, native_currency, native_balance, is_manual, is_hidden, is_liability,
  color, sort_order, created_at, updated_at, type_source, backfill_floor_date, name_source
) SELECT
  id, simplefin_account_id, coinbase_account_id, connection_id, connection_type,
  institution_name, account_name, type, subtype, mask, current_balance, available_balance,
  credit_limit, currency, native_currency, native_balance, is_manual, is_hidden, is_liability,
  color, sort_order, created_at, updated_at, type_source, backfill_floor_date, name_source
FROM accounts;

DROP TABLE accounts;
ALTER TABLE accounts_new RENAME TO accounts;
