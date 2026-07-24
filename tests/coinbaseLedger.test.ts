import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCoinbaseLedgerTx, type CoinbaseV2Transaction } from '../server/src/services/coinbase';

function txn(over: Partial<CoinbaseV2Transaction> & { type: string }): CoinbaseV2Transaction {
  return {
    id: 't1',
    status: 'completed',
    amount: { amount: '0', currency: 'BTC' },
    native_amount: { amount: '0', currency: 'USD' },
    created_at: '2026-05-01T00:00:00Z',
    ...over,
  };
}

test('convert legs: coin out is a sell (money in), coin in is a buy (money out)', () => {
  const sell = classifyCoinbaseLedgerTx(txn({
    type: 'trade', amount: { amount: '-0.5', currency: 'BTC' }, native_amount: { amount: '-30000.00', currency: 'USD' },
  }));
  assert.deepEqual(sell, { categoryId: 'cat_crypto_sell', signedCents: 3000000, merchant: 'Convert sold BTC' });

  const buy = classifyCoinbaseLedgerTx(txn({
    type: 'trade', amount: { amount: '9.9', currency: 'ETH' }, native_amount: { amount: '30000.00', currency: 'USD' },
  }));
  assert.deepEqual(buy, { categoryId: 'cat_crypto_buy', signedCents: -3000000, merchant: 'Convert bought ETH' });
});

test('send out is a transfer out; receive is a transfer in', () => {
  const send = classifyCoinbaseLedgerTx(txn({
    type: 'send', amount: { amount: '-0.1', currency: 'BTC' }, native_amount: { amount: '-6000.00', currency: 'USD' },
  }));
  assert.deepEqual(send, { categoryId: 'cat_xfer_out', signedCents: -600000, merchant: 'Send BTC' });

  const recv = classifyCoinbaseLedgerTx(txn({
    type: 'receive', amount: { amount: '0.1', currency: 'BTC' }, native_amount: { amount: '6000.00', currency: 'USD' },
  }));
  assert.deepEqual(recv, { categoryId: 'cat_xfer_in', signedCents: 600000, merchant: 'Receive BTC' });

  // A 'send' with a positive native amount is an inbound transfer (some receives report as 'send').
  const sendIn = classifyCoinbaseLedgerTx(txn({
    type: 'send', amount: { amount: '0.2', currency: 'ETH' }, native_amount: { amount: '400.00', currency: 'USD' },
  }));
  assert.equal(sendIn?.categoryId, 'cat_xfer_in');
  assert.equal(sendIn?.signedCents, 40000);
});

test('fiat deposit/withdrawal map to transfer in/out', () => {
  assert.deepEqual(
    classifyCoinbaseLedgerTx(txn({ type: 'fiat_deposit', native_amount: { amount: '1000.00', currency: 'USD' } })),
    { categoryId: 'cat_xfer_in', signedCents: 100000, merchant: 'Coinbase deposit' }
  );
  assert.deepEqual(
    classifyCoinbaseLedgerTx(txn({ type: 'fiat_withdrawal', native_amount: { amount: '-250.00', currency: 'USD' } })),
    { categoryId: 'cat_xfer_out', signedCents: -25000, merchant: 'Coinbase withdrawal' }
  );
});

test('buy/sell are skipped (v3 owns them); unknown types and non-completed are skipped', () => {
  assert.equal(classifyCoinbaseLedgerTx(txn({ type: 'buy', native_amount: { amount: '100', currency: 'USD' } })), null);
  assert.equal(classifyCoinbaseLedgerTx(txn({ type: 'sell', native_amount: { amount: '100', currency: 'USD' } })), null);
  assert.equal(classifyCoinbaseLedgerTx(txn({ type: 'advanced_trade_fill', native_amount: { amount: '100', currency: 'USD' } })), null);
  assert.equal(classifyCoinbaseLedgerTx(txn({ type: 'staking_transfer', native_amount: { amount: '100', currency: 'USD' } })), null);
  assert.equal(classifyCoinbaseLedgerTx(txn({ type: 'trade', status: 'pending', amount: { amount: '-1', currency: 'BTC' }, native_amount: { amount: '-10', currency: 'USD' } })), null);
  assert.equal(classifyCoinbaseLedgerTx(txn({ type: 'receive', native_amount: { amount: 'not-a-number', currency: 'USD' } })), null);
});
