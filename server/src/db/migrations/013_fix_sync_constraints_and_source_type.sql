PRAGMA foreign_keys = OFF;

-- Fix sync_runs
CREATE TABLE sync_runs_new (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK(scope IN ('full','plaid_item','plaid_all','coinbase','teller_all','simplefin_all')),
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

-- Fix sync_run_items
CREATE TABLE sync_run_items_new (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES sync_runs(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK(provider IN ('plaid','coinbase','teller','simplefin','system')),
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

-- Fix transactions (re-add source_type and source_detail)
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
  source_type TEXT NOT NULL DEFAULT 'manual' CHECK(source_type IN ('plaid','coinbase','teller','simplefin','manual','import')),
  source_detail TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO transactions_new (
  id, plaid_transaction_id, teller_transaction_id, simplefin_transaction_id, coinbase_transaction_id,
  account_id, date, amount, merchant_name, original_name, category_id, pending, notes, is_manual,
  recurring_id, duplicate_group_id, duplicate_status, transfer_pair_id, transfer_status, review_status,
  created_at, updated_at
) SELECT
  id, plaid_transaction_id, teller_transaction_id, simplefin_transaction_id, coinbase_transaction_id,
  account_id, date, amount, merchant_name, original_name, category_id, pending, notes, is_manual,
  recurring_id, duplicate_group_id, duplicate_status, transfer_pair_id, transfer_status, review_status,
  created_at, updated_at
FROM transactions;

UPDATE transactions_new
SET source_type = CASE
  WHEN plaid_transaction_id IS NOT NULL THEN 'plaid'
  WHEN teller_transaction_id IS NOT NULL THEN 'teller'
  WHEN simplefin_transaction_id IS NOT NULL THEN 'simplefin'
  WHEN coinbase_transaction_id IS NOT NULL THEN 'coinbase'
  ELSE 'manual'
END;

DROP TABLE transactions;
ALTER TABLE transactions_new RENAME TO transactions;

CREATE INDEX idx_transactions_account_id ON transactions(account_id);
CREATE INDEX idx_transactions_date ON transactions(date);
CREATE INDEX idx_transactions_category_id ON transactions(category_id);
CREATE INDEX idx_transactions_duplicate_group_id ON transactions(duplicate_group_id);
CREATE INDEX idx_transactions_transfer_pair_id ON transactions(transfer_pair_id);
CREATE INDEX idx_transactions_review_status ON transactions(review_status);

PRAGMA foreign_keys = ON;
