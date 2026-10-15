ALTER TABLE transactions ADD COLUMN refund_of_id TEXT REFERENCES transactions(id) ON DELETE SET NULL;
ALTER TABLE transactions ADD COLUMN refund_link_source TEXT
  CHECK (refund_link_source IS NULL OR refund_link_source IN ('auto', 'owner', 'rejected'));
CREATE INDEX idx_transactions_refund_of_id ON transactions(refund_of_id);
