import type Database from 'better-sqlite3';
import type { AppPreference } from '../../../shared/types';

interface PreferenceRow {
  key: string;
  value: string;
  created_at: string;
  updated_at: string;
}

function parsePreference(row: PreferenceRow): AppPreference {
  return {
    key: row.key,
    value: JSON.parse(row.value) as unknown,
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
  return row ? parsePreference(row) : null;
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
