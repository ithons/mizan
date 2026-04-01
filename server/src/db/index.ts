import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import os from 'os';

const MIZAN_DIR = path.join(os.homedir(), '.mizan');
const DB_PATH = path.join(MIZAN_DIR, 'mizan.db');
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

// Ensure ~/.mizan exists
fs.mkdirSync(MIZAN_DIR, { recursive: true });
fs.mkdirSync(path.join(MIZAN_DIR, 'logs'), { recursive: true });

let _db: Database.Database | null = null;

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

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    db.exec(sql);
    db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(
      file,
      new Date().toISOString()
    );
    console.log(`[db] Applied migration: ${file}`);
  }
}

export { DB_PATH, MIZAN_DIR };
