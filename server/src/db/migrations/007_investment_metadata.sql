ALTER TABLE holdings ADD COLUMN manual_cost_basis REAL;
ALTER TABLE holdings ADD COLUMN manual_cost_basis_note TEXT;
ALTER TABLE holdings ADD COLUMN manual_cost_basis_updated_at TEXT;

ALTER TABLE securities ADD COLUMN sector TEXT;
ALTER TABLE securities ADD COLUMN sector_source TEXT;
