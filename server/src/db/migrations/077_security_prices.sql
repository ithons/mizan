CREATE TABLE security_prices (
  security_id TEXT NOT NULL REFERENCES securities(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  close REAL NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('coinbase_exchange', 'yahoo')),
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (security_id, date)
);
