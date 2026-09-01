import test from 'node:test';
import assert from 'node:assert/strict';
import { migratedTestDb, insertAccount } from './helpers/schema';
import {
  coinbaseAccountsOrThrow,
  upsertCoinbaseHolding,
  zeroStaleCoinbaseHoldings,
} from '../server/src/services/coinbase';

const NOW = '2026-09-01T00:00:00.000Z';

function withTwoCoins() {
  const db = migratedTestDb();
  insertAccount(db, { id: 'acct_cb', type: 'crypto_wallet', connection_type: 'coinbase' });
  upsertCoinbaseHolding(db, 'acct_cb', 'BTC', 0.5, 60000, 30000, NOW);
  upsertCoinbaseHolding(db, 'acct_cb', 'ETH', 2, 2000, 4000, NOW);
  return db;
}

function heldValues(db: ReturnType<typeof migratedTestDb>): Array<{ ticker: string; value: number }> {
  return db
    .prepare(
      `SELECT s.ticker AS ticker, h.institution_value AS value
         FROM holdings h JOIN securities s ON s.id = h.security_id
        WHERE h.account_id = 'acct_cb' ORDER BY s.ticker`
    )
    .all() as Array<{ ticker: string; value: number }>;
}

test('a 200 with no accounts array is refused, not read as zero holdings', () => {
  // The real shapes this produces: a maintenance page, a JSON error envelope, a null body.
  for (const body of [{}, { error: 'unavailable' }, null, undefined, { accounts: null }, 'nope']) {
    assert.throws(
      () => coinbaseAccountsOrThrow(body),
      /refusing to read an unreadable response as zero holdings/,
      `accepted ${JSON.stringify(body)} as a valid empty account list`
    );
  }
});

test('HEALTHY: a well-formed page is returned untouched, including a legitimately empty one', () => {
  const rows = [{ uuid: 'u', name: 'BTC Wallet', currency: 'BTC', available_balance: { value: '0.5', currency: 'BTC' }, type: 'ACCOUNT_TYPE_CRYPTO' }];
  assert.deepEqual(coinbaseAccountsOrThrow({ accounts: rows }), rows);
  // An account list that is genuinely empty is a real answer and must pass.
  assert.deepEqual(coinbaseAccountsOrThrow({ accounts: [] }), []);
});

test('an empty feed leaves every holding alone rather than zeroing the whole position', () => {
  const db = withTwoCoins();
  const before = heldValues(db);

  // No account rows at all: the unreadable case. Nothing about the holdings was said.
  const zeroed = zeroStaleCoinbaseHoldings(db, 'acct_cb', new Set(), 0, NOW);

  assert.equal(zeroed, 0);
  assert.deepEqual(heldValues(db), before, 'total absence was read as total sale');
  db.close();
});

test('a genuine sell-out still zeroes, because the feed returned rows', () => {
  const db = withTwoCoins();

  // Coinbase returned two account rows, both at zero balance, so neither reached seenCurrencies.
  // This is the case the zero-out pass exists for and it must still work.
  const zeroed = zeroStaleCoinbaseHoldings(db, 'acct_cb', new Set(), 2, NOW);

  assert.equal(zeroed, 2);
  assert.deepEqual(heldValues(db), [
    { ticker: 'BTC', value: 0 },
    { ticker: 'ETH', value: 0 },
  ]);
  db.close();
});

test('HEALTHY: one coin sold out of two zeroes only that coin', () => {
  const db = withTwoCoins();

  const zeroed = zeroStaleCoinbaseHoldings(db, 'acct_cb', new Set(['BTC']), 2, NOW);

  assert.equal(zeroed, 1);
  assert.deepEqual(heldValues(db), [
    { ticker: 'BTC', value: 3000000 },
    { ticker: 'ETH', value: 0 },
  ]);
  db.close();
});

test('HEALTHY: nothing sold zeroes nothing and reports nothing', () => {
  const db = withTwoCoins();
  const before = heldValues(db);

  const zeroed = zeroStaleCoinbaseHoldings(db, 'acct_cb', new Set(['BTC', 'ETH']), 2, NOW);

  assert.equal(zeroed, 0);
  assert.deepEqual(heldValues(db), before);
  db.close();
});
