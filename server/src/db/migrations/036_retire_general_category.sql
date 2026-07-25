-- "Shopping / General" was a catch-all, and catch-alls hide spending rather than describe it: 80
-- transactions had accumulated there, including ~$3,500 of outdoor gear (REI, Dick's, Sportsman's
-- Warehouse, Zion Outfitter) that looked like undifferentiated "shopping" on every report.
--
-- These replacements are derived from what was actually sitting in General, not invented up front.
-- Colors match each new category's parent so the existing report palette still reads as one system.

INSERT OR IGNORE INTO categories (id, name, icon, color, parent_id, is_income, is_system, is_investment, sort_order) VALUES
  -- The single largest cluster in General by spend.
  ('cat_shop_outdoors',  'Outdoors & Sporting Goods', '🏕️', '#e07070', 'cat_shop', 0, 1, 0, 24),
  -- Target / Walmart / Dollar General / convenience stores: genuinely general merchandise, but
  -- naming it "everyday" says what it is instead of acting as a dumping ground.
  ('cat_shop_household', 'Household & Everyday',      '🧺', '#e07070', 'cat_shop', 0, 1, 0, 25),
  ('cat_shop_smoke',     'Smoke & Vape',              '🚬', '#e07070', 'cat_shop', 0, 1, 0, 26),
  -- USPS / FedEx Office / UPS Store / Sticker Mule.
  ('cat_shop_shipping',  'Shipping & Printing',       '📦', '#e07070', 'cat_shop', 0, 1, 0, 27),
  -- Records, comics, artist merch, film developing, museum and gift shops.
  ('cat_shop_hobbies',   'Hobbies & Collectibles',    '🎨', '#e07070', 'cat_shop', 0, 1, 0, 28),
  -- Wine clubs and liquor stores are not "Bars" (going out) and not "Groceries".
  ('cat_food_alcohol',   'Liquor & Wine',             '🍷', '#c17f59', 'cat_food', 0, 1, 0, 6);

-- Retire the catch-all itself. On an existing install the rows were already rehomed by an audited
-- one-off pass before this ran; this reassignment is the safety net for any install where rows are
-- still pointing at it, so the DELETE can never orphan a transaction.
UPDATE transactions SET category_id = 'cat_shop_household' WHERE category_id = 'cat_shop_general';
UPDATE merchant_rules SET category_id = 'cat_shop_household' WHERE category_id = 'cat_shop_general';
UPDATE budgets SET category_id = 'cat_shop_household' WHERE category_id = 'cat_shop_general';
UPDATE recurring_patterns SET category_id = 'cat_shop_household' WHERE category_id = 'cat_shop_general';

DELETE FROM categories WHERE id = 'cat_shop_general';
