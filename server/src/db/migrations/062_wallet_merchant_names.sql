-- 'import_rule': the importer's own normalisation changed a stored provider value.
CREATE TABLE transaction_field_revisions_new (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  field TEXT NOT NULL CHECK(field IN ('date', 'amount', 'merchant_name')),
  from_value TEXT,
  to_value TEXT,
  from_source TEXT,
  to_source TEXT,
  origin TEXT NOT NULL CHECK(origin IN ('owner_edit', 'provider_revision', 'provider_rejected', 'import_rule')),
  created_at TEXT NOT NULL
);
INSERT INTO transaction_field_revisions_new SELECT * FROM transaction_field_revisions;
DROP TABLE transaction_field_revisions;
ALTER TABLE transaction_field_revisions_new RENAME TO transaction_field_revisions;
CREATE INDEX idx_txn_field_revisions_txn ON transaction_field_revisions(transaction_id, field, created_at);
CREATE INDEX idx_txn_field_revisions_origin ON transaction_field_revisions(origin, created_at);

INSERT INTO transaction_field_revisions
  (id, transaction_id, field, from_value, to_value, from_source, to_source, origin, created_at)
SELECT lower(hex(randomblob(16))), id, 'merchant_name', merchant_name,
       mizan_wallet_merchant(original_name), merchant_name_source, merchant_name_source,
       'import_rule', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM transactions
WHERE COALESCE(merchant_name_source, 'provider') = 'provider'
  AND mizan_has_wallet_tail(merchant_name) = 1
  AND mizan_wallet_merchant(original_name) IS NOT NULL;

UPDATE transactions
SET merchant_name = mizan_wallet_merchant(original_name),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE COALESCE(merchant_name_source, 'provider') = 'provider'
  AND mizan_has_wallet_tail(merchant_name) = 1
  AND mizan_wallet_merchant(original_name) IS NOT NULL;
