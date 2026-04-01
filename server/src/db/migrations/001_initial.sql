-- Schema migrations tracking
CREATE TABLE IF NOT EXISTS schema_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  applied_at TEXT NOT NULL
);

-- Accounts
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  plaid_account_id TEXT UNIQUE,
  coinbase_account_id TEXT UNIQUE,
  connection_id TEXT,
  connection_type TEXT NOT NULL CHECK(connection_type IN ('plaid','coinbase','manual')),
  institution_name TEXT NOT NULL DEFAULT '',
  account_name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('checking','savings','credit','brokerage','ira_traditional','ira_roth','crypto_wallet','cash','other')),
  subtype TEXT,
  mask TEXT,
  current_balance REAL NOT NULL DEFAULT 0,
  available_balance REAL,
  currency TEXT NOT NULL DEFAULT 'USD',
  native_currency TEXT,
  native_balance REAL,
  is_manual INTEGER NOT NULL DEFAULT 0,
  is_hidden INTEGER NOT NULL DEFAULT 0,
  is_liability INTEGER NOT NULL DEFAULT 0,
  color TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Categories
CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  icon TEXT,
  color TEXT,
  parent_id TEXT REFERENCES categories(id),
  is_income INTEGER NOT NULL DEFAULT 0,
  is_system INTEGER NOT NULL DEFAULT 1,
  is_investment INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- Transactions
CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  plaid_transaction_id TEXT UNIQUE,
  coinbase_transaction_id TEXT UNIQUE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  amount REAL NOT NULL,
  merchant_name TEXT,
  original_name TEXT NOT NULL DEFAULT '',
  category_id TEXT REFERENCES categories(id),
  pending INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  is_manual INTEGER NOT NULL DEFAULT 0,
  recurring_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_transactions_account_id ON transactions(account_id);
CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date);
CREATE INDEX IF NOT EXISTS idx_transactions_category_id ON transactions(category_id);

-- Securities
CREATE TABLE IF NOT EXISTS securities (
  id TEXT PRIMARY KEY,
  plaid_security_id TEXT UNIQUE,
  ticker TEXT,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('equity','etf','mutual_fund','crypto','cash','other')),
  currency TEXT NOT NULL DEFAULT 'USD'
);

-- Holdings
CREATE TABLE IF NOT EXISTS holdings (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  security_id TEXT NOT NULL REFERENCES securities(id),
  quantity REAL NOT NULL,
  institution_price REAL NOT NULL,
  institution_value REAL NOT NULL,
  cost_basis REAL,
  currency TEXT NOT NULL DEFAULT 'USD',
  updated_at TEXT NOT NULL,
  UNIQUE(account_id, security_id)
);

-- Investment transactions
CREATE TABLE IF NOT EXISTS investment_transactions (
  id TEXT PRIMARY KEY,
  plaid_investment_transaction_id TEXT UNIQUE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('buy','sell','dividend','transfer','fee','other')),
  security_id TEXT REFERENCES securities(id),
  quantity REAL,
  price REAL,
  amount REAL NOT NULL,
  fees REAL,
  name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_inv_tx_account_id ON investment_transactions(account_id);

-- Budgets
CREATE TABLE IF NOT EXISTS budgets (
  id TEXT PRIMARY KEY,
  category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  amount REAL NOT NULL,
  period TEXT NOT NULL DEFAULT 'monthly',
  rollover INTEGER NOT NULL DEFAULT 0,
  rollover_balance REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(category_id, period)
);

-- Recurring patterns
CREATE TABLE IF NOT EXISTS recurring_patterns (
  id TEXT PRIMARY KEY,
  merchant_name TEXT NOT NULL,
  category_id TEXT REFERENCES categories(id),
  average_amount REAL NOT NULL,
  frequency TEXT NOT NULL CHECK(frequency IN ('weekly','biweekly','monthly','quarterly','annual')),
  last_seen TEXT NOT NULL,
  next_expected TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  is_confirmed INTEGER NOT NULL DEFAULT 0,
  transaction_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(merchant_name)
);

-- Merchant rules
CREATE TABLE IF NOT EXISTS merchant_rules (
  id TEXT PRIMARY KEY,
  pattern TEXT NOT NULL,
  category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);

