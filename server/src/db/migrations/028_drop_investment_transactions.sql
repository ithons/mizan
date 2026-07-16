-- Remove the unused investment_transactions table. No production code ever wrote it
-- (0 rows; only migration rebuilds referenced it), no view rendered it, and crypto
-- trades already land as regular transactions (cat_crypto_buy/sell). Holdings and
-- portfolio value are unaffected. Code references are removed in the same change.
DROP TABLE IF EXISTS investment_transactions;
