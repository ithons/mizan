-- Audit trail for every AI action that mutates the database, so the person can always
-- see what the AI did and why. "automation is fine, opacity is the enemy": auto-apply
-- stays on, but every application (background-worker auto-apply or a user's one-click
-- confirm) is recorded here with its source and the payload that was applied.
CREATE TABLE advisor_actions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  summary TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('worker_auto', 'user_confirm')),
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_advisor_actions_created_at ON advisor_actions(created_at DESC);
