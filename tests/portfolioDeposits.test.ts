import test from 'node:test';
import assert from 'node:assert/strict';
import { portfolioExternalFlows } from '../server/src/services/portfolioFlows';
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
