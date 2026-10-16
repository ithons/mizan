ALTER TABLE accounts ADD COLUMN balance_only INTEGER NOT NULL DEFAULT 0 CHECK (balance_only IN (0, 1));

UPDATE accounts SET balance_only = 1
WHERE connection_type = 'manual'
  AND type = 'cash'
  AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.account_id = accounts.id);
