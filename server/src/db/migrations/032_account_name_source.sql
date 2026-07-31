-- Durable custom account names. Renaming already works (PATCH /api/accounts/:id), but
-- syncSimplefin() overwrites account_name from the provider payload every sync, reverting any
-- manual rename. Mirror the type_source pattern (migration 015): mark a name as user-owned so
-- sync leaves it alone.
ALTER TABLE accounts ADD COLUMN name_source TEXT NOT NULL DEFAULT 'auto';

-- Non-SimpleFIN accounts (Coinbase, manual) already keep their names (sync never rewrites them),
-- so treat their names as user-owned from the start, matching how 015 seeded type_source.
UPDATE accounts SET name_source = 'manual' WHERE connection_type <> 'simplefin';