-- Plaid items
CREATE TABLE IF NOT EXISTS plaid_items (
  id TEXT PRIMARY KEY,
  item_id TEXT UNIQUE NOT NULL,
  institution_id TEXT,
  institution_name TEXT NOT NULL DEFAULT '',
  cursor TEXT,
  last_synced_at TEXT,
  products TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);

-- Coinbase connections
CREATE TABLE IF NOT EXISTS coinbase_connections (
  id TEXT PRIMARY KEY,
  coinbase_user_id TEXT UNIQUE NOT NULL,
  display_name TEXT,
  last_synced_at TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);

-- Net worth snapshots
CREATE TABLE IF NOT EXISTS net_worth_snapshots (
  id TEXT PRIMARY KEY,
  date TEXT UNIQUE NOT NULL,
  total_assets REAL NOT NULL,
  total_liabilities REAL NOT NULL,
  net_worth REAL NOT NULL,
  breakdown TEXT NOT NULL,
  is_estimated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- ─────────────────────────────────────────────────────────────
-- SEED: system categories
-- ─────────────────────────────────────────────────────────────
INSERT OR IGNORE INTO categories (id, name, icon, color, parent_id, is_income, is_system, is_investment, sort_order) VALUES
  -- Income (leaf items)
  ('cat_income_paycheck',   'Paycheck',         '💼', '#4ecba3', NULL,                 1, 1, 0, 100),
  ('cat_income_freelance',  'Freelance',        '🛠', '#4ecba3', NULL,                 1, 1, 0, 101),
  ('cat_income_dividends',  'Dividends',        '📈', '#4ecba3', NULL,                 1, 1, 0, 102),
  ('cat_income_interest',   'Interest',         '🏦', '#4ecba3', NULL,                 1, 1, 0, 103),
  ('cat_income_xferin',     'Transfers In',     '↙',  '#4ecba3', NULL,                 1, 1, 0, 104),
  ('cat_income_other',      'Other Income',     '💰', '#4ecba3', NULL,                 1, 1, 0, 105),

  -- Food & Drink (parent)
  ('cat_food',              'Food & Drink',     '🍔', '#e07070', NULL,                 0, 1, 0,  10),
  ('cat_food_restaurants',  'Restaurants',      '🍽', '#e07070', 'cat_food',           0, 1, 0,  11),
  ('cat_food_coffee',       'Coffee',           '☕', '#e07070', 'cat_food',           0, 1, 0,  12),
  ('cat_food_groceries',    'Groceries',        '🛒', '#e07070', 'cat_food',           0, 1, 0,  13),
  ('cat_food_bars',         'Bars',             '🍺', '#e07070', 'cat_food',           0, 1, 0,  14),

  -- Shopping (parent)
  ('cat_shop',              'Shopping',         '🛍', '#e07070', NULL,                 0, 1, 0,  20),
  ('cat_shop_clothing',     'Clothing',         '👗', '#e07070', 'cat_shop',           0, 1, 0,  21),
  ('cat_shop_electronics',  'Electronics',      '💻', '#e07070', 'cat_shop',           0, 1, 0,  22),
  ('cat_shop_amazon',       'Amazon',           '📦', '#e07070', 'cat_shop',           0, 1, 0,  23),
  ('cat_shop_general',      'General',          '🏪', '#e07070', 'cat_shop',           0, 1, 0,  24),

  -- Transport (parent)
  ('cat_transport',         'Transport',        '🚗', '#e07070', NULL,                 0, 1, 0,  30),
  ('cat_transport_gas',     'Gas',              '⛽', '#e07070', 'cat_transport',      0, 1, 0,  31),
  ('cat_transport_parking', 'Parking',          '🅿', '#e07070', 'cat_transport',      0, 1, 0,  32),
  ('cat_transport_ride',    'Rideshare',        '🚕', '#e07070', 'cat_transport',      0, 1, 0,  33),
  ('cat_transport_transit', 'Public Transit',   '🚌', '#e07070', 'cat_transport',      0, 1, 0,  34),
  ('cat_transport_auto',    'Auto Payment',     '🚘', '#e07070', 'cat_transport',      0, 1, 0,  35),

  -- Home (parent)
  ('cat_home',              'Home',             '🏠', '#e07070', NULL,                 0, 1, 0,  40),
  ('cat_home_rent',         'Rent',             '🏡', '#e07070', 'cat_home',           0, 1, 0,  41),
  ('cat_home_utilities',    'Utilities',        '💡', '#e07070', 'cat_home',           0, 1, 0,  42),
  ('cat_home_internet',     'Internet',         '📡', '#e07070', 'cat_home',           0, 1, 0,  43),
  ('cat_home_phone',        'Phone',            '📱', '#e07070', 'cat_home',           0, 1, 0,  44),

  -- Health (parent)
  ('cat_health',            'Health',           '❤️', '#e07070', NULL,                 0, 1, 0,  50),
  ('cat_health_medical',    'Medical',          '🏥', '#e07070', 'cat_health',         0, 1, 0,  51),
  ('cat_health_pharmacy',   'Pharmacy',         '💊', '#e07070', 'cat_health',         0, 1, 0,  52),
  ('cat_health_fitness',    'Fitness',          '🏋', '#e07070', 'cat_health',         0, 1, 0,  53),

  -- Entertainment (parent)
  ('cat_ent',               'Entertainment',    '🎬', '#e07070', NULL,                 0, 1, 0,  60),
  ('cat_ent_streaming',     'Streaming',        '📺', '#e07070', 'cat_ent',            0, 1, 0,  61),
  ('cat_ent_events',        'Events',           '🎟', '#e07070', 'cat_ent',            0, 1, 0,  62),
  ('cat_ent_games',         'Games',            '🎮', '#e07070', 'cat_ent',            0, 1, 0,  63),

  -- Travel (parent)
  ('cat_travel',            'Travel',           '✈️', '#e07070', NULL,                 0, 1, 0,  70),
  ('cat_travel_flights',    'Flights',          '🛫', '#e07070', 'cat_travel',         0, 1, 0,  71),
  ('cat_travel_hotels',     'Hotels',           '🏨', '#e07070', 'cat_travel',         0, 1, 0,  72),
  ('cat_travel_vacation',   'Vacation',         '🌴', '#e07070', 'cat_travel',         0, 1, 0,  73),

  -- Leaf categories
  ('cat_subscriptions',     'Subscriptions',    '🔄', '#e07070', NULL,                 0, 1, 0,  80),
  ('cat_education',         'Education',        '📚', '#e07070', NULL,                 0, 1, 0,  81),
  ('cat_personal_care',     'Personal Care',    '🪥', '#e07070', NULL,                 0, 1, 0,  82),

  -- Investments (parent)
  ('cat_inv',               'Investments',      '📊', '#5b8dee', NULL,                 0, 1, 1,  90),
  ('cat_inv_buy',           'Buy',              '📈', '#5b8dee', 'cat_inv',            0, 1, 1,  91),
  ('cat_inv_sell',          'Sell',             '📉', '#5b8dee', 'cat_inv',            0, 1, 1,  92),
  ('cat_inv_dividend',      'Dividend',         '💵', '#5b8dee', 'cat_inv',            1, 1, 1,  93),
  ('cat_inv_fee',           'Fee',              '💸', '#5b8dee', 'cat_inv',            0, 1, 1,  94),
  ('cat_inv_transfer',      'Investment Transfer','↔', '#5b8dee', 'cat_inv',           0, 1, 1,  95),

  -- Transfers (parent)
  ('cat_xfer',              'Transfers',        '↔',  '#6b6b7a', NULL,                 0, 1, 0, 200),
  ('cat_xfer_out',          'Transfer Out',     '↗',  '#6b6b7a', 'cat_xfer',           0, 1, 0, 201),
  ('cat_xfer_in',           'Transfer In',      '↙',  '#6b6b7a', 'cat_xfer',           0, 1, 0, 202),
  ('cat_xfer_cc',           'Credit Card Payment','💳','#6b6b7a', 'cat_xfer',          0, 1, 0, 203),

  -- Crypto (parent)
  ('cat_crypto',            'Crypto',           '₿',  '#d4a44c', NULL,                 0, 1, 0, 210),
  ('cat_crypto_buy',        'Crypto Buy',       '📈', '#d4a44c', 'cat_crypto',         0, 1, 0, 211),
  ('cat_crypto_sell',       'Crypto Sell',      '📉', '#d4a44c', 'cat_crypto',         0, 1, 0, 212),
  ('cat_crypto_reward',     'Crypto Reward',    '🎁', '#d4a44c', 'cat_crypto',         1, 1, 0, 213),
  ('cat_crypto_fee',        'Crypto Fee',       '💸', '#d4a44c', 'cat_crypto',         0, 1, 0, 214);
