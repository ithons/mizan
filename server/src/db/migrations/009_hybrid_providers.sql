-- Teller items
CREATE TABLE IF NOT EXISTS teller_items (
  id TEXT PRIMARY KEY,
  enrollment_id TEXT UNIQUE NOT NULL,
  institution_name TEXT NOT NULL DEFAULT '',
  last_synced_at TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);

-- SimpleFIN connections
CREATE TABLE IF NOT EXISTS simplefin_connections (
  id TEXT PRIMARY KEY,
  access_url TEXT UNIQUE NOT NULL,
  last_synced_at TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);

-- Temporarily drop indices before renaming
DROP INDEX IF EXISTS idx_transactions_account_id;
DROP INDEX IF EXISTS idx_transactions_date;
DROP INDEX IF EXISTS idx_transactions_category_id;

-- Recreate accounts with new connection_type options
CREATE TABLE accounts_new (
  id TEXT PRIMARY KEY,
  plaid_account_id TEXT UNIQUE,
  teller_account_id TEXT UNIQUE,
  simplefin_account_id TEXT UNIQUE,
  coinbase_account_id TEXT UNIQUE,
  connection_id TEXT,
  connection_type TEXT NOT NULL CHECK(connection_type IN ('plaid','coinbase','teller','simplefin','manual')),
  institution_name TEXT NOT NULL DEFAULT '',
  account_name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('checking','savings','credit','brokerage','ira_traditional','ira_roth','crypto_wallet','cash','other')),
  subtype TEXT,
  mask TEXT,
  current_balance REAL NOT NULL DEFAULT 0,
  available_balance REAL,
  credit_limit REAL,
  currency TEXT NOT NULL DEFAULT 'USD',
  native_currency TEXT,
  native_balance REAL,
  is_manual INTEGER NOT NULL DEFAULT 0,
  is_hidden INTEGER NOT NULL DEFAULT 0,
  is_liability INTEGER NOT NULL DEFAULT 0,
  color TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO accounts_new (
  id, plaid_account_id, coinbase_account_id, connection_id, connection_type,
  institution_name, account_name, type, subtype, mask, current_balance, available_balance, credit_limit,
  currency, native_currency, native_balance, is_manual, is_hidden, is_liability,
  color, sort_order, created_at, updated_at
) SELECT 
  id, plaid_account_id, coinbase_account_id, connection_id, connection_type,
  institution_name, account_name, type, subtype, mask, current_balance, available_balance, credit_limit,
  currency, native_currency, native_balance, is_manual, is_hidden, is_liability,
  color, sort_order, created_at, updated_at
FROM accounts;

DROP TABLE accounts;
ALTER TABLE accounts_new RENAME TO accounts;

-- Recreate transactions
CREATE TABLE transactions_new (
  id TEXT PRIMARY KEY,
  plaid_transaction_id TEXT UNIQUE,
  teller_transaction_id TEXT UNIQUE,
  simplefin_transaction_id TEXT UNIQUE,
  coinbase_transaction_id TEXT UNIQUE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  amount REAL NOT NULL,
  merchant_name TEXT,
  original_name TEXT NOT NULL DEFAULT '',
  category_id TEXT REFERENCES categories(id),
  pending INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  is_manual INTEGER NOT NULL DEFAULT 0,
  recurring_id TEXT,
  duplicate_group_id TEXT,
  duplicate_status TEXT NOT NULL DEFAULT 'none',
  transfer_pair_id TEXT,
  transfer_status TEXT NOT NULL DEFAULT 'none',
  review_status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO transactions_new (
  id, plaid_transaction_id, coinbase_transaction_id, account_id, date, amount, merchant_name,
  original_name, category_id, pending, notes, is_manual, recurring_id,
  duplicate_group_id, duplicate_status, transfer_pair_id, transfer_status, review_status, created_at, updated_at
) SELECT 
  id, plaid_transaction_id, coinbase_transaction_id, account_id, date, amount, merchant_name,
  original_name, category_id, pending, notes, is_manual, recurring_id,
  duplicate_group_id, duplicate_status, transfer_pair_id, transfer_status, review_status, created_at, updated_at
FROM transactions;

DROP TABLE transactions;
ALTER TABLE transactions_new RENAME TO transactions;

-- Recreate indices
CREATE INDEX idx_transactions_account_id ON transactions(account_id);
CREATE INDEX idx_transactions_date ON transactions(date);
CREATE INDEX idx_transactions_category_id ON transactions(category_id);
