-- One row per AI job pass: what ran, when, with which model, what it proposed, what applied, what
-- was refused, and what it cost.
--
-- THE HOLE THIS FILLS. The model's behaviour over time is unrecorded. A pass writes four lines to
-- stdout and they scroll away. `advisor_actions` records what landed and nothing else, so a pass
-- that proposed nothing, a pass whose every proposal the guards refused, and a pass that never ran
-- at all are the same absence of rows. Measured on a copy of .mizan/mizan.db, 2026-07-31, with the
-- queries beside them:
--   SELECT source, COUNT(*) FROM advisor_actions GROUP BY source;
--     -> worker_auto 129, user_confirm 11
--   SELECT COUNT(*) FROM advisor_drafts;                            -> 251
--   SELECT COUNT(*) FROM sync_runs;                                 -> 117
-- 129 unattended writes, and not one record of the pass that made any of them.
--
-- The same gap from the other side:
--   SELECT status, COUNT(*) FROM sync_runs GROUP BY status;
--     -> succeeded 98, partial 10, failed 4, running 5
-- 'partial' is written at exactly one place, the tail of `_runFullSyncInternal`, after the run has
-- already recorded its outcome. The AI kickoff sat after the `if (deferredError) throw` on the very
-- next line, so each of those 10 runs reached the kickoff and stepped over it. Only one of the 10
-- had committed anything for a pass to review, which is the case that matters:
--   SELECT started_at, accounts_seen, transactions_modified, error_message
--     FROM sync_runs WHERE status = 'partial';
--     -> 2026-07-24T04:21, 'FOREIGN KEY constraint failed', accounts_seen 17, modified 111
--     -> the other 9 are 0/0/0/0, eight of them the same SimpleFIN DNS failure on 2026-07-28
-- (The 4 'failed' runs died earlier and still do not fire a pass; nothing was written to review.)
--
-- WHAT THIS IS NOT. No score, no accuracy percentage, no self-reported confidence. Counts of what
-- happened and token totals of what it took, both of which a later reader can recompute against
-- advisor_actions and advisor_drafts. Cost is recorded in TOKENS, not dollars: a dollar figure
-- would bake in a price this code cannot check and cannot keep current.
--
-- NO FOREIGN KEYS, DELIBERATELY, on the same reasoning as migration 047. `sync_run_id` is a
-- recorded historical value rather than a live pointer: the audit record of a pass has to outlive
-- the sync run that triggered it, and a pass fired by a direct call has no sync run at all.

CREATE TABLE ai_runs (
  id TEXT PRIMARY KEY,

  -- The AiJobName in services/aiJobs.ts. Not constrained to a list here: the registry is the
  -- authority on which jobs exist, and a CHECK would be a second copy of it to keep in step.
  job TEXT NOT NULL,

  -- 'trigger' is reserved in SQLite, hence the suffix. One of the AiJobTrigger values.
  trigger_source TEXT NOT NULL,

  -- The sync run whose completion fired this pass, when one did.
  sync_run_id TEXT,

  -- The model and effort the job is CONFIGURED with, recorded even when no call was made, so a
  -- retiering is visible in the history rather than only in the diff that caused it. Whether a
  -- call actually happened is answered by the token columns, not by these.
  model TEXT NOT NULL,
  effort TEXT,

  -- Which section of the digest this pass's output belongs under (AiDigestSection).
  digest_section TEXT NOT NULL,

  -- 'running' is written at the start and overwritten at the end. A row left at 'running' means
  -- the process died mid-pass, which is a signal rather than a defect in this schema.
  status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed', 'skipped')),

  -- Set only when status = 'skipped'. A 'nothing_to_do' pass looked and found no delta; it is not
  -- a failure and must not read as one. How often that happens is not asserted here: it depends on
  -- the owner's backlog, and on this database today an unreviewed recurring item alone keeps the
  -- background_review gate open. See newDetections() in services/aiWorker.ts.
  skipped_reason TEXT,

  started_at TEXT NOT NULL,
  completed_at TEXT,

  -- Proposals the model returned that the job's own output contract accepted and this job is
  -- allowed to write. `refused_out_of_scope` counts the ones outside its declared `writes`.
  proposed INTEGER NOT NULL DEFAULT 0,
  applied INTEGER NOT NULL DEFAULT 0,
  queued INTEGER NOT NULL DEFAULT 0,
  refused_by_guards INTEGER NOT NULL DEFAULT 0,
  refused_out_of_scope INTEGER NOT NULL DEFAULT 0,
  malformed INTEGER NOT NULL DEFAULT 0,

  -- NULL means no model call was made, or the reply carried no usage. 0 would assert a
  -- measurement nobody took, the same distinction migration 047 draws for `stale`.
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,

  -- The declared invariant this pass broke, with what was found. NULL is the ordinary case and
  -- means the declared invariants were evaluated and held, not that nothing was checked: which
  -- invariants a job declares is in the registry, and a job declaring none records none.
  invariant_breach TEXT,

  error_message TEXT,

  created_at TEXT NOT NULL
);

CREATE INDEX idx_ai_runs_started_at ON ai_runs(started_at DESC);
CREATE INDEX idx_ai_runs_job ON ai_runs(job, started_at DESC);
CREATE INDEX idx_ai_runs_sync_run ON ai_runs(sync_run_id);
