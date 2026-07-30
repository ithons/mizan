import test from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { migratedTestDb, insertAccount, insertCategory, TEST_NOW } from './helpers/schema';
import {
  classifyCoinbaseLedgerTx,
  coinbaseLedgerUnits,
  coinbaseOrderUnits,
  upsertCoinbaseTransaction,
  type CoinbaseFilledOrder,
  type CoinbaseV2Transaction,
} from '../server/src/services/coinbase';

/**
 * Migration 046 exists so Coinbase's unit counts stop being parsed and discarded. Nothing consumes
 * them yet, so what is under test is only that they are recorded faithfully: the right sign, on
 * both import paths, once, and never invented for a row that carries none.
 */

function cryptoAccount(db: Database.Database): string {
  return insertAccount(db, { type: 'crypto_wallet', connection_type: 'coinbase' });
}

function filledOrder(over: Partial<CoinbaseFilledOrder> = {}): CoinbaseFilledOrder {
  return {
    order_id: 'order_1',
    product_id: 'BTC-USD',
    side: 'BUY',
    status: 'FILLED',
    filled_size: '0.0031964',
    average_filled_price: '78000',
    created_time: '2026-02-01T15:04:05Z',
    total_fees: '0.99',
    total_value_after_fees: '251.45',
    ...over,
  };
}

function ledgerTxn(over: Partial<CoinbaseV2Transaction> & { type: string }): CoinbaseV2Transaction {
  return {
    id: 'cb_1',
    status: 'completed',
    amount: { amount: '0', currency: 'BTC' },
    native_amount: { amount: '0', currency: 'USD' },
    created_at: '2026-05-01T00:00:00Z',
    ...over,
  };
}

test('units land on a v3 filled order, signed by side', () => {
  assert.deepEqual(coinbaseOrderUnits(filledOrder(), 'BUY'), { ticker: 'BTC', quantity: 0.0031964 });
  assert.deepEqual(
    coinbaseOrderUnits(filledOrder({ product_id: 'LINK-USD', filled_size: '2.57' }), 'SELL'),
    { ticker: 'LINK', quantity: -2.57 }
  );
});

test('an order with no usable units yields none rather than a guess', () => {
  assert.equal(coinbaseOrderUnits(filledOrder({ filled_size: '' }), 'BUY'), null);
  assert.equal(coinbaseOrderUnits(filledOrder({ filled_size: 'n/a' }), 'BUY'), null);
  assert.equal(coinbaseOrderUnits(filledOrder({ product_id: '' }), 'BUY'), null);
});

test('units land on a v2 ledger row the classifier imports', () => {
  const send = ledgerTxn({
    type: 'send',
    amount: { amount: '-0.1', currency: 'BTC' },
    native_amount: { amount: '-7800', currency: 'USD' },
  });
  assert.notEqual(classifyCoinbaseLedgerTx(send), null);
  assert.deepEqual(coinbaseLedgerUnits(send), { ticker: 'BTC', quantity: -0.1 });

  const deposit = ledgerTxn({
    type: 'fiat_deposit',
    amount: { amount: '500', currency: 'USD' },
    native_amount: { amount: '500', currency: 'USD' },
  });
  assert.notEqual(classifyCoinbaseLedgerTx(deposit), null);
  assert.deepEqual(coinbaseLedgerUnits(deposit), { ticker: 'USD', quantity: 500 });
});

test('a ledger row with no usable units yields none rather than a guess', () => {
  assert.equal(coinbaseLedgerUnits(ledgerTxn({ type: 'send', amount: { amount: '1', currency: '' } })), null);
  assert.equal(coinbaseLedgerUnits(ledgerTxn({ type: 'send', amount: { amount: 'n/a', currency: 'BTC' } })), null);
});

