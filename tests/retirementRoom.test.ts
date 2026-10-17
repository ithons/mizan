import test from 'node:test';
import assert from 'node:assert/strict';
import { retirementRoom } from '../server/src/services/retirementRoom';
import { insertAccount, insertTransaction, migratedTestDb } from './helpers/schema';

function ledger(paid: number) {
  const db = migratedTestDb();
  const checking = insertAccount(db, { type: 'checking' });
  const roth = insertAccount(db, { type: 'ira_roth', account_name: 'Roth' });
  insertTransaction(db, { account_id: checking, date: '2026-05-01', amount: paid, category_id: 'cat_income_paycheck' });
  insertTransaction(db, { account_id: roth, date: '2026-02-09', amount: 10000, category_id: 'cat_inv_transfer' });
  insertTransaction(db, { account_id: roth, date: '2026-06-22', amount: 38, category_id: 'cat_inv_dividend' });
  insertTransaction(db, { account_id: roth, date: '2025-12-30', amount: 50000, category_id: 'cat_inv_transfer' });
  return db;
}

test('room is the limit less this year\'s deposits, not counting dividends or last year', () => {
  const result = retirementRoom(ledger(1477489), 7500, 2026);
  assert.ok(!('error' in result));
  assert.equal(result.contributed, 100);
  assert.equal(result.room_left, 7400);
  assert.deepEqual(result.possibly_for_prior_year, ['2026-02-09']);
});

test('room never exceeds earned income', () => {
  const result = retirementRoom(ledger(300000), 7500, 2026);
  assert.ok(!('error' in result) && result.room_left === 2900);
});

test('no limit from the owner, no figure', () => {
  assert.ok('error' in retirementRoom(ledger(1477489), 0, 2026));
});
