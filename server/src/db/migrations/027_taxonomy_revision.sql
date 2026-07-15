-- Taxonomy tidy-up. Two categories were created at runtime with UUID ids and one with a
-- lowercase name ('toll'); normalize the casing. Then fill a few common gaps with stable
-- cat_* ids so rules and code can reference them. INSERT OR IGNORE keeps this safe on a
-- fresh DB and on re-run. The hardcoded transfer ids that transactionIntegrity.ts and the
-- text heuristic depend on are left untouched.
UPDATE categories SET name = 'Toll' WHERE name = 'toll';

INSERT OR IGNORE INTO categories (id, name, color, parent_id, is_income, is_investment, sort_order) VALUES
  ('cat_food_delivery',  'Delivery',          '#e0803f', 'cat_food', 0, 0, 60),
  ('cat_pets',           'Pets',              '#9c7b4f', NULL,       0, 0, 60),
  ('cat_fees',           'Fees & Charges',    '#a05c5c', NULL,       0, 0, 61),
  ('cat_gifts',          'Gifts & Donations', '#7c6ea6', NULL,       0, 0, 62);
