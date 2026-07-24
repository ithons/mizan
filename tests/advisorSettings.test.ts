import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  getAdvisorSettings,
  updateAdvisorSettings,
  getEnabledContextSections,
  DEFAULT_ADVISOR_MODEL,
  DEFAULT_ADVISOR_EFFORT,
  ADVISOR_CONTEXT_SECTIONS,
} from '../server/src/services/advisorSettings';

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

test('defaults when nothing is stored: default model/effort, all sections on', () => {
  const db = freshDb();
  const s = getAdvisorSettings(db);
  assert.equal(s.model, DEFAULT_ADVISOR_MODEL);
  assert.equal(s.effort, DEFAULT_ADVISOR_EFFORT);
  assert.equal(s.context_sections.length, ADVISOR_CONTEXT_SECTIONS.length);
  assert.equal(getEnabledContextSections(db).size, ADVISOR_CONTEXT_SECTIONS.length);
});

test('valid updates persist and round-trip', () => {
  const db = freshDb();
  const r = updateAdvisorSettings(db, { model: 'claude-opus-4-8', effort: 'high' });
  assert.ok(r.ok);
  const s = getAdvisorSettings(db);
  assert.equal(s.model, 'claude-opus-4-8');
  assert.equal(s.effort, 'high');
});

test('REJECTS an off-whitelist model (the security boundary) and does not persist', () => {
  const db = freshDb();
  const r = updateAdvisorSettings(db, { model: 'gpt-4o' });
  assert.equal(r.ok, false);
  assert.ok(r.error);
  assert.equal(getAdvisorSettings(db).model, DEFAULT_ADVISOR_MODEL);
});

test('REJECTS an invalid effort and an invalid section id', () => {
  const db = freshDb();
  assert.equal(updateAdvisorSettings(db, { effort: 'max' }).ok, false);
  assert.equal(updateAdvisorSettings(db, { context_sections: ['not_a_section'] }).ok, false);
});

test('context_sections can be narrowed, and getEnabledContextSections reflects it', () => {
  const db = freshDb();
  const r = updateAdvisorSettings(db, { context_sections: ['goals', 'investments'] });
  assert.ok(r.ok);
  const enabled = getEnabledContextSections(db);
  assert.equal(enabled.size, 2);
  assert.ok(enabled.has('goals'));
  assert.ok(!enabled.has('recent_transactions'));
});

test('an empty context_sections array means "none on" (distinct from unset = all on)', () => {
  const db = freshDb();
  const r = updateAdvisorSettings(db, { context_sections: [] });
  assert.ok(r.ok);
  assert.equal(getEnabledContextSections(db).size, 0);
});
