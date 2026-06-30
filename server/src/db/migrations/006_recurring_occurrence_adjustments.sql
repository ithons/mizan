CREATE TABLE IF NOT EXISTS recurring_occurrence_adjustments (
  id TEXT PRIMARY KEY,
  recurring_id TEXT NOT NULL REFERENCES recurring_patterns(id) ON DELETE CASCADE,
  original_date TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('skip','snooze','adjust')),
  adjusted_date TEXT,
  adjusted_amount REAL,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(recurring_id, original_date)
);

CREATE INDEX IF NOT EXISTS idx_recurring_occurrence_adjustments_pattern
  ON recurring_occurrence_adjustments(recurring_id, original_date);
