-- Credit limit for credit card accounts (captured from Plaid balances.limit)
ALTER TABLE accounts ADD COLUMN credit_limit REAL;

-- Net worth snapshot breakdown by asset type
ALTER TABLE net_worth_snapshots ADD COLUMN liquid_assets REAL;
ALTER TABLE net_worth_snapshots ADD COLUMN investment_assets REAL;
ALTER TABLE net_worth_snapshots ADD COLUMN crypto_assets REAL;
