CREATE TABLE IF NOT EXISTS advisor_drafts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  summary TEXT NOT NULL,
  route TEXT NOT NULL,
  payload TEXT NOT NULL,
  changes TEXT NOT NULL,
  citations TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'confirmed', 'dismissed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_advisor_drafts_status ON advisor_drafts(status);
