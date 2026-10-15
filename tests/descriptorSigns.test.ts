import test from 'node:test';
import assert from 'node:assert/strict';
import { descriptorDirection, directedAmount } from '../server/src/services/investmentTrades';
import { applySimplefinResponse } from '../server/src/services/simplefin';
import { updateTransaction } from '../server/src/services/transactions';
import { findFlowConservationViolations } from '../server/src/services/flowConservation';
import { runMigrationsOn } from '../server/src/db/index';
import { insertAccount, insertTransaction, migratedTestDb, TEST_NOW } from './helpers/schema';

const EFT = 'Electronic Funds Transfer Received (Cash)';

test('a descriptor that states its direction overrides the feed sign; anything else is untouched', () => {
  assert.equal(directedAmount(-10000, EFT), 10000);
  assert.equal(directedAmount(10000, EFT), 10000, 'a correctly signed arrival stays');
  assert.equal(directedAmount(10000, 'YOU BOUGHT PERIODIC INVESTMENT FIDELITY TOTAL MARKET INDEX FUND (FSKAX) (Cash)'), -10000);
  assert.equal(directedAmount(5, 'DIVIDEND RECEIVED FIDELITY GOVERNMENT MONEY MARKET (SPAXX) (Cash)'), 5);
  assert.equal(directedAmount(-90000, 'Fidelity contribution'), -90000, 'no direction in the words, no opinion');
  assert.equal(directedAmount(-10000, 'FID BKG SVC LLC MONEYLINE PPD ID: XXXXXX4600'), -10000);
  assert.equal(descriptorDirection('Electronic Funds Transfer Received as of 2026-04-15 (Cash)'), 1);
  assert.equal(descriptorDirection('ZELLE PAYMENT RECEIVED FROM A FRIEND'), 0);
});

function fidelity(amount: string): unknown {
  return {
    accounts: [{
      id: 'ACT-fid', name: 'Individual', currency: 'USD', balance: '3128.83',
      org: { name: 'Fidelity Investments' },
      transactions: [{ id: 'TRN-eft', posted: 1_784_000_000, amount, payee: 'Electronic Funds Transfer Received', description: EFT, pending: false }],
    }],
  };
}

function amountRow(db: ReturnType<typeof migratedTestDb>) {
  return db.prepare('SELECT id, amount, amount_source FROM transactions').get() as
    { id: string; amount: number; amount_source: string };
}

test('an arrival the feed sends negative is stored positive, once, with the feed figure kept', () => {
  const db = migratedTestDb();
  applySimplefinResponse(db, fidelity('-100.00'), TEST_NOW);
  assert.equal(amountRow(db).amount, 10000);

  const second = applySimplefinResponse(db, fidelity('-100.00'), TEST_NOW);
  assert.equal(second.modified, 0, 're-sending the same inverted figure is not a change');

  const revisions = db.prepare(
    "SELECT from_value, to_value FROM transaction_field_revisions WHERE origin = 'import_rule'"
  ).all();
  assert.deepEqual(revisions, [{ from_value: '-10000', to_value: '10000' }]);
});

test('a feed that sends the arrival correctly signed records nothing', () => {
  const db = migratedTestDb();
  applySimplefinResponse(db, fidelity('100.00'), TEST_NOW);
  assert.equal(amountRow(db).amount, 10000);
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS n FROM transaction_field_revisions').get() as { n: number }).n,
    0
  );
});

test('the owner still has the last word over the rule', () => {
  const db = migratedTestDb();
  applySimplefinResponse(db, fidelity('-100.00'), TEST_NOW);
  const { id } = amountRow(db);
  assert.equal(updateTransaction(db, id, { amount: -100 }).ok, true);
  applySimplefinResponse(db, fidelity('-100.00'), TEST_NOW);
  assert.deepEqual(
    { amount: amountRow(db).amount, source: amountRow(db).amount_source },
    { amount: -10000, source: 'human' }
  );
});

test('the repair flips the July legs and the detector stops reporting money that went nowhere', () => {
  const db = migratedTestDb();
  const chase = insertAccount(db, { account_name: 'Chase Checking', type: 'checking' });
  const fid = insertAccount(db, { account_name: 'Fidelity Individual', type: 'brokerage' });
  const owned = insertTransaction(db, { account_id: fid, date: '2026-07-01', amount: -2500, original_name: EFT, source_type: 'simplefin' });
  for (const [fidDate, chaseDate] of [['2026-07-13', '2026-07-13'], ['2026-07-20', '2026-07-20']]) {
    insertTransaction(db, { account_id: fid, date: fidDate, amount: -10000, original_name: EFT, category_id: 'cat_inv_transfer', source_type: 'simplefin' });
    insertTransaction(db, { account_id: chase, date: chaseDate, amount: -10000, original_name: 'FID BKG SVC LLC MONEYLINE PPD ID: XXXXXX4600', category_id: 'cat_inv_transfer', source_type: 'simplefin' });
  }
  db.prepare("UPDATE transactions SET amount_source = 'human' WHERE id = ?").run(owned);
  assert.equal(findFlowConservationViolations(db).length, 1);

  db.prepare("DELETE FROM schema_migrations WHERE name = '064_brokerage_descriptor_signs.sql'").run();
  runMigrationsOn(db);

  assert.deepEqual(findFlowConservationViolations(db), []);
  const amounts = db.prepare('SELECT amount FROM transactions WHERE account_id = ? ORDER BY date').all(fid)
    .map((row) => (row as { amount: number }).amount);
  assert.deepEqual(amounts, [-2500, 10000, 10000], 'an owner-set amount is not the rule\'s to change');
});
