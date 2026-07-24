import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = fs.readFileSync(
  path.join(here, '../server/src/db/migrations/034_account_type_closed.sql'),
  'utf-8'
);

// The pre-034 accounts schema (022 table + type_source/backfill_floor_date/name_source added after).
function setupDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      simplefin_account_id TEXT UNIQUE,
      coinbase_account_id TEXT UNIQUE,
      connection_id TEXT,
      connection_type TEXT NOT NULL CHECK(connection_type IN ('coinbase','simplefin','manual')),
      institution_name TEXT NOT NULL DEFAULT '',
      account_name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('checking','savings','credit','brokerage','ira_traditional','ira_roth','crypto_wallet','cash','other')),
      subtype TEXT, mask TEXT,
      current_balance INTEGER NOT NULL DEFAULT 0,
      available_balance INTEGER, credit_limit INTEGER,
      currency TEXT NOT NULL DEFAULT 'USD',
      native_currency TEXT, native_balance REAL,
      is_manual INTEGER NOT NULL DEFAULT 0,
      is_hidden INTEGER NOT NULL DEFAULT 0,
      is_liability INTEGER NOT NULL DEFAULT 0,
      color TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      type_source TEXT NOT NULL DEFAULT 'auto',
      backfill_floor_date TEXT,
      name_source TEXT NOT NULL DEFAULT 'auto'
    );
  `);
  return db;
}

test('migration 034 carries every post-022 column forward and adds the closed type', (t) => {
  const db = setupDb();
  t.after(() => db.close());

  // A row with non-default values in the columns added after 022, to prove they survive the recreate.
  db.prepare(`INSERT INTO accounts
    (id, connection_type, institution_name, account_name, type, current_balance, currency,
     is_manual, is_hidden, is_liability, sort_order, created_at, updated_at,
     type_source, backfill_floor_date, name_source)
    VALUES ('a1','simplefin','BofA','Old Checking','checking',12345,'USD',0,0,0,0,'2024-01-01','2024-01-01','manual','2026-04-27','manual')`).run();

  db.exec(MIGRATION);

  const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get('a1') as Record<string, unknown>;
  assert.equal(row.type_source, 'manual', 'type_source carried');
  assert.equal(row.name_source, 'manual', 'name_source carried');
  assert.equal(row.backfill_floor_date, '2026-04-27', 'backfill_floor_date carried');
  assert.equal(row.current_balance, 12345);
  assert.equal(row.institution_name, 'BofA');
});

test("migration 034 lets a 'closed' account insert succeed (was rejected before)", (t) => {
  const db = setupDb();
  t.after(() => db.close());

  // Before the migration, 'closed' violates the CHECK.
  assert.throws(() =>
    db.prepare(`INSERT INTO accounts (id, connection_type, account_name, type, created_at, updated_at)
      VALUES ('c0','manual','X','closed','n','n')`).run());

  db.exec(MIGRATION);

  assert.doesNotThrow(() =>
    db.prepare(`INSERT INTO accounts (id, connection_type, account_name, type, created_at, updated_at)
      VALUES ('c1','manual','BofA Checking (closed)','closed','n','n')`).run());
  const closed = db.prepare("SELECT COUNT(*) n FROM accounts WHERE type='closed'").get() as { n: number };
  assert.equal(closed.n, 1);
});
