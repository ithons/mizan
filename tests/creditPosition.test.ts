import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _setDbForTesting } from '../server/src/db/index';
import { buildFinancialContext } from '../server/src/services/aiContext';
import { deriveAssetBuckets } from '../server/src/services/netWorthHistory';
import { insertAccount, migratedTestDb } from './helpers/schema';

/**
 * A card can sit in CREDIT: a refund or statement credit larger than the balance leaves the bank
 * owing the owner. Four readers took Math.abs() of a liability balance, which turned that credit
 * into debt of the same size and understated net worth by twice the total. On 2026-07-29 three
 * cards were in credit and net worth was $1,705.78 low.
 */

test('a card in credit adds to net worth instead of subtracting from it', () => {
  const db = migratedTestDb();
  _setDbForTesting(db);
  insertAccount(db, { type: 'checking', current_balance: 500000 });
  insertAccount(db, {
    account_name: 'Discover',
    type: 'credit',
    current_balance: -56326,
    is_liability: 1,
  });

  const context = buildFinancialContext();
  const netWorthLine = context.split('\n').find((l) => l.startsWith('### Net Worth:'));
  assert.ok(netWorthLine, 'the net worth section must be present');
  assert.match(netWorthLine, /\$5,563\.26/);
  db.close();
});

test('a credit balance is described as a credit, never as owed', () => {
  const db = migratedTestDb();
  _setDbForTesting(db);
  insertAccount(db, { type: 'checking', current_balance: 500000 });
  insertAccount(db, {
    account_name: 'Discover',
    type: 'credit',
    current_balance: -56326,
    is_liability: 1,
  });

  const context = buildFinancialContext();
  const line = context.split('\n').find((l) => l.includes('Discover'));
  assert.ok(line, 'the account must appear in the balance sheet');
  // No wording in the prompt can recover a direction the context asserted backwards.
  assert.match(line, /credit balance/);
  assert.doesNotMatch(line, /owed/);
  assert.match(line, /\$563\.26/);
  db.close();
});

test('a net credit position still reports a liabilities line', () => {
  const db = migratedTestDb();
  _setDbForTesting(db);
  insertAccount(db, { type: 'checking', current_balance: 500000 });
  insertAccount(db, { type: 'credit', current_balance: -56326, is_liability: 1 });

  const context = buildFinancialContext();
  const line = context.split('\n').find((l) => l.trim().startsWith('Liabilities:'));
  assert.ok(line, 'dropping the line leaves the model to infer liabilities of zero from silence');
  assert.match(line, /-\$563\.26/);
  db.close();
});

test('deriveAssetBuckets carries a credit position as a negative liability', () => {
  const db = migratedTestDb();
  const card = insertAccount(db, { type: 'credit', current_balance: -56326, is_liability: 1 });
  const checking = insertAccount(db, { type: 'checking', current_balance: 500000 });

  const buckets = deriveAssetBuckets(db, JSON.stringify({ [card]: -56326, [checking]: 500000 }));
  assert.equal(buckets.liabilities, -56326, 'Math.abs() reported this as 56326 of debt');
  assert.equal(buckets.liquid, 500000);
  db.close();
});
