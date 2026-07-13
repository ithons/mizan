-- Coinbase configured via .env (COINBASE_KEY_NAME/COINBASE_PRIVATE_KEY) was synced
-- through the full-sync path, which never wrote a coinbase_connections row and left
-- accounts.connection_id NULL. As a result crypto accounts were invisible to
-- sync-health (syncHealth.getSyncHealth joins accounts on connection_id = cc.id) and
-- to per-account sync badges. Create the synthetic env connection and link the
-- orphaned accounts. Idempotent + a no-op when there is nothing to backfill.

INSERT INTO coinbase_connections (id, coinbase_user_id, display_name, last_synced_at, status, created_at)
SELECT
  'coinbase_env',
  'env',
  'Coinbase',
  (SELECT MAX(updated_at) FROM accounts WHERE connection_type = 'coinbase'),
  'active',
  (SELECT MIN(created_at) FROM accounts WHERE connection_type = 'coinbase')
WHERE EXISTS (
  SELECT 1 FROM accounts WHERE connection_type = 'coinbase' AND connection_id IS NULL
)
AND NOT EXISTS (
  SELECT 1 FROM coinbase_connections WHERE coinbase_user_id = 'env'
);

UPDATE accounts
SET connection_id = (SELECT id FROM coinbase_connections WHERE coinbase_user_id = 'env')
WHERE connection_type = 'coinbase'
  AND connection_id IS NULL
  AND EXISTS (SELECT 1 FROM coinbase_connections WHERE coinbase_user_id = 'env');
