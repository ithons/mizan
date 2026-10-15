INSERT INTO transaction_field_revisions
  (id, transaction_id, field, from_value, to_value, from_source, to_source, origin, created_at)
SELECT lower(hex(randomblob(16))), id, 'amount', CAST(amount AS TEXT), CAST(-amount AS TEXT),
       COALESCE(amount_source, 'provider'), COALESCE(amount_source, 'provider'),
       'import_rule', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM transactions
WHERE source_type = 'simplefin'
  AND COALESCE(amount_source, 'provider') = 'provider'
  AND amount <> 0
  AND mizan_descriptor_direction(original_name) <> 0
  AND mizan_descriptor_direction(original_name) <> (CASE WHEN amount > 0 THEN 1 ELSE -1 END);

UPDATE transactions
SET amount = -amount,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE source_type = 'simplefin'
  AND COALESCE(amount_source, 'provider') = 'provider'
  AND amount <> 0
  AND mizan_descriptor_direction(original_name) <> 0
  AND mizan_descriptor_direction(original_name) <> (CASE WHEN amount > 0 THEN 1 ELSE -1 END);
