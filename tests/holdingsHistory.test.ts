import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { takeHoldingsSnapshot } from '../server/src/services/snapshot';

function setupDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE holdings (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      security_id TEXT NOT NULL,
      quantity REAL NOT NULL,
      institution_price REAL NOT NULL,
      institution_value REAL NOT NULL,
      cost_basis REAL
    );

    CREATE TABLE holdings_history (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      security_id TEXT NOT NULL,
      date TEXT NOT NULL,
      quantity REAL NOT NULL,
      institution_price REAL NOT NULL,
      institution_value REAL NOT NULL,
      cost_basis REAL,
      created_at TEXT NOT NULL,
      UNIQUE(account_id, security_id, date)
    );

    INSERT INTO holdings (id, account_id, security_id, quantity, institution_price, institution_value, cost_basis)
    VALUES ('hold_1', 'acct_1', 'sec_vti', 10, 120, 1200, 1000);
  `);
  return db;
}

test('takeHoldingsSnapshot records one row per holding per day, upserting on repeat syncs the same day', (t) => {
  const db = setupDb();
  t.after(() => db.close());

  takeHoldingsSnapshot(db, '2026-07-03', '2026-07-03T09:00:00.000Z');
  // A second sync later the same day (e.g. a manual re-sync) should update, not duplicate.
  db.prepare('UPDATE holdings SET institution_value = 1250, institution_price = 125 WHERE id = ?').run('hold_1');
  takeHoldingsSnapshot(db, '2026-07-03', '2026-07-03T15:00:00.000Z');

  const rows = db.prepare('SELECT date, institution_value FROM holdings_history WHERE account_id = ? AND security_id = ?').all('acct_1', 'sec_vti');
  assert.deepEqual(rows, [{ date: '2026-07-03', institution_value: 1250 }]);
});

test('takeHoldingsSnapshot accumulates a distinct row for each new day', (t) => {
  const db = setupDb();
  t.after(() => db.close());

  takeHoldingsSnapshot(db, '2026-07-02', '2026-07-02T09:00:00.000Z');
  db.prepare('UPDATE holdings SET institution_value = 1300 WHERE id = ?').run('hold_1');
  takeHoldingsSnapshot(db, '2026-07-03', '2026-07-03T09:00:00.000Z');

  const rows = db.prepare('SELECT date, institution_value FROM holdings_history ORDER BY date').all();
  assert.deepEqual(rows, [
    { date: '2026-07-02', institution_value: 1200 },
    { date: '2026-07-03', institution_value: 1300 },
  ]);
});
