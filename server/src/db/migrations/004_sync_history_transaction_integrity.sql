-- Durable sync history and transaction trust metadata.

ALTER TABLE transactions ADD COLUMN source_type TEXT NOT NULL DEFAULT 'manual'
  CHECK(source_type IN ('plaid','coinbase','manual','import'));
ALTER TABLE transactions ADD COLUMN source_detail TEXT;
ALTER TABLE transactions ADD COLUMN duplicate_group_id TEXT;
ALTER TABLE transactions ADD COLUMN duplicate_status TEXT NOT NULL DEFAULT 'none'
  CHECK(duplicate_status IN ('none','candidate','dismissed'));
ALTER TABLE transactions ADD COLUMN transfer_pair_id TEXT;
ALTER TABLE transactions ADD COLUMN transfer_status TEXT NOT NULL DEFAULT 'none'
  CHECK(transfer_status IN ('none','candidate','confirmed','dismissed'));
ALTER TABLE transactions ADD COLUMN review_status TEXT NOT NULL DEFAULT 'open'
  CHECK(review_status IN ('open','reviewed','dismissed'));

UPDATE transactions
SET source_type = CASE
  WHEN plaid_transaction_id IS NOT NULL THEN 'plaid'
  WHEN coinbase_transaction_id IS NOT NULL THEN 'coinbase'
  WHEN is_manual = 1 THEN 'manual'
  ELSE 'manual'
END;

CREATE INDEX IF NOT EXISTS idx_transactions_duplicate_group_id
  ON transactions(duplicate_group_id);
CREATE INDEX IF NOT EXISTS idx_transactions_transfer_pair_id
  ON transactions(transfer_pair_id);
CREATE INDEX IF NOT EXISTS idx_transactions_review_status
  ON transactions(review_status);

CREATE TABLE IF NOT EXISTS sync_runs (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK(scope IN ('full','plaid_item','plaid_all','coinbase')),
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

CREATE TABLE IF NOT EXISTS sync_run_items (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES sync_runs(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK(provider IN ('plaid','coinbase','system')),
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

CREATE TABLE IF NOT EXISTS sync_changes (
  id TEXT PRIMARY KEY,
  run_item_id TEXT NOT NULL REFERENCES sync_run_items(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL CHECK(entity_type IN ('account','transaction','investment','recurring','snapshot','integrity')),
  entity_id TEXT,
  change_type TEXT NOT NULL CHECK(change_type IN ('inserted','updated','deleted','skipped','detected')),
  description TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sync_runs_started_at ON sync_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_run_items_run_id ON sync_run_items(run_id);
CREATE INDEX IF NOT EXISTS idx_sync_changes_run_item_id ON sync_changes(run_item_id);
