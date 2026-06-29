-- Goals connected to real account balances.
CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('savings','debt')),
  target_amount REAL NOT NULL CHECK(target_amount > 0),
  current_amount REAL NOT NULL DEFAULT 0 CHECK(current_amount >= 0),
  starting_amount REAL,
  account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  target_date TEXT,
  color TEXT,
  is_archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_goals_account_id ON goals(account_id);
CREATE INDEX IF NOT EXISTS idx_goals_is_archived ON goals(is_archived);
