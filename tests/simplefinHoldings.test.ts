import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { upsertHoldingsFromSimplefin } from '../server/src/services/simplefin';

function setupDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE securities (
      id TEXT PRIMARY KEY,
      ticker TEXT,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD'
    );

    CREATE TABLE holdings (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      security_id TEXT NOT NULL,
      quantity REAL NOT NULL,
      institution_price REAL NOT NULL,
      institution_value REAL NOT NULL,
      cost_basis REAL,
      currency TEXT NOT NULL DEFAULT 'USD',
      updated_at TEXT NOT NULL,
      UNIQUE(account_id, security_id)
    );
  `);
  return db;
}

test('upsertHoldingsFromSimplefin creates securities and holdings from a SimpleFIN payload', (t) => {
  const db = setupDb();
  t.after(() => db.close());

  upsertHoldingsFromSimplefin(db, 'acct_1', [
    { symbol: 'VTI', description: 'Vanguard Total Stock Market ETF', shares: 10, market_value: 2500, cost_basis: 2000, currency: 'USD' },
    { symbol: null, description: 'Money Market Sweep', shares: 100, market_value: 100, cost_basis: null, currency: 'USD' },
  ], '2026-07-03T00:00:00.000Z');

  const securities = db.prepare('SELECT ticker, name, type FROM securities ORDER BY ticker').all() as Array<{ ticker: string | null; name: string; type: string }>;
  assert.deepEqual(securities, [
    { ticker: null, name: 'Money Market Sweep', type: 'equity' },
    { ticker: 'VTI', name: 'Vanguard Total Stock Market ETF', type: 'equity' },
  ]);

  const holdings = db.prepare('SELECT quantity, institution_price, institution_value, cost_basis FROM holdings ORDER BY institution_value').all() as Array<{
    quantity: number; institution_price: number; institution_value: number; cost_basis: number | null;
  }>;
  assert.deepEqual(holdings, [
    { quantity: 100, institution_price: 1, institution_value: 10000, cost_basis: null },
    { quantity: 10, institution_price: 250, institution_value: 250000, cost_basis: 200000 },
  ]);
});

test('upsertHoldingsFromSimplefin falls back to shares*purchase_price when cost_basis is 0/missing but a real purchase_price is given', (t) => {
  const db = setupDb();
  t.after(() => db.close());

  upsertHoldingsFromSimplefin(db, 'acct_1', [
    // Matches a real Fidelity payload: cost_basis "0.00" despite a real purchase_price.
    { symbol: 'FSKAX', description: 'Fidelity Total Market Index Fund', shares: 1.477, market_value: 305.56, cost_basis: 0, purchase_price: 204.98 },
    // No usable purchase_price to fall back to (e.g. a stable-value money market fund) -
    // cost_basis stays exactly what SimpleFIN reported, not fabricated from nothing.
    { symbol: 'SPAXX', description: 'Money Market', shares: 4.61, market_value: 4.61, cost_basis: 0, purchase_price: null },
    // A real nonzero cost_basis is never overridden by purchase_price.
    { symbol: 'VTI', description: 'Vanguard Total Stock Market ETF', shares: 10, market_value: 2500, cost_basis: 2000, purchase_price: 150 },
  ], '2026-07-03T00:00:00.000Z');

  const holdings = db.prepare('SELECT quantity, cost_basis FROM holdings ORDER BY quantity').all();
  assert.deepEqual(holdings, [
    { quantity: 1.477, cost_basis: Math.round(1.477 * 204.98 * 100) },
    { quantity: 4.61, cost_basis: 0 },
    { quantity: 10, cost_basis: 200000 },
  ]);
});

test('upsertHoldingsFromSimplefin updates an existing holding for the same account+security instead of duplicating it', (t) => {
  const db = setupDb();
  t.after(() => db.close());

  upsertHoldingsFromSimplefin(db, 'acct_1', [
    { symbol: 'VTI', description: 'Vanguard Total Stock Market ETF', shares: 10, market_value: 2500, cost_basis: 2000 },
  ], '2026-07-01T00:00:00.000Z');

  upsertHoldingsFromSimplefin(db, 'acct_1', [
    { symbol: 'VTI', description: 'Vanguard Total Stock Market ETF', shares: 12, market_value: 3000, cost_basis: 2400 },
  ], '2026-07-03T00:00:00.000Z');

  const securities = db.prepare('SELECT COUNT(*) as n FROM securities').get() as { n: number };
  const holdings = db.prepare('SELECT quantity, institution_value, cost_basis, updated_at FROM holdings').all();

  assert.equal(securities.n, 1);
  assert.deepEqual(holdings, [
    { quantity: 12, institution_value: 300000, cost_basis: 240000, updated_at: '2026-07-03T00:00:00.000Z' },
  ]);
});
