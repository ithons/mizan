-- Units on the transaction ledger.
--
-- transactions could record what a crypto trade COST but never what it BOUGHT. Coinbase hands us
-- both numbers on every order (filled_size / product_id) and every v2 ledger entry (amount.amount
-- / amount.currency), and both were parsed and thrown away at the INSERT. They are unrecoverable
-- once a row is written without them, which is why this lands ahead of anything that reads it.
--
-- NEITHER COLUMN IS MONEY. quantity is a unit count and security_id is an identifier, so both sit
-- outside services/money.ts's cents-in/dollars-out boundary and must never be passed through
-- toCents()/toDollars(). quantity stays REAL for the same reason holdings.institution_price does:
-- rounding 0.0031964 BTC to whole cents destroys it.
--
-- Sign convention: quantity is the signed change in units of security_id held by this account.
-- Positive means units arrived, negative means units left. For a trade that is the OPPOSITE of
-- amount's sign (a buy is money out, units in) and for a fiat move it is the same sign.
--
-- Both nullable, and NULL means "the units of this row are unknown" rather than zero. Every row
-- written before this migration is in that state, and so is every activity type this app does not
-- import at all (rewards, interest, incentives), which is a hole no backfill of existing rows can
-- close.
--
-- NOTHING DERIVES COST BASIS FROM THESE COLUMNS, and nothing should until the owner's
-- data/coinbase/*.csv history is imported and writes units of its own. The reasoning is recorded
-- at the capture site, above upsertCoinbaseTransaction in services/coinbase.ts.

ALTER TABLE transactions ADD COLUMN quantity REAL;
ALTER TABLE transactions ADD COLUMN security_id TEXT REFERENCES securities(id);

CREATE INDEX idx_transactions_security_id ON transactions(security_id);
