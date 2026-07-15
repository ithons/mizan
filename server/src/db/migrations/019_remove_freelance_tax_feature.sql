-- Remove the freelance/self-employment tax feature. The categories.taxable
-- (011) and goals.is_tax_envelope (012) columns backed a withholding workflow
-- that is out of scope for a single-user personal-finance app; no rows used it.
-- Neither column is indexed or referenced by a view/trigger, so a plain
-- DROP COLUMN (SQLite >= 3.35) is safe. Also clear the estimated_tax_rate
-- preference so no stale reader can resurrect it.
ALTER TABLE categories DROP COLUMN taxable;
ALTER TABLE goals DROP COLUMN is_tax_envelope;
DELETE FROM app_preferences WHERE key = 'estimated_tax_rate';
