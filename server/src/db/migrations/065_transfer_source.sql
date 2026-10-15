ALTER TABLE transactions ADD COLUMN transfer_source TEXT
  CHECK (transfer_source IS NULL OR transfer_source IN ('auto', 'owner'));

UPDATE transactions SET transfer_source = 'owner' WHERE transfer_status = 'confirmed';
