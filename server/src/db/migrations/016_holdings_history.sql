CREATE TABLE IF NOT EXISTS holdings_history (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  security_id TEXT NOT NULL REFERENCES securities(id),
  date TEXT NOT NULL,
  quantity REAL NOT NULL,
  institution_price REAL NOT NULL,
  institution_value REAL NOT NULL,
  cost_basis REAL,
  created_at TEXT NOT NULL,
  UNIQUE(account_id, security_id, date)
);

CREATE INDEX IF NOT EXISTS idx_holdings_history_security_date ON holdings_history(security_id, date);
