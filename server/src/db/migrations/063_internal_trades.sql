ALTER TABLE transactions ADD COLUMN is_internal_trade INTEGER NOT NULL DEFAULT 0
  CHECK (is_internal_trade IN (0, 1));

UPDATE transactions SET is_internal_trade = 1 WHERE mizan_is_internal_trade(original_name) = 1;
