import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { confirmAdvisorDraftsByIds } from '../server/src/services/advisorDrafts';

function setupDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE goals (
      id TEXT PRIMARY KEY,
      target_amount INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT '2026-07-01'
    );
    CREATE TABLE advisor_drafts (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      label TEXT NOT NULL,
      summary TEXT NOT NULL,
      route TEXT,
      payload TEXT NOT NULL,
      changes TEXT,
      citations TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL DEFAULT '2026-07-01',
      updated_at TEXT NOT NULL DEFAULT '2026-07-01'
    );
    CREATE TABLE advisor_actions (
      id TEXT PRIMARY KEY, kind TEXT, label TEXT, summary TEXT, source TEXT, payload TEXT, created_at TEXT
    );

    INSERT INTO goals (id, target_amount) VALUES ('goal_1', 100000), ('goal_2', 200000);
  `);
  return db;
}

function insertDraft(
  db: Database.Database,
  id: string,
  payload: unknown,
  status = 'open'
): void {
  db.prepare(`
    INSERT INTO advisor_drafts (id, kind, label, summary, route, payload, changes, citations, status)
    VALUES (?, 'update_goal_target', ?, 'summary', '/goals', ?, '[]', '[]', ?)
  `).run(id, `Draft ${id}`, JSON.stringify(payload), status);
}

test('confirms several drafts and reports each outcome', (t) => {
  const db = setupDb();
  t.after(() => db.close());

  insertDraft(db, 'd1', { kind: 'update_goal_target', goal_id: 'goal_1', target_amount: 5000 });
  insertDraft(db, 'd2', { kind: 'update_goal_target', goal_id: 'goal_2', target_amount: 7000 });

  const result = confirmAdvisorDraftsByIds(db, ['d1', 'd2']);
  assert.equal(result.applied, 2);
  assert.equal(result.skipped, 0);

  const goals = db.prepare('SELECT id, target_amount FROM goals ORDER BY id').all() as Array<{
    id: string;
    target_amount: number;
  }>;
  // Money crosses the boundary in dollars and lands as integer cents.
  assert.deepEqual(goals, [
    { id: 'goal_1', target_amount: 500000 },
    { id: 'goal_2', target_amount: 700000 },
  ]);

  const statuses = db.prepare('SELECT status FROM advisor_drafts ORDER BY id').all();
  assert.deepEqual(statuses, [{ status: 'confirmed' }, { status: 'confirmed' }]);

  // Every applied draft is recorded in the visible audit trail.
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM advisor_actions').get() as { n: number }).n, 2);
});

test('one bad draft does not roll back the drafts that already applied', (t) => {
  const db = setupDb();
  t.after(() => db.close());

  insertDraft(db, 'good', { kind: 'update_goal_target', goal_id: 'goal_1', target_amount: 5000 });
  // Rejected by AdvisorDraftPayloadSchema before any write (the trust boundary).
  insertDraft(db, 'bad', { kind: 'update_goal_target', goal_id: 'goal_2', target_amount: 'not-a-number' });

  const result = confirmAdvisorDraftsByIds(db, ['good', 'bad']);
  assert.equal(result.applied, 1);
  assert.equal(result.skipped, 1);

  const good = db.prepare("SELECT target_amount FROM goals WHERE id = 'goal_1'").get() as { target_amount: number };
  assert.equal(good.target_amount, 500000, 'the valid draft must survive its neighbour failing');

  const untouched = db.prepare("SELECT target_amount FROM goals WHERE id = 'goal_2'").get() as { target_amount: number };
  assert.equal(untouched.target_amount, 200000);

  const badOutcome = result.outcomes.find((o) => o.id === 'bad');
  assert.equal(badOutcome?.status, 'skipped');
  assert.match(String(badOutcome?.reason), /Invalid draft payload/);

  // The failed draft stays open so it can be inspected or dismissed, not silently consumed.
  const status = db.prepare("SELECT status FROM advisor_drafts WHERE id = 'bad'").get() as { status: string };
  assert.equal(status.status, 'open');
});

test('already-resolved and unknown ids are skipped, never re-applied', (t) => {
  const db = setupDb();
  t.after(() => db.close());

  insertDraft(db, 'done', { kind: 'update_goal_target', goal_id: 'goal_1', target_amount: 5000 }, 'confirmed');

  const result = confirmAdvisorDraftsByIds(db, ['done', 'nope']);
  assert.equal(result.applied, 0);
  assert.equal(result.skipped, 2);
  assert.equal(result.outcomes.every((o) => o.reason === 'not_found_or_resolved'), true);

  const goal = db.prepare("SELECT target_amount FROM goals WHERE id = 'goal_1'").get() as { target_amount: number };
  assert.equal(goal.target_amount, 100000, 'a confirmed draft must not apply twice');
});

test('a duplicated id in the request applies once', (t) => {
  const db = setupDb();
  t.after(() => db.close());

  insertDraft(db, 'd1', { kind: 'update_goal_target', goal_id: 'goal_1', target_amount: 5000 });

  const result = confirmAdvisorDraftsByIds(db, ['d1', 'd1', 'd1']);
  assert.equal(result.applied, 1);
  assert.equal(result.outcomes.length, 1);
});

test('an unreadable payload is reported rather than crashing the batch', (t) => {
  const db = setupDb();
  t.after(() => db.close());

  db.prepare(`
    INSERT INTO advisor_drafts (id, kind, label, summary, route, payload, changes, citations, status)
    VALUES ('broken', 'update_goal_target', 'Broken', 'summary', '/goals', 'not json', '[]', '[]', 'open')
  `).run();
  insertDraft(db, 'ok', { kind: 'update_goal_target', goal_id: 'goal_1', target_amount: 5000 });

  const result = confirmAdvisorDraftsByIds(db, ['broken', 'ok']);
  assert.equal(result.applied, 1);
  assert.equal(result.outcomes.find((o) => o.id === 'broken')?.reason, 'unreadable_payload');
});
