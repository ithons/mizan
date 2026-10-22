CREATE TABLE expected_lumps (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  merchant_key TEXT NOT NULL,
  amount_low_cents INTEGER NOT NULL CHECK (amount_low_cents > 0),
  amount_high_cents INTEGER NOT NULL CHECK (amount_high_cents >= amount_low_cents),
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL CHECK (window_end >= window_start),
  last_occurrence TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'confirmed', 'dismissed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  confirmed_at TEXT
);
CREATE INDEX idx_expected_lumps_status ON expected_lumps(status);
