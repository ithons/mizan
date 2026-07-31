import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migratedTestDb, insertAccount, TEST_NOW } from './helpers/schema';
import { takeHoldingsSnapshot } from '../server/src/services/snapshot';

function setupDb(): Database.Database {
  const db = migratedTestDb();
  insertAccount(db, { id: 'acct_1', type: 'brokerage' });
  db.prepare(
    "INSERT INTO securities (id, ticker, name, type) VALUES ('sec_vti', 'VTI', 'Vanguard Total Market', 'etf')"
  ).run();
  db.prepare(`
    INSERT INTO holdings
      (id, account_id, security_id, quantity, institution_price, institution_value, cost_basis, updated_at)
    VALUES ('hold_1', 'acct_1', 'sec_vti', 10, 120, 1200, 1000, ?)
  `).run(TEST_NOW);
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
