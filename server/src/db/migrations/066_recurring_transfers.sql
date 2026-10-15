ALTER TABLE recurring_patterns ADD COLUMN kind TEXT NOT NULL DEFAULT 'flow'
  CHECK (kind IN ('flow', 'transfer'));
ALTER TABLE recurring_patterns ADD COLUMN account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE recurring_patterns ADD COLUMN counterparty_account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE;
