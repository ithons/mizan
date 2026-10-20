CREATE TABLE account_valuations (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  value_cents INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('statement')),
  note TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (account_id, date)
);
