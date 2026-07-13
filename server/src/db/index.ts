import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

// Store data in the project directory. process.cwd() is always the project
// root because npm scripts run from there, in both dev and production.
const MIZAN_DIR = path.join(process.cwd(), '.mizan');
const DB_PATH = path.join(MIZAN_DIR, 'mizan.db');
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

fs.mkdirSync(MIZAN_DIR, { recursive: true });
fs.mkdirSync(path.join(MIZAN_DIR, 'logs'), { recursive: true });

let _db: Database.Database | null = null;

export function _setDbForTesting(testDb: Database.Database) {
  _db = testDb;
}

export function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
  }
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

export function runMigrations(): void {
  const db = getDb();

  // Bootstrap schema_migrations table
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

  const applied = new Set(
    (db.prepare('SELECT name FROM schema_migrations').all() as { name: string }[]).map((r) => r.name)
  );

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  // Each migration is applied atomically: a mid-file failure must roll back the
  // whole file rather than leave a half-migrated schema recorded as unapplied.
  // The create-new-table/copy/drop/rename migrations (013, 014) need FK
  // enforcement off during the rebuild. foreign_keys can only be toggled outside
  // a transaction, so we disable it around the loop and rely on foreign_key_check
  // to catch violations before each COMMIT. Any in-file `PRAGMA foreign_keys`
  // statement is a harmless no-op inside the transaction.
  db.pragma('foreign_keys = OFF');
  try {
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
      const applyMigration = db.transaction(() => {
        db.exec(sql);
        const violations = db.pragma('foreign_key_check') as unknown[];
        if (violations.length > 0) {
          throw new Error(
            `Migration ${file} left ${violations.length} foreign-key violation(s): ${JSON.stringify(violations)}`
          );
        }
        db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(
          file,
          new Date().toISOString()
        );
      });
      applyMigration();
      console.log(`[db] Applied migration: ${file}`);
    }
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

export { DB_PATH, MIZAN_DIR };
