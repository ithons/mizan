import test from 'node:test';
import assert from 'node:assert/strict';
import { externalMarketFlow, portfolioExternalFlows } from '../server/src/services/portfolioFlows';
import { netWorthTimeline } from '../server/src/services/netWorthTimeline';
import { getPortfolioDelta } from '../client/src/lib/investmentAnalytics';
import { insertAccount, insertTransaction, migratedTestDb } from './helpers/schema';

test('only money moved in or out of the portfolio is a flow; a trade inside it is not', () => {
  const db = migratedTestDb();
  const fid = insertAccount(db, { type: 'brokerage' });
  const deposit = insertTransaction(db, { account_id: fid, date: '2026-10-05', amount: 10000, original_name: 'Electronic Funds Transfer Received (Cash)' });
  db.prepare("UPDATE transactions SET transfer_status = 'confirmed', transfer_pair_id = 'x' WHERE id = ?").run(deposit);
  const buy = insertTransaction(db, { account_id: fid, date: '2026-10-05', amount: -10000, original_name: 'YOU BOUGHT FSKAX', category_id: 'cat_inv_transfer' });
  db.prepare('UPDATE transactions SET is_internal_trade = 1 WHERE id = ?').run(buy);
  insertTransaction(db, { account_id: fid, date: '2026-10-13', amount: 10000, original_name: 'Electronic Funds Transfer Received (Cash)', category_id: 'cat_inv_transfer' });
  insertTransaction(db, { account_id: fid, date: '2026-09-30', amount: 5, original_name: 'DIVIDEND RECEIVED', category_id: 'cat_inv_dividend' });

  assert.deepEqual(portfolioExternalFlows(db, [fid]), [
    { date: '2026-10-05', amount: 10000 },
    { date: '2026-10-13', amount: 10000 },
  ]);
});

test('the change since a snapshot is what the market did, with deposits named apart', () => {
  const history = [
    { date: '2026-10-01', value: 3513, estimated: false, covered_accounts: 3 },
    { date: '2026-10-15', value: 3716, estimated: false, covered_accounts: 3 },
  ];
  const flows = [
    { date: '2026-09-28', amount: 100 },
    { date: '2026-10-05', amount: 100 },
    { date: '2026-10-13', amount: 100 },
  ];
  const delta = getPortfolioDelta(3716, history, 3, flows);
  assert.ok(delta);
  assert.equal(delta.deposited, 200, 'the 28 September deposit predates the baseline');
  assert.equal(delta.change, 3, '$203 of change was $200 the owner put in');
  assert.equal(getPortfolioDelta(3716, history, 3)?.change, 203, 'with no flows known, nothing is subtracted');
});

test('a crypto wallet counts its buys and sells as the money in and out, and holds deposits flat', () => {
  const db = migratedTestDb();
  const coinbase = insertAccount(db, { type: 'crypto_wallet' });
  insertTransaction(db, { account_id: coinbase, date: '2026-09-02', amount: 5000, original_name: 'Coinbase deposit', category_id: 'cat_xfer_in' });
  insertTransaction(db, { account_id: coinbase, date: '2026-09-02', amount: -5000, original_name: 'Buy BTC', category_id: 'cat_crypto_buy' });
  insertTransaction(db, { account_id: coinbase, date: '2026-09-20', amount: 1200, original_name: 'Sell ETH', category_id: 'cat_crypto_sell' });
  assert.deepEqual(portfolioExternalFlows(db, [coinbase]), [
    { date: '2026-09-02', amount: 5000 },
    { date: '2026-09-20', amount: -1200 },
  ]);
});

test('a buy paid with cash already in an IRA is no outside money, to the flows and to the timeline alike', () => {
  const db = migratedTestDb();
  const roth = insertAccount(db, { type: 'ira_roth', current_balance: 100000 });
  const contribution = insertTransaction(db, { account_id: roth, date: '2026-10-14', amount: 100000, category_id: 'cat_inv_transfer' });
  db.prepare("UPDATE transactions SET transfer_status = 'confirmed', transfer_pair_id = 'p' WHERE id = ?").run(contribution);
  const buy = insertTransaction(db, { account_id: roth, date: '2026-10-16', amount: -19983, original_name: 'Investment Buy', category_id: 'cat_inv_buy' });
  db.prepare('UPDATE transactions SET is_internal_trade = 1 WHERE id = ?').run(buy);

  assert.deepEqual(portfolioExternalFlows(db, [roth]), [{ date: '2026-10-14', amount: 100000 }]);
  const timeline = netWorthTimeline(db, { from: '2026-10-14', to: '2026-10-19', today: '2026-10-19' });
  const on = (date: string) => timeline.points.find((p) => p.date === date)?.by_account[roth];
  assert.equal(on('2026-10-15'), 100000, 'the internal buy is not replayed as a contribution');
  assert.equal(on('2026-10-14'), 100000);
});

test('HEALTHY: the flows and the per-row rule agree on a mixed ledger', () => {
  const db = migratedTestDb();
  const fid = insertAccount(db, { type: 'brokerage' });
  const coinbase = insertAccount(db, { type: 'crypto_wallet' });
  const paired = insertTransaction(db, { account_id: fid, date: '2026-09-01', amount: 30000 });
  db.prepare("UPDATE transactions SET transfer_status = 'confirmed', transfer_pair_id = 'q' WHERE id = ?").run(paired);
  const internal = insertTransaction(db, { account_id: fid, date: '2026-09-02', amount: -30000, category_id: 'cat_inv_transfer' });
  db.prepare('UPDATE transactions SET is_internal_trade = 1 WHERE id = ?').run(internal);
  insertTransaction(db, { account_id: fid, date: '2026-09-03', amount: 41, category_id: 'cat_inv_dividend' });
  insertTransaction(db, { account_id: coinbase, date: '2026-09-03', amount: -2500, category_id: 'cat_crypto_buy' });
  insertTransaction(db, { account_id: coinbase, date: '2026-09-04', amount: 900, category_id: 'cat_crypto_sell' });
  insertTransaction(db, { account_id: coinbase, date: '2026-09-04', amount: 700, category_id: 'cat_xfer_in' });

  const rows = db.prepare(`
    SELECT t.date, t.amount, t.category_id, t.transfer_status, t.is_internal_trade, a.type
    FROM transactions t JOIN accounts a ON a.id = t.account_id
  `).all() as Array<{ date: string; amount: number; category_id: string | null; transfer_status: string | null; is_internal_trade: number; type: string }>;
  const expected = new Map<string, number>();
  for (const row of rows) expected.set(row.date, (expected.get(row.date) ?? 0) + externalMarketFlow(row, row.type));
  assert.deepEqual(
    portfolioExternalFlows(db, [fid, coinbase]),
    [...expected].filter(([, amount]) => amount !== 0).map(([date, amount]) => ({ date, amount })),
  );
  assert.deepEqual(portfolioExternalFlows(db, [fid, coinbase]), [
    { date: '2026-09-01', amount: 30000 },
    { date: '2026-09-03', amount: 2500 },
    { date: '2026-09-04', amount: -900 },
  ]);
});
