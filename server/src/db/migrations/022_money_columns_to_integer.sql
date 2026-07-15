-- Enforce the integer-cents invariant at the schema level. Migration 018 converted
-- every money VALUE to integer cents, but the columns are still declared REAL, so the
-- "integer cents" rule lives only in services/money.ts and nothing at the DB level
-- rejects a fractional write. This migration redeclares money columns as INTEGER via
-- the standard create-new/copy/drop/rename rebuild (see 014). It changes affinity only:
-- the stored values are already exact integer cents, so INSERT..SELECT stores them as
-- integers with no arithmetic.
--
-- Per-unit PRICE columns (holdings/holdings_history.institution_price,
-- investment_transactions.price) and QUANTITY columns
-- (holdings*.quantity, investment_transactions.quantity, accounts.native_balance) are
-- legitimately fractional and STAY REAL. net_worth_snapshots.breakdown is a JSON blob of
-- cents and stays TEXT.
--
-- foreign_keys is already OFF for the duration of the migration (runMigrations), and
-- foreign_key_check runs before COMMIT, so rebuild order is free. Explicit column lists
-- (not SELECT *) keep this correct across columns appended by later migrations
-- (accounts.type_source, net_worth_snapshots.*_assets, holdings.manual_cost_basis*).

-- accounts: current_balance, available_balance, credit_limit -> INTEGER (native_balance stays REAL)
CREATE TABLE accounts_new (
  id TEXT PRIMARY KEY,
  simplefin_account_id TEXT UNIQUE,
  coinbase_account_id TEXT UNIQUE,
  connection_id TEXT,
  connection_type TEXT NOT NULL CHECK(connection_type IN ('coinbase','simplefin','manual')),
  institution_name TEXT NOT NULL DEFAULT '',
  account_name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('checking','savings','credit','brokerage','ira_traditional','ira_roth','crypto_wallet','cash','other')),
  subtype TEXT,
  mask TEXT,
  current_balance INTEGER NOT NULL DEFAULT 0,
  available_balance INTEGER,
  credit_limit INTEGER,
  currency TEXT NOT NULL DEFAULT 'USD',
  native_currency TEXT,
  native_balance REAL,
  is_manual INTEGER NOT NULL DEFAULT 0,
  is_hidden INTEGER NOT NULL DEFAULT 0,
  is_liability INTEGER NOT NULL DEFAULT 0,
  color TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  type_source TEXT NOT NULL DEFAULT 'auto'
);
INSERT INTO accounts_new (
  id, simplefin_account_id, coinbase_account_id, connection_id, connection_type,
  institution_name, account_name, type, subtype, mask, current_balance, available_balance,
  credit_limit, currency, native_currency, native_balance, is_manual, is_hidden, is_liability,
  color, sort_order, created_at, updated_at, type_source
) SELECT
  id, simplefin_account_id, coinbase_account_id, connection_id, connection_type,
  institution_name, account_name, type, subtype, mask, current_balance, available_balance,
  credit_limit, currency, native_currency, native_balance, is_manual, is_hidden, is_liability,
  color, sort_order, created_at, updated_at, type_source
FROM accounts;
DROP TABLE accounts;
ALTER TABLE accounts_new RENAME TO accounts;