test('a row the classifier skips writes no units, because it writes no row', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const account = cryptoAccount(db);
  // Rewards and interest are real, automatic, and deliberately not imported: syncCoinbaseLedger
  // does `if (!classified) continue` before it ever reaches the write path. This is the hole that
  // makes any lot replay over these rows wrong rather than merely incomplete.
  const skipped = [
    ledgerTxn({ type: 'staking_reward', amount: { amount: '0.4', currency: 'SOL' } }),
    ledgerTxn({ type: 'interest', amount: { amount: '1.2', currency: 'USDC' } }),
    ledgerTxn({ type: 'inflation_reward', amount: { amount: '0.02', currency: 'ATOM' } }),
    ledgerTxn({ type: 'send', status: 'pending', amount: { amount: '-0.1', currency: 'BTC' } }),
  ];
  for (const txn of skipped) {
    assert.equal(classifyCoinbaseLedgerTx(txn), null, `${txn.type}/${txn.status} should be skipped`);
    // The units themselves parse fine; the row is dropped upstream of the write, so nothing is
    // stored and no security is created for a coin the ledger never accounts for.
    assert.notEqual(coinbaseLedgerUnits(txn), null);
  }

  const stored = db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE account_id = ?').get(account) as { n: number };
  assert.equal(stored.n, 0);
  const securities = db.prepare('SELECT COUNT(*) AS n FROM securities').get() as { n: number };
  assert.equal(securities.n, 0);
});

test('units survive a re-sync without duplicating the row', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const account = cryptoAccount(db);
  const write = {
    coinbaseTransactionId: 'order_1',
    accountId: account,
    date: '2026-02-01',
    amountCents: -25145,
    originalName: 'Buy BTC',
    categoryId: insertCategory(db, { name: 'Crypto buy' }),
    units: coinbaseOrderUnits(filledOrder(), 'BUY'),
    now: TEST_NOW,
  };

  assert.equal(upsertCoinbaseTransaction(db, write), 'inserted');
  assert.equal(upsertCoinbaseTransaction(db, write), 'unchanged');

  const rows = db.prepare(
    'SELECT quantity, security_id, amount FROM transactions WHERE coinbase_transaction_id = ?'
  ).all('order_1') as Array<{ quantity: number | null; security_id: string | null; amount: number }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].quantity, 0.0031964);
  assert.equal(rows[0].amount, -25145);

  const securities = db.prepare("SELECT COUNT(*) AS n FROM securities WHERE ticker = 'BTC'").get() as { n: number };
  assert.equal(securities.n, 1);
});

test('a row imported before units existed acquires them on the next sync, once', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const account = cryptoAccount(db);
  const base = {
    coinbaseTransactionId: 'order_2',
    accountId: account,
    date: '2026-02-01',
    amountCents: -2496,
    originalName: 'Buy LINK',
    categoryId: insertCategory(db, { name: 'Crypto buy' }),
    now: TEST_NOW,
  };

  assert.equal(upsertCoinbaseTransaction(db, { ...base, units: null }), 'inserted');
  assert.equal(upsertCoinbaseTransaction(db, { ...base, units: { ticker: 'LINK', quantity: 2.57 } }), 'units_backfilled');
  // Already known: a second pass must not rewrite them, so a later correction cannot be undone.
  assert.equal(upsertCoinbaseTransaction(db, { ...base, units: { ticker: 'LINK', quantity: 99 } }), 'unchanged');

  const row = db.prepare(
    'SELECT quantity, security_id FROM transactions WHERE coinbase_transaction_id = ?'
  ).get('order_2') as { quantity: number | null; security_id: string | null };
  assert.equal(row.quantity, 2.57);
  const ticker = db.prepare('SELECT ticker FROM securities WHERE id = ?').get(row.security_id) as { ticker: string };
  assert.equal(ticker.ticker, 'LINK');
});

// The healthy cases. Nothing here may write a cost basis, invent units, or leave the owner a state
// they cannot act on: recording units is meant to be invisible until an importer can use them.

