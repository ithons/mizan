import test from 'node:test';
import assert from 'node:assert/strict';
import { listTransactions, searchedAmountCents } from '../server/src/services/transactions';
import { insertAccount, insertTransaction, migratedTestDb } from './helpers/schema';

test('a search that reads as money is matched on the amount, either sign', () => {
  const db = migratedTestDb();
  const account = insertAccount(db);
  insertTransaction(db, { account_id: account, amount: -10000, merchant_name: 'Fidelity Brokerage Services' });
  insertTransaction(db, { account_id: account, amount: 10000, merchant_name: 'Electronic Funds Transfer Received' });
  insertTransaction(db, { account_id: account, amount: -10050, merchant_name: 'Cava' });

  const found = (search: string) =>
    listTransactions(db, { search, limit: 50, page: 1, sortBy: 'date', sortDir: 'desc', accountIds: [], categoryIds: [] })
      .rows.map((row) => row.merchant_name).sort();
  assert.deepEqual(found('100.00'), ['Electronic Funds Transfer Received', 'Fidelity Brokerage Services']);
  assert.deepEqual(found('$100'), ['Electronic Funds Transfer Received', 'Fidelity Brokerage Services']);
  assert.deepEqual(found('cava'), ['Cava']);
});

test('only a money figure is read as one', () => {
  assert.equal(searchedAmountCents('2,495.81'), 249581);
  assert.equal(searchedAmountCents('-25.5'), 2550);
  assert.equal(searchedAmountCents('7-Eleven'), null);
  assert.equal(searchedAmountCents('1.234'), null);
  assert.equal(searchedAmountCents('10078 CAVA'), null);
});

test('a transfer is listed once, as the leg that left, unless only the arriving account is shown', () => {
  const db = migratedTestDb();
  const chase = insertAccount(db, { account_name: 'Chase Checking' });
  const fid = insertAccount(db, { account_name: 'Fidelity Individual', type: 'brokerage' });
  const out = insertTransaction(db, { account_id: chase, date: '2026-07-03', amount: -10000, merchant_name: 'Fidelity Brokerage Services' });
  const into = insertTransaction(db, { account_id: fid, date: '2026-07-06', amount: 10000, merchant_name: 'Electronic Funds Transfer Received' });
  db.prepare("UPDATE transactions SET transfer_pair_id = 'xfer_1', transfer_status = 'confirmed' WHERE id IN (?, ?)").run(out, into);

  const list = (accountIds: string[]) => listTransactions(db, {
    limit: 50, page: 1, sortBy: 'date', sortDir: 'desc', accountIds, categoryIds: [], foldTransfers: true,
  });
  assert.deepEqual(list([]).rows.map((row) => row.id), [out]);
  assert.equal(list([]).total, 1, 'the count is of what is shown');
  assert.deepEqual(list([fid]).rows.map((row) => row.id), [into], 'the arriving leg stands in for the transfer on its own account');
});

test('a transfer whose leaving leg falls outside the list still shows by its arriving leg', () => {
  const db = migratedTestDb();
  const chase = insertAccount(db, { account_name: 'Chase Checking' });
  const savings = insertAccount(db, { account_name: 'Savings', type: 'savings' });
  const out = insertTransaction(db, { account_id: chase, date: '2026-09-30', amount: -50000, original_name: 'ONLINE TRANSFER TO SAV' });
  const into = insertTransaction(db, { account_id: savings, date: '2026-10-01', amount: 50000, original_name: 'ONLINE TRANSFER FROM CHK' });
  db.prepare("UPDATE transactions SET transfer_pair_id = 'xfer_2', transfer_status = 'confirmed' WHERE id IN (?, ?)").run(out, into);
  const base = { limit: 50, page: 1, sortBy: 'date' as const, sortDir: 'desc' as const, accountIds: [], categoryIds: [], foldTransfers: true };

  assert.deepEqual(listTransactions(db, { ...base, startDate: '2026-10-01', endDate: '2026-10-31' }).rows.map((r) => r.id), [into]);
  assert.deepEqual(listTransactions(db, { ...base, search: 'FROM CHK' }).rows.map((r) => r.id), [into]);
  assert.deepEqual(listTransactions(db, { ...base, startDate: '2026-09-01', endDate: '2026-10-31' }).rows.map((r) => r.id), [out]);
});
