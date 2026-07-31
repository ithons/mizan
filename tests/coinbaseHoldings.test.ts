import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migratedTestDb, insertAccount } from './helpers/schema';
import { upsertCoinbaseHolding } from '../server/src/services/coinbase';

// The hand-written schema this replaced declared `institution_value REAL` and `cost_basis REAL`;
// production has both as INTEGER cents since migration 022, and both holdings foreign keys were
// absent, so an account that does not exist could hold a position.
function setupDb(): Database.Database {
  const db = migratedTestDb();
  insertAccount(db, { id: 'acct_1', type: 'crypto_wallet', connection_type: 'coinbase' });
  insertAccount(db, { id: 'acct_2', type: 'crypto_wallet', connection_type: 'coinbase' });
  return db;
}

test('upsertCoinbaseHolding creates a crypto security and holding row', (t) => {
  const db = setupDb();
  t.after(() => db.close());

  upsertCoinbaseHolding(db, 'acct_1', 'BTC', 0.5, 60000, 30000, '2026-07-03T00:00:00.000Z');

  const securities = db.prepare('SELECT ticker, name, type FROM securities').all() as Array<{
    ticker: string | null; name: string; type: string;
  }>;
  assert.deepEqual(securities, [{ ticker: 'BTC', name: 'BTC', type: 'crypto' }]);

  const holdings = db.prepare('SELECT quantity, institution_price, institution_value, cost_basis FROM holdings').all() as Array<{
    quantity: number; institution_price: number; institution_value: number; cost_basis: number | null;
  }>;
  assert.deepEqual(holdings, [
    { quantity: 0.5, institution_price: 60000, institution_value: 3000000, cost_basis: null },
  ]);
});

test('upsertCoinbaseHolding updates an existing holding for the same account+currency instead of duplicating it', (t) => {
  const db = setupDb();
  t.after(() => db.close());

  upsertCoinbaseHolding(db, 'acct_1', 'ETH', 2, 3000, 6000, '2026-07-01T00:00:00.000Z');
  upsertCoinbaseHolding(db, 'acct_1', 'ETH', 3, 3200, 9600, '2026-07-03T00:00:00.000Z');

  const securities = db.prepare('SELECT COUNT(*) as n FROM securities').get() as { n: number };
  const holdings = db.prepare('SELECT quantity, institution_value, updated_at FROM holdings').all();

  assert.equal(securities.n, 1);
  assert.deepEqual(holdings, [
    { quantity: 3, institution_value: 960000, updated_at: '2026-07-03T00:00:00.000Z' },
  ]);
});

test('upsertCoinbaseHolding reuses a security across different accounts holding the same coin', (t) => {
  const db = setupDb();
  t.after(() => db.close());

  upsertCoinbaseHolding(db, 'acct_1', 'BTC', 0.1, 60000, 6000, '2026-07-03T00:00:00.000Z');
  upsertCoinbaseHolding(db, 'acct_2', 'BTC', 0.2, 60000, 12000, '2026-07-03T00:00:00.000Z');

  const securities = db.prepare('SELECT COUNT(*) as n FROM securities').get() as { n: number };
  const holdings = db.prepare('SELECT account_id, institution_value FROM holdings ORDER BY account_id').all();

  assert.equal(securities.n, 1);
  assert.deepEqual(holdings, [
    { account_id: 'acct_1', institution_value: 600000 },
    { account_id: 'acct_2', institution_value: 1200000 },
  ]);
});
