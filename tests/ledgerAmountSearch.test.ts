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
