import type Database from 'better-sqlite3';
import type { AppPreference } from '../../../shared/types';

const CORRUPT = Symbol('corrupt-preference');

/**
 * Keys migration 054 deleted, kept named so a restore cannot put them back.
 *
 * `restoreLocalBackup` rewrites `app_preferences` wholesale from a JSON file the owner chose, and a
 * backup taken before 054 still carries all three. `advisor_auto_apply_high_confidence` is the one
 * that makes this worth a guard rather than a comment: it reads `true` and states an autonomy
 * policy removed in f61109b, and `run_sql_query` has no table allowlist, so a restored copy would
 * go straight back to describing the model's own rules incorrectly.
 */
export const RETIRED_PREFERENCE_KEYS: ReadonlySet<string> = new Set([
  'dashboard_layout',
  'custom_report_views',
  'advisor_auto_apply_high_confidence',
]);

interface PreferenceRow {
  key: string;
  value: string;
  created_at: string;
  updated_at: string;
}

function parsePreference(row: PreferenceRow): AppPreference | typeof CORRUPT {
  let value: unknown;
  try {
    value = JSON.parse(row.value);
  } catch (err) {
    // A corrupt preference is treated as unset so callers fall back to defaults
    // rather than crashing or misreading a partial string.
    console.warn(`[preferences] Invalid JSON for '${row.key}': ${(err as Error).message}`);
    return CORRUPT;
  }
  return {
    key: row.key,
    value,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function getPreference(db: Database.Database, key: string): AppPreference | null {
  const row = db.prepare(`
    SELECT key, value, created_at, updated_at
    FROM app_preferences
    WHERE key = ?
  `).get(key) as PreferenceRow | undefined;
  if (!row) return null;
  const parsed = parsePreference(row);
  return parsed === CORRUPT ? null : parsed;
}

export function setPreference(
  db: Database.Database,
  key: string,
  value: unknown,
  now = new Date().toISOString()
): AppPreference {
  const serialized = JSON.stringify(value);
  const existing = db.prepare('SELECT key FROM app_preferences WHERE key = ?').get(key);

  if (existing) {
    db.prepare(`
      UPDATE app_preferences
      SET value = ?,
          updated_at = ?
      WHERE key = ?
    `).run(serialized, now, key);
  } else {
    db.prepare(`
      INSERT INTO app_preferences (key, value, created_at, updated_at)
      VALUES (?, ?, ?, ?)
    `).run(key, serialized, now, now);
  }

  const preference = getPreference(db, key);
  if (!preference) throw new Error('Preference was not saved');
  return preference;
}
