CREATE TABLE advisor_drafts_new (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  summary TEXT NOT NULL,
  route TEXT NOT NULL,
  payload TEXT NOT NULL,
  changes TEXT NOT NULL,
  citations TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'confirmed', 'dismissed', 'superseded')),
  closed_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO advisor_drafts_new (id, kind, label, summary, route, payload, changes, citations, status, created_at, updated_at)
SELECT id, kind, label, summary, route, payload, changes, citations, status, created_at, updated_at FROM advisor_drafts;

DROP TABLE advisor_drafts;
ALTER TABLE advisor_drafts_new RENAME TO advisor_drafts;
CREATE INDEX idx_advisor_drafts_status ON advisor_drafts(status);
