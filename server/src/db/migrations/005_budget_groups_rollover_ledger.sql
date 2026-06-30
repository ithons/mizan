CREATE TABLE IF NOT EXISTS budget_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS budget_group_members (
  group_id TEXT NOT NULL REFERENCES budget_groups(id) ON DELETE CASCADE,
  category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (group_id, category_id),
  UNIQUE(category_id)
);

CREATE TABLE IF NOT EXISTS budget_rollover_ledger (
  id TEXT PRIMARY KEY,
  budget_id TEXT NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  starting_rollover REAL NOT NULL,
  budget_amount REAL NOT NULL,
  actual_spend REAL NOT NULL,
  ending_rollover REAL NOT NULL,
  calculated_at TEXT NOT NULL,
  UNIQUE(budget_id, month)
);

CREATE INDEX IF NOT EXISTS idx_budget_group_members_category ON budget_group_members(category_id);
CREATE INDEX IF NOT EXISTS idx_budget_rollover_ledger_budget ON budget_rollover_ledger(budget_id, month);