-- transactions: amount -> INTEGER
CREATE TABLE transactions_new (
  id TEXT PRIMARY KEY,
  simplefin_transaction_id TEXT UNIQUE,
  coinbase_transaction_id TEXT UNIQUE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  amount INTEGER NOT NULL,
  merchant_name TEXT,
  original_name TEXT NOT NULL DEFAULT '',
  category_id TEXT REFERENCES categories(id),
  pending INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  is_manual INTEGER NOT NULL DEFAULT 0,
  recurring_id TEXT,
  duplicate_group_id TEXT,
  duplicate_status TEXT NOT NULL DEFAULT 'none',
  transfer_pair_id TEXT,
  transfer_status TEXT NOT NULL DEFAULT 'none',
  review_status TEXT NOT NULL DEFAULT 'open',
  source_type TEXT NOT NULL DEFAULT 'manual' CHECK(source_type IN ('coinbase','simplefin','manual','import')),
  source_detail TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO transactions_new (
  id, simplefin_transaction_id, coinbase_transaction_id, account_id, date, amount, merchant_name,
  original_name, category_id, pending, notes, is_manual, recurring_id,
  duplicate_group_id, duplicate_status, transfer_pair_id, transfer_status, review_status,
  source_type, source_detail, created_at, updated_at
) SELECT
  id, simplefin_transaction_id, coinbase_transaction_id, account_id, date, amount, merchant_name,
  original_name, category_id, pending, notes, is_manual, recurring_id,
  duplicate_group_id, duplicate_status, transfer_pair_id, transfer_status, review_status,
  source_type, source_detail, created_at, updated_at
FROM transactions;
DROP TABLE transactions;
ALTER TABLE transactions_new RENAME TO transactions;
CREATE INDEX idx_transactions_account_id ON transactions(account_id);
CREATE INDEX idx_transactions_date ON transactions(date);
CREATE INDEX idx_transactions_category_id ON transactions(category_id);
CREATE INDEX idx_transactions_duplicate_group_id ON transactions(duplicate_group_id);
CREATE INDEX idx_transactions_transfer_pair_id ON transactions(transfer_pair_id);
CREATE INDEX idx_transactions_review_status ON transactions(review_status);

-- budgets: amount, rollover_balance -> INTEGER
CREATE TABLE budgets_new (
  id TEXT PRIMARY KEY,
  category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL,
  period TEXT NOT NULL DEFAULT 'monthly',
  rollover INTEGER NOT NULL DEFAULT 0,
  rollover_balance INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(category_id, period)
);
INSERT INTO budgets_new (id, category_id, amount, period, rollover, rollover_balance, created_at, updated_at)
SELECT id, category_id, amount, period, rollover, rollover_balance, created_at, updated_at FROM budgets;
DROP TABLE budgets;
ALTER TABLE budgets_new RENAME TO budgets;

-- goals: target_amount, current_amount, starting_amount -> INTEGER
CREATE TABLE goals_new (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('savings','debt')),
  target_amount INTEGER NOT NULL CHECK(target_amount > 0),
  current_amount INTEGER NOT NULL DEFAULT 0 CHECK(current_amount >= 0),
  starting_amount INTEGER,
  account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  target_date TEXT,
  color TEXT,
  is_archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO goals_new (
  id, name, type, target_amount, current_amount, starting_amount, account_id,
  target_date, color, is_archived, created_at, updated_at
) SELECT
  id, name, type, target_amount, current_amount, starting_amount, account_id,
  target_date, color, is_archived, created_at, updated_at
FROM goals;
DROP TABLE goals;
ALTER TABLE goals_new RENAME TO goals;
CREATE INDEX idx_goals_account_id ON goals(account_id);
CREATE INDEX idx_goals_is_archived ON goals(is_archived);

-- recurring_patterns: average_amount -> INTEGER
CREATE TABLE recurring_patterns_new (
  id TEXT PRIMARY KEY,
  merchant_name TEXT NOT NULL,
  category_id TEXT REFERENCES categories(id),
  average_amount INTEGER NOT NULL,
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
INSERT INTO recurring_patterns_new (
  id, merchant_name, category_id, average_amount, frequency, last_seen, next_expected,
  is_active, is_confirmed, transaction_count, created_at, updated_at
) SELECT
  id, merchant_name, category_id, average_amount, frequency, last_seen, next_expected,
  is_active, is_confirmed, transaction_count, created_at, updated_at
FROM recurring_patterns;
DROP TABLE recurring_patterns;
ALTER TABLE recurring_patterns_new RENAME TO recurring_patterns;

-- recurring_occurrence_adjustments: adjusted_amount -> INTEGER
CREATE TABLE recurring_occurrence_adjustments_new (
  id TEXT PRIMARY KEY,
  recurring_id TEXT NOT NULL REFERENCES recurring_patterns(id) ON DELETE CASCADE,
  original_date TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('skip','snooze','adjust')),
  adjusted_date TEXT,
  adjusted_amount INTEGER,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(recurring_id, original_date)
);
INSERT INTO recurring_occurrence_adjustments_new (
  id, recurring_id, original_date, action, adjusted_date, adjusted_amount, note, created_at, updated_at
) SELECT
  id, recurring_id, original_date, action, adjusted_date, adjusted_amount, note, created_at, updated_at
FROM recurring_occurrence_adjustments;
DROP TABLE recurring_occurrence_adjustments;
ALTER TABLE recurring_occurrence_adjustments_new RENAME TO recurring_occurrence_adjustments;
CREATE INDEX idx_recurring_occurrence_adjustments_pattern
  ON recurring_occurrence_adjustments(recurring_id, original_date);

-- net_worth_snapshots: all totals + *_assets -> INTEGER (breakdown stays TEXT/JSON)
CREATE TABLE net_worth_snapshots_new (
  id TEXT PRIMARY KEY,
  date TEXT UNIQUE NOT NULL,
  total_assets INTEGER NOT NULL,
  total_liabilities INTEGER NOT NULL,
  net_worth INTEGER NOT NULL,
  breakdown TEXT NOT NULL,
  is_estimated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  liquid_assets INTEGER,
  investment_assets INTEGER,
  crypto_assets INTEGER
);
INSERT INTO net_worth_snapshots_new (
  id, date, total_assets, total_liabilities, net_worth, breakdown, is_estimated, created_at,
  liquid_assets, investment_assets, crypto_assets
) SELECT
  id, date, total_assets, total_liabilities, net_worth, breakdown, is_estimated, created_at,
  liquid_assets, investment_assets, crypto_assets
FROM net_worth_snapshots;
DROP TABLE net_worth_snapshots;
ALTER TABLE net_worth_snapshots_new RENAME TO net_worth_snapshots;

-- holdings: institution_value, cost_basis, manual_cost_basis -> INTEGER (price, quantity stay REAL)
CREATE TABLE holdings_new (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  security_id TEXT NOT NULL REFERENCES securities(id),
  quantity REAL NOT NULL,
  institution_price REAL NOT NULL,
  institution_value INTEGER NOT NULL,
  cost_basis INTEGER,
  currency TEXT NOT NULL DEFAULT 'USD',
  updated_at TEXT NOT NULL,
  manual_cost_basis INTEGER,
  manual_cost_basis_note TEXT,
  manual_cost_basis_updated_at TEXT,
  UNIQUE(account_id, security_id)
);
INSERT INTO holdings_new (
  id, account_id, security_id, quantity, institution_price, institution_value, cost_basis,
  currency, updated_at, manual_cost_basis, manual_cost_basis_note, manual_cost_basis_updated_at
) SELECT
  id, account_id, security_id, quantity, institution_price, institution_value, cost_basis,
  currency, updated_at, manual_cost_basis, manual_cost_basis_note, manual_cost_basis_updated_at
FROM holdings;
DROP TABLE holdings;
ALTER TABLE holdings_new RENAME TO holdings;

-- holdings_history: institution_value, cost_basis -> INTEGER (price, quantity stay REAL)
CREATE TABLE holdings_history_new (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  security_id TEXT NOT NULL REFERENCES securities(id),
  date TEXT NOT NULL,
  quantity REAL NOT NULL,
  institution_price REAL NOT NULL,
  institution_value INTEGER NOT NULL,
  cost_basis INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE(account_id, security_id, date)
);
INSERT INTO holdings_history_new (
  id, account_id, security_id, date, quantity, institution_price, institution_value, cost_basis, created_at
) SELECT
  id, account_id, security_id, date, quantity, institution_price, institution_value, cost_basis, created_at
FROM holdings_history;
DROP TABLE holdings_history;
ALTER TABLE holdings_history_new RENAME TO holdings_history;
CREATE INDEX idx_holdings_history_security_date ON holdings_history(security_id, date);

-- investment_transactions: amount, fees -> INTEGER (price, quantity stay REAL)
CREATE TABLE investment_transactions_new (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('buy','sell','dividend','transfer','fee','other')),
  security_id TEXT REFERENCES securities(id),
  quantity REAL,
  price REAL,
  amount INTEGER NOT NULL,
  fees INTEGER,
  name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
INSERT INTO investment_transactions_new (
  id, account_id, date, type, security_id, quantity, price, amount, fees, name, created_at
) SELECT
  id, account_id, date, type, security_id, quantity, price, amount, fees, name, created_at
FROM investment_transactions;
DROP TABLE investment_transactions;
ALTER TABLE investment_transactions_new RENAME TO investment_transactions;
CREATE INDEX idx_inv_tx_account_id ON investment_transactions(account_id);

-- budget_rollover_ledger: all money -> INTEGER
CREATE TABLE budget_rollover_ledger_new (
  id TEXT PRIMARY KEY,
  budget_id TEXT NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  starting_rollover INTEGER NOT NULL,
  budget_amount INTEGER NOT NULL,
  actual_spend INTEGER NOT NULL,
  ending_rollover INTEGER NOT NULL,
  calculated_at TEXT NOT NULL,
  UNIQUE(budget_id, month)
);
INSERT INTO budget_rollover_ledger_new (
  id, budget_id, month, starting_rollover, budget_amount, actual_spend, ending_rollover, calculated_at
) SELECT
  id, budget_id, month, starting_rollover, budget_amount, actual_spend, ending_rollover, calculated_at
FROM budget_rollover_ledger;
DROP TABLE budget_rollover_ledger;
ALTER TABLE budget_rollover_ledger_new RENAME TO budget_rollover_ledger;
CREATE INDEX idx_budget_rollover_ledger_budget ON budget_rollover_ledger(budget_id, month);
