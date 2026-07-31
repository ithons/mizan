import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { migratedTestDb } from './helpers/schema';
import { RETIRED_PREFERENCE_KEYS, getPreference } from '../server/src/services/preferences';
import { buildLocalBackup, restoreLocalBackup } from '../server/src/services/localBackup';

/**
 * Three preference keys, deleted from the code, the schema and the file that can put them back.
 *
 * The dangerous one is `advisor_auto_apply_high_confidence`. It stores `true` and asserts a
 * confidence-gated autonomy policy removed in f61109b, `app_preferences` has no allowlist in front
 * of `run_sql_query`, and the model reads that table. A row that describes the model's own rules
 * incorrectly is worse than an unread row, which is why "no code reads it" is not the whole test.
 */

const ROOT = join(import.meta.dirname, '..');
const RETIRED = [...RETIRED_PREFERENCE_KEYS].sort();

test('the retired set is exactly the three keys, and they are named in the migration', () => {
  assert.deepEqual(RETIRED, [
    'advisor_auto_apply_high_confidence',
    'custom_report_views',
    'dashboard_layout',
  ]);
  const migration = readFileSync(
    join(ROOT, 'server/src/db/migrations/054_drop_dead_preferences.sql'),
    'utf8'
  );
  for (const key of RETIRED) {
    assert.match(migration, new RegExp(`'${key}'`), `054 does not delete ${key}`);
  }
});

/**
 * Genuinely dead, re-established by searching rather than asserted from memory.
 *
 * `git grep` over tracked files only, so a stale build artifact under dist/ cannot fail this. The
 * two places each key is allowed to appear are the migration that deletes it and the guard that
 * keeps a restore from reinstating it, plus this file.
 */
test('no source file reads any retired key', () => {
  const ALLOWED = new Set([
    'server/src/db/migrations/054_drop_dead_preferences.sql',
    'server/src/services/preferences.ts',
    'tests/deadPreferences.test.ts',
  ]);
  for (const key of RETIRED) {
    const hits = execFileSync('git', ['grep', '-l', key, '--', 'server', 'client', 'shared', 'tests'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean)
      .filter((file) => !ALLOWED.has(file));
    assert.deepEqual(hits, [], `${key} still appears in ${hits.join(', ')}`);
  }
});

test('migration 054 removes rows an older database already stored', () => {
  const db = new Database(':memory:');
  // Pre-054 shape, so the rows exist before the migration that deletes them runs.
  db.exec(`
    CREATE TABLE app_preferences (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const insert = db.prepare(
    "INSERT INTO app_preferences (key, value, created_at, updated_at) VALUES (?, ?, '2026-01-01', '2026-01-01')"
  );
  for (const key of RETIRED) insert.run(key, 'true');
  insert.run('advisor_user_profile', '"keep me"');

  const sql = readFileSync(join(ROOT, 'server/src/db/migrations/054_drop_dead_preferences.sql'), 'utf8');
  db.exec(sql);

  for (const key of RETIRED) assert.equal(getPreference(db, key), null, `${key} survived 054`);
  assert.equal(getPreference(db, 'advisor_user_profile')?.value, 'keep me');
  db.close();
});

test('a backup taken before 054 cannot put the keys back', (t) => {
  const target = migratedTestDb();
  t.after(() => target.close());

  // A pre-054 backup: the real file shape, with app_preferences still carrying the retired key.
  const backup = JSON.parse(JSON.stringify(buildLocalBackup(target))) as {
    tables: Record<string, Array<Record<string, unknown>>>;
  };
  backup.tables.app_preferences = [
    {
      key: 'advisor_auto_apply_high_confidence',
      value: 'true',
      created_at: '2026-01-01',
      updated_at: '2026-01-01',
    },
    { key: 'advisor_user_profile', value: '"keep me"', created_at: '2026-01-01', updated_at: '2026-01-01' },
  ];

  const result = restoreLocalBackup(target, backup);

  assert.equal(getPreference(target, 'advisor_auto_apply_high_confidence'), null);
  assert.equal(getPreference(target, 'advisor_user_profile')?.value, 'keep me');
  // The skipped row is not counted as restored: `restored_rows` is what landed, not what was read.
  const landed = target.prepare('SELECT COUNT(*) AS n FROM app_preferences').get() as { n: number };
  assert.equal(landed.n, 1);
  assert.ok(result.restored_rows >= 1);
});
