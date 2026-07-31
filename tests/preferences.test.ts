import test from 'node:test';
import assert from 'node:assert/strict';
import { migratedTestDb } from './helpers/schema';
import { getPreference, setPreference } from '../server/src/services/preferences';

const setupDb = migratedTestDb;

test('preferences persist structured JSON by key', (t) => {
  const db = setupDb();
  t.after(() => db.close());

  assert.equal(getPreference(db, 'example_key'), null);

  const saved = setPreference(
    db,
    'example_key',
    [{ id: 'overview', hidden: false, pinned: true }],
    '2026-06-30T12:00:00.000Z'
  );

  assert.equal(saved.key, 'example_key');
  assert.deepEqual(saved.value, [{ id: 'overview', hidden: false, pinned: true }]);
  assert.equal(saved.created_at, '2026-06-30T12:00:00.000Z');
  assert.equal(saved.updated_at, '2026-06-30T12:00:00.000Z');

  const updated = setPreference(
    db,
    'example_key',
    [{ id: 'overview', hidden: true, pinned: false }],
    '2026-06-30T13:00:00.000Z'
  );

  assert.deepEqual(updated.value, [{ id: 'overview', hidden: true, pinned: false }]);
  assert.equal(updated.created_at, '2026-06-30T12:00:00.000Z');
  assert.equal(updated.updated_at, '2026-06-30T13:00:00.000Z');
});
