import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { runAiJob, type AiJobCollect, type AiJobDeclaration, type AiJobProposal } from '../server/src/services/aiJobs';
import { insertTransaction, migratedTestDb } from './helpers/schema';

/**
 * What bounds the rows a refused proposal writes, and what must not bound them.
 *
 * THE CLAIM THIS FILE WAS OPENED AGAINST WAS THAT NOTHING BOUNDS THEM. Phase 3 of
 * `.claude/plans/relink-and-close.md` reads "refused advisor draft rows accumulate unbounded ...
 * a hidden `advisor_drafts` row is written on every pass". Measured on a `.backup` copy of
 * `.mizan/mizan.db` taken 2026-08-01, before anything was built:
 *
 *   SELECT SUM(refused_by_guards), COUNT(*) FROM ai_runs;              ->  0 refusals, 12 runs
 *   SELECT COUNT(*) FROM ai_feedback WHERE signal = 'draft_dismissed'; ->  2
 *   SELECT COUNT(*) FROM advisor_drafts;                               ->  278
 *   SELECT json_extract(payload,'$.transaction_id') AS tx, COUNT(*) n
 *     FROM advisor_drafts WHERE kind = 'categorize_transaction'
 *    GROUP BY 1 HAVING n > 1;                                          ->  one target, n = 2,
 *                                                                          both rows carrying the
 *                                                                          same created_at
 *
 * So across 278 drafts written over sixteen days, the guards have refused nothing, and exactly one
 * target key was ever written twice: by ONE pass proposing the same transaction twice, not by two
 * passes stacking. There is no accumulation to bound, and no machinery is built here for one.
 *
 * The reason there is none is `supersedeRegeneratedDrafts` in aiJobs.ts, which runs at the top of
 * `persistProposals` and deletes every `status = 'open'` draft whose `draftTargetKey` the fresh
 * pass regenerates. A refused draft stays open (refusal is policy, not failure, and the queue is
 * meant to keep offering it), so the next pass that re-proposes the same target replaces it. That
 * is the bound. It was load-bearing and untested, which is the only real gap here, so these tests
 * hold it rather than adding a second mechanism beside it.
 *
 * Rule 3 applies in the mirror here: the danger of a bound is that it deletes too much. Two of the
 * four tests below are about what supersession must leave alone.
 */

/* ── credentials, pinned, so the pass runs for the reason the test says ─────── */

const CREDENTIAL_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_PROFILE',
  'ANTHROPIC_CONFIG_DIR',
] as const;

function withCredentials(): { restore: () => void } {
  const previous = new Map<string, string | undefined>();
  for (const key of CREDENTIAL_VARS) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env.ANTHROPIC_API_KEY = 'test-key-never-used';
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mizan-refused-bound-'));
  process.env.ANTHROPIC_CONFIG_DIR = scratch;
  return {
    restore: () => {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(scratch, { recursive: true, force: true });
    },
  };
}

/* ── fixtures ──────────────────────────────────────────────────────────────── */

const JOB: AiJobDeclaration = {
  name: 'background_review',
  trigger: 'after_sync',
  model: 'claude-sonnet-5',
  effort: 'medium',
  writes: ['categorize_transaction'],
  invariants: [],
  digestSection: 'review',
  execution: 'scheduler',
};

function categorize(transactionId: string, categoryId: string): AiJobProposal {
  return {
    kind: 'categorize_transaction',
    label: 'Categorize it',
    summary: 'The merchant looks like this category.',
    route: '/ledger',
    payload: { kind: 'categorize_transaction', transaction_id: transactionId, category_id: categoryId },
    changes: [],
    citations: [],
  };
}

const collecting = (proposals: AiJobProposal[]): AiJobCollect =>
  async () => ({ status: 'collected', proposals, malformed: 0, usage: null });

/** The owner's dismissal, in the shape `ownerDeclinedProposal` matches on: kind + row + category. */
function recordDismissal(
  db: Database.Database,
  fields: { id: string; transactionId: string; categoryId: string; at: string }
): void {
  db.prepare(`
    INSERT INTO ai_feedback
      (id, signal, proposal_kind, draft_id, transaction_id, proposed_category_id,
       owner_choice, affected_transactions, stale, created_at)
    VALUES (?, 'draft_dismissed', 'categorize_transaction', NULL, ?, ?, 'declined', 0, 0, ?)
  `).run(fields.id, fields.transactionId, fields.categoryId, fields.at);
}

interface DraftRow {
  id: string;
  status: string;
  transaction_id: string | null;
}

function drafts(db: Database.Database): DraftRow[] {
  return db.prepare(`
    SELECT id, status, json_extract(payload, '$.transaction_id') AS transaction_id
    FROM advisor_drafts
    ORDER BY created_at, rowid
  `).all() as DraftRow[];
}

function refusalsRecorded(db: Database.Database): number {
  return (db.prepare('SELECT COALESCE(SUM(refused_by_guards), 0) AS n FROM ai_runs').get() as { n: number }).n;
}

