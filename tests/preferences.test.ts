import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { getPreference, setPreference } from '../server/src/services/preferences';

function setupDb(): Database.Database {
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

test('preferences persist structured JSON by key', (t) => {
  const db = setupDb();
  t.after(() => db.close());

  assert.equal(getPreference(db, 'dashboard_layout'), null);

  const saved = setPreference(
    db,
    'dashboard_layout',
    [{ id: 'overview', hidden: false, pinned: true }],
    '2026-06-30T12:00:00.000Z'
  );

  assert.equal(saved.key, 'dashboard_layout');
  assert.deepEqual(saved.value, [{ id: 'overview', hidden: false, pinned: true }]);
  assert.equal(saved.created_at, '2026-06-30T12:00:00.000Z');
  assert.equal(saved.updated_at, '2026-06-30T12:00:00.000Z');

  const updated = setPreference(
    db,
    'dashboard_layout',
    [{ id: 'overview', hidden: true, pinned: false }],
    '2026-06-30T13:00:00.000Z'
  );

  assert.deepEqual(updated.value, [{ id: 'overview', hidden: true, pinned: false }]);
  assert.equal(updated.created_at, '2026-06-30T12:00:00.000Z');
  assert.equal(updated.updated_at, '2026-06-30T13:00:00.000Z');
});
