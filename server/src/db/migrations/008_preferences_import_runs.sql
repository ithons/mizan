CREATE TABLE IF NOT EXISTS app_preferences (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS data_import_runs (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK(source IN ('csv','backup_restore')),
  status TEXT NOT NULL CHECK(status IN ('succeeded','partial','failed')),
  rows_seen INTEGER NOT NULL DEFAULT 0,
  rows_imported INTEGER NOT NULL DEFAULT 0,
  rows_invalid INTEGER NOT NULL DEFAULT 0,
  duplicate_candidates INTEGER NOT NULL DEFAULT 0,
  transfer_candidates INTEGER NOT NULL DEFAULT 0,
  warnings_count INTEGER NOT NULL DEFAULT 0,
  errors_count INTEGER NOT NULL DEFAULT 0,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_data_import_runs_created_at
  ON data_import_runs(created_at DESC);