test('healthy: importing an ordinary multi-coin history leaves every cost_basis NULL', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const account = cryptoAccount(db);
  const categoryId = insertCategory(db, { name: 'Crypto buy' });
  const orders: Array<[string, string, number]> = [
    ['BTC-USD', '0.0031964', -25145],
    ['ETH-USD', '0.06337736', -15000],
    ['LINK-USD', '2.57', -2496],
    ['POL-USD', '237.3', -2500],
    ['SOL-USD', '0.23954999', -2500],
    ['AVAX-USD', '2.48', -2499],
  ];

  for (const [productId, filledSize, amountCents] of orders) {
    const order = filledOrder({ order_id: `order_${productId}`, product_id: productId, filled_size: filledSize });
    const units = coinbaseOrderUnits(order, 'BUY');
    if (!units) throw new Error(`healthy fixture produced no units for ${productId}`);
    upsertCoinbaseTransaction(db, {
      coinbaseTransactionId: order.order_id,
      accountId: account,
      date: '2026-02-01',
      amountCents,
      originalName: `Buy ${units.ticker}`,
      categoryId,
      units,
      now: TEST_NOW,
    });
    db.prepare(`
      INSERT INTO holdings
        (id, account_id, security_id, quantity, institution_price, institution_value,
         cost_basis, currency, updated_at)
      VALUES (?, ?, (SELECT id FROM securities WHERE ticker = ?), ?, 1, ?, NULL, 'USD', ?)
    `).run(`hold_${productId}`, account, units.ticker, units.quantity, Math.abs(amountCents), TEST_NOW);
  }

  // A second sync of the identical history, which is what actually happens every hour.
  for (const [productId, filledSize] of orders) {
    const order = filledOrder({ order_id: `order_${productId}`, product_id: productId, filled_size: filledSize });
    assert.equal(
      upsertCoinbaseTransaction(db, {
        coinbaseTransactionId: order.order_id,
        accountId: account,
        date: '2026-02-01',
        amountCents: -1,
        originalName: 'Buy',
        categoryId,
        units: coinbaseOrderUnits(order, 'BUY'),
        now: TEST_NOW,
      }),
      'unchanged'
    );
  }

  const written = db.prepare(
    'SELECT COUNT(*) AS n, SUM(quantity IS NULL) AS unitless FROM transactions WHERE account_id = ?'
  ).get(account) as { n: number; unitless: number };
  assert.equal(written.n, orders.length);
  assert.equal(written.unitless, 0);

  const bases = db.prepare(
    'SELECT cost_basis, manual_cost_basis FROM holdings WHERE account_id = ?'
  ).all(account) as Array<{ cost_basis: number | null; manual_cost_basis: number | null }>;
  assert.equal(bases.length, orders.length);
  for (const row of bases) {
    assert.equal(row.cost_basis, null);
    assert.equal(row.manual_cost_basis, null);
  }
});

test('healthy: an owner-set manual basis is the only basis anything writes', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const account = cryptoAccount(db);
  const securityId = 'sec_btc_manual';
  db.prepare("INSERT INTO securities (id, ticker, name, type, currency) VALUES (?, 'BTC', 'BTC', 'crypto', 'USD')")
    .run(securityId);
  db.prepare(`
    INSERT INTO holdings
      (id, account_id, security_id, quantity, institution_price, institution_value,
       cost_basis, manual_cost_basis, currency, updated_at)
    VALUES ('hold_manual', ?, ?, 0.0031964, 78000, 25000, NULL, 12345, 'USD', ?)
  `).run(account, securityId, TEST_NOW);

  upsertCoinbaseTransaction(db, {
    coinbaseTransactionId: 'order_manual',
    accountId: account,
    date: '2026-02-01',
    amountCents: -25145,
    originalName: 'Buy BTC',
    categoryId: insertCategory(db, { name: 'Crypto buy' }),
    units: coinbaseOrderUnits(filledOrder(), 'BUY'),
    now: TEST_NOW,
  });

  const row = db.prepare("SELECT cost_basis, manual_cost_basis FROM holdings WHERE id = 'hold_manual'").get() as {
    cost_basis: number | null;
    manual_cost_basis: number | null;
  };
  assert.equal(row.cost_basis, null);
  assert.equal(row.manual_cost_basis, 12345);
});
