import test from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { migratedTestDb, insertAccount, TEST_NOW } from './helpers/schema';
import {
  syncCoinbaseLedger,
  upsertCoinbaseTransaction,
  type CoinbaseV2Request,
  type CoinbaseV2Transaction,
} from '../server/src/services/coinbase';

function txn(id: string, over: Partial<CoinbaseV2Transaction> = {}): CoinbaseV2Transaction {
  return {
    id,
    type: 'send',
    status: 'completed',
    amount: { amount: '-0.1', currency: 'BTC' },
    native_amount: { amount: '-7800', currency: 'USD' },
    created_at: '2026-09-01T15:00:00Z',
    ...over,
  };
}

const reward = (id: string) => txn(id, { type: 'staking_reward', amount: { amount: '0.4', currency: 'SOL' }, native_amount: { amount: '60', currency: 'USD' } });

// One sub-account; `pages` are its transaction pages, newest first, each linked to the next.
function stub(pages: CoinbaseV2Transaction[][]): { request: CoinbaseV2Request; paths: string[] } {
  const paths: string[] = [];
  const request = (async (path: string) => {
    paths.push(path);
    if (path.startsWith('/v2/accounts?')) return { data: [{ id: 'sub' }] };
    const index = Number(new URL(path, 'https://x').searchParams.get('page') ?? '0');
    const next = index + 1 < pages.length ? `/v2/accounts/sub/transactions?limit=100&page=${index + 1}` : null;
    return { data: pages[index], pagination: { next_uri: next } };
  }) as CoinbaseV2Request;
  return { request, paths };
}

function walletWithImported(ids: string[]): { db: Database.Database; account: string } {
  const db = migratedTestDb();
  const account = insertAccount(db, { type: 'crypto_wallet', connection_type: 'coinbase' });
  for (const id of ids) {
    upsertCoinbaseTransaction(db, {
      coinbaseTransactionId: id, accountId: account, date: '2026-09-01', amountCents: -780000,
      originalName: 'Send BTC', categoryId: 'cat_xfer_out', units: { ticker: 'BTC', quantity: -0.1 }, now: TEST_NOW,
    });
  }
  return { db, account };
}

const transactionPages = (paths: string[]) => paths.filter((p) => p.includes('/transactions'));

test('HEALTHY: a first page of only known rows stops the walk after one request', async () => {
  const { db } = walletWithImported(['a', 'b']);
  const { request, paths } = stub([[txn('a'), txn('b')], [txn('old')]]);

  assert.equal(await syncCoinbaseLedger(db, request, TEST_NOW), 0);
  assert.equal(transactionPages(paths).length, 1);
});

test('a page of rewards beside settled rows stops the walk', async () => {
  const { db } = walletWithImported(['a']);
  const { request, paths } = stub([[reward('r1'), txn('a'), reward('r2')], [txn('old')]]);

  await syncCoinbaseLedger(db, request, TEST_NOW);
  assert.equal(transactionPages(paths).length, 1);
});

test('a pending row keeps the walk going, so it is imported once it completes', async () => {
  const { db } = walletWithImported(['a', 'b']);
  const { request, paths } = stub([[txn('p', { status: 'pending' }), txn('a')], [txn('b')], [txn('older')]]);

  await syncCoinbaseLedger(db, request, TEST_NOW);
  assert.equal(transactionPages(paths).length, 2);
});
