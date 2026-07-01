DELETE FROM transactions WHERE account_id IN (SELECT id FROM accounts WHERE connection_type IN ('plaid', 'teller'));
DELETE FROM investment_transactions WHERE account_id IN (SELECT id FROM accounts WHERE connection_type IN ('plaid', 'teller'));
DELETE FROM holdings WHERE account_id IN (SELECT id FROM accounts WHERE connection_type IN ('plaid', 'teller'));
DELETE FROM accounts WHERE connection_type IN ('plaid', 'teller');
DELETE FROM sync_run_items WHERE provider IN ('plaid', 'teller');
DELETE FROM sync_runs WHERE scope IN ('plaid_item', 'plaid_all', 'teller_all');

PRAGMA foreign_keys = OFF;

DROP TABLE IF EXISTS plaid_items;
DROP TABLE IF EXISTS teller_items;

-- 1. Fix sync_runs
CREATE TABLE sync_runs_new (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK(scope IN ('full','coinbase','simplefin_all')),
  status TEXT NOT NULL CHECK(status IN ('running','succeeded','partial','failed')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  message TEXT,
  error_code TEXT,
  error_message TEXT,
  recovery_action TEXT,
  accounts_seen INTEGER NOT NULL DEFAULT 0,
  transactions_added INTEGER NOT NULL DEFAULT 0,
  transactions_modified INTEGER NOT NULL DEFAULT 0,
  transactions_removed INTEGER NOT NULL DEFAULT 0,
  transactions_skipped INTEGER NOT NULL DEFAULT 0,
  duplicate_candidates INTEGER NOT NULL DEFAULT 0,
  transfer_candidates INTEGER NOT NULL DEFAULT 0
);

INSERT INTO sync_runs_new SELECT * FROM sync_runs;
DROP TABLE sync_runs;
ALTER TABLE sync_runs_new RENAME TO sync_runs;
CREATE INDEX idx_sync_runs_started_at ON sync_runs(started_at DESC);

-- 2. Fix sync_run_items
CREATE TABLE sync_run_items_new (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES sync_runs(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK(provider IN ('coinbase','simplefin','system')),
  connection_id TEXT,
  institution_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN ('running','succeeded','skipped','reauth_required','failed')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  accounts_seen INTEGER NOT NULL DEFAULT 0,
  transactions_added INTEGER NOT NULL DEFAULT 0,
  transactions_modified INTEGER NOT NULL DEFAULT 0,
  transactions_removed INTEGER NOT NULL DEFAULT 0,
  transactions_skipped INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  recovery_action TEXT
);

INSERT INTO sync_run_items_new SELECT * FROM sync_run_items;
DROP TABLE sync_run_items;
ALTER TABLE sync_run_items_new RENAME TO sync_run_items;
CREATE INDEX idx_sync_run_items_run_id ON sync_run_items(run_id);

-- 3. Fix accounts
CREATE TABLE accounts_new (
  id TEXT PRIMARY KEY,
  simplefin_account_id TEXT UNIQUE,
  coinbase_account_id TEXT UNIQUE,
  connection_id TEXT,
  connection_type TEXT NOT NULL CHECK(connection_type IN ('coinbase','simplefin','manual')),
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
  id, simplefin_account_id, coinbase_account_id, connection_id, connection_type,
  institution_name, account_name, type, subtype, mask, current_balance, available_balance, credit_limit,
  currency, native_currency, native_balance, is_manual, is_hidden, is_liability,
  color, sort_order, created_at, updated_at
) SELECT
  id, simplefin_account_id, coinbase_account_id, connection_id, connection_type,
  institution_name, account_name, type, subtype, mask, current_balance, available_balance, credit_limit,
  currency, native_currency, native_balance, is_manual, is_hidden, is_liability,
  color, sort_order, created_at, updated_at
FROM accounts;

DROP TABLE accounts;
ALTER TABLE accounts_new RENAME TO accounts;

-- 4. Fix transactions
CREATE TABLE transactions_new (
  id TEXT PRIMARY KEY,
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
  source_type TEXT NOT NULL DEFAULT 'manual' CHECK(source_type IN ('coinbase','simplefin','manual','import')),
  source_detail TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO transactions_new (
  id, simplefin_transaction_id, coinbase_transaction_id, account_id, date, amount, merchant_name,
  original_name, category_id, pending, notes, is_manual, recurring_id,
  duplicate_group_id, duplicate_status, transfer_pair_id, transfer_status, review_status,
  source_type, source_detail, created_at, updated_at
) SELECT
  id, simplefin_transaction_id, coinbase_transaction_id, account_id, date, amount, merchant_name,
  original_name, category_id, pending, notes, is_manual, recurring_id,
  duplicate_group_id, duplicate_status, transfer_pair_id, transfer_status, review_status,
  source_type, source_detail, created_at, updated_at
FROM transactions;

DROP TABLE transactions;
ALTER TABLE transactions_new RENAME TO transactions;

CREATE INDEX idx_transactions_account_id ON transactions(account_id);
CREATE INDEX idx_transactions_date ON transactions(date);
CREATE INDEX idx_transactions_category_id ON transactions(category_id);
CREATE INDEX idx_transactions_duplicate_group_id ON transactions(duplicate_group_id);
CREATE INDEX idx_transactions_transfer_pair_id ON transactions(transfer_pair_id);
CREATE INDEX idx_transactions_review_status ON transactions(review_status);

-- 5. Fix securities
CREATE TABLE securities_new (
  id TEXT PRIMARY KEY,
  ticker TEXT,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('equity','etf','mutual_fund','crypto','cash','other')),
  currency TEXT NOT NULL DEFAULT 'USD',
  sector TEXT,
  sector_source TEXT
);

INSERT INTO securities_new (
  id, ticker, name, type, currency, sector, sector_source
) SELECT
  id, ticker, name, type, currency, sector, sector_source
FROM securities;

DROP TABLE securities;
ALTER TABLE securities_new RENAME TO securities;

-- 6. Fix investment_transactions
CREATE TABLE investment_transactions_new (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('buy','sell','dividend','transfer','fee','other')),
  security_id TEXT REFERENCES securities(id),
  quantity REAL,
  price REAL,
  amount REAL NOT NULL,
  fees REAL,
  name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

INSERT INTO investment_transactions_new (
  id, account_id, date, type, security_id, quantity, price, amount, fees, name, created_at
) SELECT
  id, account_id, date, type, security_id, quantity, price, amount, fees, name, created_at
FROM investment_transactions;

DROP TABLE investment_transactions;
ALTER TABLE investment_transactions_new RENAME TO investment_transactions;

CREATE INDEX idx_inv_tx_account_id ON investment_transactions(account_id);

PRAGMA foreign_keys = ON;
