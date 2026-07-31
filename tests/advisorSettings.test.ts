import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  getAdvisorSettings,
  updateAdvisorSettings,
  DEFAULT_ADVISOR_MODEL,
  DEFAULT_ADVISOR_EFFORT,
} from '../server/src/services/advisorSettings';

// The per-section context allowlist is gone. It existed to limit how much of the financial
// snapshot reached the model, and it defaulted to sending a subset, so its only effect was a
// worse answer. The snapshot is always complete now; model and effort remain configurable.

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE app_preferences (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return db;
}

test('defaults when nothing is stored', () => {
  const db = freshDb();
  const s = getAdvisorSettings(db);
  assert.equal(s.model, DEFAULT_ADVISOR_MODEL);
  assert.equal(s.effort, DEFAULT_ADVISOR_EFFORT);
});

test('valid updates persist and round-trip', () => {
  const db = freshDb();
  const r = updateAdvisorSettings(db, { model: 'claude-opus-5', effort: 'xhigh' });
  assert.ok(r.ok);
  const s = getAdvisorSettings(db);
  assert.equal(s.model, 'claude-opus-5');
  assert.equal(s.effort, 'xhigh');
});

test('REJECTS an off-whitelist model (the security boundary) and does not persist', () => {
  const db = freshDb();
  const r = updateAdvisorSettings(db, { model: 'gpt-4o' });
  assert.equal(r.ok, false);
  assert.ok(r.error);
  assert.equal(getAdvisorSettings(db).model, DEFAULT_ADVISOR_MODEL);
});

// This asserted 'max' was rejected, which only ever tested that the validator worked.
// 'max' is a real effort level, and the ladder now runs to it. The validator is still the
// thing under test; the value that exercises it just has to be one no model accepts.
test('REJECTS an invalid effort', () => {
  const db = freshDb();
  assert.equal(updateAdvisorSettings(db, { effort: 'maximum' }).ok, false);
  assert.equal(getAdvisorSettings(db).effort, DEFAULT_ADVISOR_EFFORT);
});

test('the whole effort ladder is accepted', () => {
  const db = freshDb();
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
    assert.equal(updateAdvisorSettings(db, { effort }).ok, true, `${effort} should be accepted`);
    assert.equal(getAdvisorSettings(db).effort, effort);
  }
});
