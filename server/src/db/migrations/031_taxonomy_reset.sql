-- Taxonomy reset (from the full-data audit): carve out categories that were undifferentiated
-- catch-alls now that 3 years of history exist, and remove duplicate/wrongly-flagged buckets.

-- Five new leaves for spend classes that had no good home (all previously fell to a parent
-- bucket or stayed uncategorized).
INSERT OR IGNORE INTO categories (id, name, icon, color, parent_id, is_income, is_system, is_investment, sort_order) VALUES
  ('cat_sub_software',      'Software & AI Tools',  '🤖', '#e07070', 'cat_subscriptions', 0, 1, 0, 83),
  ('cat_ent_movies',        'Movies',               '🎬', '#e07070', 'cat_ent',           0, 1, 0, 64),
  ('cat_travel_intercity',  'Intercity Bus & Rail', '🚆', '#e07070', 'cat_travel',        0, 1, 0, 74),
  ('cat_travel_rental',     'Car Rental',           '🚗', '#e07070', 'cat_travel',        0, 1, 0, 75),
  ('cat_transport_share',   'Bike & Car Share',     '🚲', '#e07070', 'cat_transport',     0, 1, 0, 36);

-- Renames: Coffee also covers boba/tea; Hotels also covers campgrounds/lodging generally.
UPDATE categories SET name = 'Coffee & Tea' WHERE id = 'cat_food_coffee';
UPDATE categories SET name = 'Lodging'      WHERE id = 'cat_travel_hotels';

-- Folds: three redundant/wrongly-flagged buckets merged into their correct twin. Repoint every
-- reference (transactions, rules, budgets) BEFORE deleting so no foreign key dangles.
--   cat_income_xferin (is_income=1) was a duplicate of the neutral cat_xfer_in — and its
--   is_income flag is exactly what let card payments read as income.
--   cat_income_dividends folds into the investment-scoped cat_inv_dividend (dividends read as
--   both income and investment there).
--   cat_travel_vacation folds into the renamed Lodging.
UPDATE transactions   SET category_id = 'cat_xfer_in'      WHERE category_id = 'cat_income_xferin';
UPDATE merchant_rules SET category_id = 'cat_xfer_in'      WHERE category_id = 'cat_income_xferin';
UPDATE budgets        SET category_id = 'cat_xfer_in'      WHERE category_id = 'cat_income_xferin';

UPDATE transactions   SET category_id = 'cat_inv_dividend' WHERE category_id = 'cat_income_dividends';
UPDATE merchant_rules SET category_id = 'cat_inv_dividend' WHERE category_id = 'cat_income_dividends';
UPDATE budgets        SET category_id = 'cat_inv_dividend' WHERE category_id = 'cat_income_dividends';

UPDATE transactions   SET category_id = 'cat_travel_hotels' WHERE category_id = 'cat_travel_vacation';
UPDATE merchant_rules SET category_id = 'cat_travel_hotels' WHERE category_id = 'cat_travel_vacation';
UPDATE budgets        SET category_id = 'cat_travel_hotels' WHERE category_id = 'cat_travel_vacation';

DELETE FROM categories WHERE id IN ('cat_income_xferin', 'cat_income_dividends', 'cat_travel_vacation');