/* ── the bound ─────────────────────────────────────────────────────────────── */

test('a refused proposal re-offered every pass leaves one row, not one per pass', async (t) => {
  const db = migratedTestDb();
  const env = withCredentials();
  t.after(() => { db.close(); env.restore(); });

  const tx = insertTransaction(db, { merchant_name: 'Backblaze', amount: -900, category_id: null });
  recordDismissal(db, { id: 'fb_1', transactionId: tx, categoryId: 'cat_shop', at: '2026-08-01T00:00:00.000Z' });

  // Four passes, an hour apart in the model's terms, all proposing the thing the owner said no to.
  for (let pass = 0; pass < 4; pass += 1) {
    await runAiJob(JOB, collecting([categorize(tx, 'cat_shop')]), { db, trigger: 'after_sync' });
  }

  const rows = drafts(db);
  assert.equal(rows.length, 1, 'four refusals, one surviving row: the fourth pass superseded the third');
  assert.equal(rows[0].status, 'open', 'a refusal leaves the draft open on purpose; it is policy, not failure');
  assert.equal(rows[0].transaction_id, tx);
  assert.equal(refusalsRecorded(db), 4, 'and every one of the four is still counted on its own run row');
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS n FROM advisor_actions').get() as { n: number }).n,
    0,
    'nothing was applied: the owner said no'
  );
});

test('the same holds when the model tries a different category for the row each pass', async (t) => {
  const db = migratedTestDb();
  const env = withCredentials();
  t.after(() => { db.close(); env.restore(); });

  const tx = insertTransaction(db, { merchant_name: 'Backblaze', amount: -900, category_id: null });
  recordDismissal(db, { id: 'fb_1', transactionId: tx, categoryId: 'cat_shop', at: '2026-08-01T00:00:00.000Z' });
  recordDismissal(db, { id: 'fb_2', transactionId: tx, categoryId: 'cat_ent', at: '2026-08-01T01:00:00.000Z' });

  // The target key is the ROW, not the row and the category, which is what makes this bounded: a
  // model working through candidate categories for one transaction cannot stack a row per attempt.
  await runAiJob(JOB, collecting([categorize(tx, 'cat_shop')]), { db, trigger: 'after_sync' });
  await runAiJob(JOB, collecting([categorize(tx, 'cat_ent')]), { db, trigger: 'after_sync' });

  assert.equal(drafts(db).length, 1);
  assert.equal(refusalsRecorded(db), 2);
});

/* ── what the bound must NOT sweep up ──────────────────────────────────────── */

test('a pass about one row leaves an open draft about a different row standing', async (t) => {
  const db = migratedTestDb();
  const env = withCredentials();
  t.after(() => { db.close(); env.restore(); });

  const declined = insertTransaction(db, { merchant_name: 'Backblaze', amount: -900, category_id: null });
  const other = insertTransaction(db, { merchant_name: 'Trupanion', amount: -4200, category_id: null });
  recordDismissal(db, { id: 'fb_1', transactionId: declined, categoryId: 'cat_shop', at: '2026-08-01T00:00:00.000Z' });

  await runAiJob(JOB, collecting([categorize(declined, 'cat_shop')]), { db, trigger: 'after_sync' });
  // A second pass that has nothing to say about the declined row. Superseding by target key means
  // this must not touch it: a bound that cleared the table on every pass would pass the two tests
  // above and silently discard a proposal the owner had not answered yet.
  await runAiJob(JOB, collecting([categorize(other, 'cat_health')]), { db, trigger: 'after_sync' });

  const rows = drafts(db);
  assert.equal(rows.length, 2, 'the refused row survives a pass that was about something else');
  assert.deepEqual(
    rows.map((r) => r.transaction_id).sort(),
    [declined, other].sort()
  );
});

test('supersession never deletes a draft that was applied, only one still open', async (t) => {
  const db = migratedTestDb();
  const env = withCredentials();
  t.after(() => { db.close(); env.restore(); });

  const tx = insertTransaction(db, { merchant_name: 'Trupanion', amount: -4200, category_id: null });

  // Nothing declined: the first pass applies unattended, which is what an autonomous kind does.
  await runAiJob(JOB, collecting([categorize(tx, 'cat_health')]), { db, trigger: 'after_sync' });
  const applied = drafts(db);
  assert.equal(applied.length, 1);
  assert.equal(applied[0].status, 'confirmed');

  // A later pass proposing the same row again. The confirmed row is the only surviving statement
  // of what the model actually did, and `advisor_actions` undo reads through it, so it stays.
  await runAiJob(JOB, collecting([categorize(tx, 'cat_food')]), { db, trigger: 'after_sync' });

  const rows = drafts(db);
  assert.equal(rows.length, 2, 'the applied draft is history and is not superseded');
  assert.deepEqual(rows.map((r) => r.status), ['confirmed', 'confirmed']);
});
