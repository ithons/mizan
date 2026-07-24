import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = fs.readFileSync(
  path.join(here, '../server/src/db/migrations/033_coinbase_single_account.sql'),
  'utf-8'
);

// Minimal schema covering only what migration 033 touches.
function setupDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      coinbase_account_id TEXT,
      connection_type TEXT NOT NULL,
      type TEXT NOT NULL,
      account_name TEXT NOT NULL,
      current_balance INTEGER NOT NULL DEFAULT 0,
      backfill_floor_date TEXT,
      native_currency TEXT,
      native_balance REAL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE transactions (id TEXT PRIMARY KEY, account_id TEXT NOT NULL);
    CREATE TABLE holdings (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL, security_id TEXT NOT NULL,
      UNIQUE(account_id, security_id)
    );
    CREATE TABLE holdings_history (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL, security_id TEXT NOT NULL, date TEXT NOT NULL,
      UNIQUE(account_id, security_id, date)
    );
  `);
  return db;
}

function seedThreeCoinAccounts(db: Database.Database) {
  // Three per-coin Coinbase accounts (BTC earliest = survivor), one non-Coinbase account.
  const acct = db.prepare(
    'INSERT INTO accounts (id, coinbase_account_id, connection_type, type, account_name, current_balance, backfill_floor_date, native_currency, native_balance, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
  );
  acct.run('cb_btc', 'uuid-btc', 'coinbase', 'crypto_wallet', 'BTC', 300000, '2024-02-01', 'BTC', 0.5, '2024-01-01', '2024-01-01');
  acct.run('cb_eth', 'uuid-eth', 'coinbase', 'crypto_wallet', 'ETH', 90000, '2024-01-15', 'ETH', 3, '2024-03-01', '2024-03-01');
  acct.run('cb_sol', 'uuid-sol', 'coinbase', 'crypto_wallet', 'SOL', 10000, null, 'SOL', 12, '2024-05-01', '2024-05-01');
  acct.run('chk', null, 'simplefin', 'checking', 'Checking', 500000, null, null, null, '2024-01-01', '2024-01-01');

  const tx = db.prepare('INSERT INTO transactions (id, account_id) VALUES (?,?)');
  tx.run('t_btc', 'cb_btc');
  tx.run('t_eth', 'cb_eth');
  tx.run('t_sol', 'cb_sol');
  tx.run('t_chk', 'chk');

  const h = db.prepare('INSERT INTO holdings (id, account_id, security_id) VALUES (?,?,?)');
  h.run('h_btc', 'cb_btc', 'sec_btc');
  h.run('h_eth', 'cb_eth', 'sec_eth');
  h.run('h_sol', 'cb_sol', 'sec_sol');

  const hh = db.prepare('INSERT INTO holdings_history (id, account_id, security_id, date) VALUES (?,?,?,?)');
  hh.run('hh_btc', 'cb_btc', 'sec_btc', '2024-06-01');
  hh.run('hh_eth', 'cb_eth', 'sec_eth', '2024-06-01');
}

test('migration 033 leaves exactly one Coinbase account and preserves net worth', (t) => {
  const db = setupDb();
  t.after(() => db.close());
  seedThreeCoinAccounts(db);

  const before = db.prepare('SELECT COALESCE(SUM(current_balance),0) AS n FROM accounts').get() as { n: number };
  db.exec(MIGRATION);
  const after = db.prepare('SELECT COALESCE(SUM(current_balance),0) AS n FROM accounts').get() as { n: number };

  // Net-worth invariant: total balance across ALL accounts is unchanged.
  assert.equal(after.n, before.n);

  const cb = db.prepare("SELECT * FROM accounts WHERE connection_type='coinbase' AND type='crypto_wallet'").all() as Array<Record<string, unknown>>;
  assert.equal(cb.length, 1, 'exactly one Coinbase account survives');
  const survivor = cb[0];
  assert.equal(survivor.id, 'cb_btc', 'earliest-created account is the survivor');
  assert.equal(survivor.current_balance, 400000, 'balance is the sum of the three coins');
  assert.equal(survivor.backfill_floor_date, '2024-01-15', 'floor is the min of the coins');
  assert.equal(survivor.coinbase_account_id, null, 'coinbase_account_id cleared');
  assert.equal(survivor.native_currency, null, 'native_currency retired');
  assert.equal(survivor.native_balance, null, 'native_balance retired');
  assert.equal(survivor.account_name, 'Coinbase', 'consolidated name');
});

test('migration 033 reassigns all children to the survivor (no orphans, no cascade loss)', (t) => {
  const db = setupDb();
  t.after(() => db.close());
  seedThreeCoinAccounts(db);
  db.exec(MIGRATION);

  const txAccts = db.prepare("SELECT DISTINCT account_id FROM transactions WHERE id LIKE 't_%' AND id != 't_chk'").all() as Array<{ account_id: string }>;
  assert.deepEqual(txAccts, [{ account_id: 'cb_btc' }], 'all Coinbase transactions moved to survivor');

  const holdings = db.prepare('SELECT account_id FROM holdings ORDER BY security_id').all() as Array<{ account_id: string }>;
  assert.equal(holdings.length, 3, 'all three holdings survive');
  assert.ok(holdings.every((h) => h.account_id === 'cb_btc'), 'holdings reassigned to survivor');

  const hh = db.prepare('SELECT COUNT(*) AS n FROM holdings_history WHERE account_id = ?').get('cb_btc') as { n: number };
  assert.equal(hh.n, 2, 'holdings_history reassigned to survivor');

  const chk = db.prepare("SELECT account_id FROM transactions WHERE id = 't_chk'").get() as { account_id: string };
  assert.equal(chk.account_id, 'chk', 'non-Coinbase account is untouched');
});

test('migration 033 is a safe no-op when there are no Coinbase accounts', (t) => {
  const db = setupDb();
  t.after(() => db.close());
  db.prepare('INSERT INTO accounts (id, connection_type, type, account_name, current_balance, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
    .run('chk', 'simplefin', 'checking', 'Checking', 500000, '2024-01-01', '2024-01-01');

  assert.doesNotThrow(() => db.exec(MIGRATION));
  const n = db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number };
  assert.equal(n.n, 1);
});
