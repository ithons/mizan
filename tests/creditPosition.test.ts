import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _setDbForTesting } from '../server/src/db/index';
import { buildFinancialContext } from '../server/src/services/aiContext';
import { takeSnapshot } from '../server/src/services/snapshot';
import { correctLiabilitySigns } from '../server/src/services/liabilitySign';
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

/**
 * This assertion used to be made against `deriveAssetBuckets`, which by 2026-08-01 had no
 * production caller at all: it was the last thing keeping a read-time bucketing function alive, so
 * the only surface proving that a credit carries signed was a surface nobody could see. It is made
 * here instead, against `takeSnapshot`, which is the live path that WRITES `total_liabilities`,
 * `net_worth` and the per-account breakdown every later reader derives from. Getting the sign wrong
 * here is what understates net worth by twice the credit, in the stored row rather than on one
 * screen.
 */
test('a snapshot records a card in credit as a negative liability, not as debt', () => {
  const db = migratedTestDb();
  _setDbForTesting(db);
  const checking = insertAccount(db, { type: 'checking', current_balance: 500000 });
  const card = insertAccount(db, {
    account_name: 'Discover',
    type: 'credit',
    current_balance: -56326,
    is_liability: 1,
  });

  takeSnapshot();

  const row = db.prepare(
    'SELECT total_assets, total_liabilities, net_worth, breakdown FROM net_worth_snapshots'
  ).get() as { total_assets: number; total_liabilities: number; net_worth: number; breakdown: string };
  assert.equal(row.total_liabilities, -56326, 'Math.abs() would record this as 56326 of debt');
  assert.equal(row.total_assets, 500000);
  // The whole point of the sign: $5,000.00 of cash plus $563.26 the bank owes back is $5,563.26.
  assert.equal(row.net_worth, 556326);
  assert.deepEqual(JSON.parse(row.breakdown), { [checking]: 500000, [card]: -56326 });
  db.close();
});

/**
 * The healthy case, and it is the one that makes the test above mean anything: a card that is
 * ORDINARILY in debt must still subtract. A fix that simply stopped negating liabilities would pass
 * the credit case and silently double net worth on every normal month.
 */
test('a snapshot still subtracts a card that is ordinarily in debt', () => {
  const db = migratedTestDb();
  _setDbForTesting(db);
  insertAccount(db, { type: 'checking', current_balance: 500000 });
  insertAccount(db, {
    account_name: 'Discover',
    type: 'credit',
    current_balance: 120411,
    is_liability: 1,
  });

  takeSnapshot();

  const row = db.prepare(
    'SELECT total_assets, total_liabilities, net_worth FROM net_worth_snapshots'
  ).get() as { total_assets: number; total_liabilities: number; net_worth: number };
  assert.equal(row.total_liabilities, 120411);
  assert.equal(row.total_assets, 500000);
  assert.equal(row.net_worth, 379589);
  db.close();
});

function settledSheet(db: ReturnType<typeof migratedTestDb>, date: string, breakdown: Record<string, number>): void {
  db.prepare(`INSERT INTO net_worth_snapshots (id, date, total_assets, total_liabilities, net_worth, breakdown, is_estimated, created_at)
    VALUES (?, ?, 0, 0, 0, ?, 0, ?)`).run(`sheet_${date}`, date, JSON.stringify(breakdown), `${date}T12:00:00Z`);
}

function todaySheet(db: ReturnType<typeof migratedTestDb>) {
  return db.prepare(`SELECT net_worth, breakdown, covered_accounts, total_accounts FROM net_worth_snapshots
    WHERE date > '2026-08-05'`).get() as { net_worth: number; breakdown: string; covered_accounts: number; total_accounts: number };
}

test('a card whose sign the check could neither correct nor confirm is left out of the sheet, not recorded as owed', () => {
  const db = migratedTestDb();
  _setDbForTesting(db);
  const checking = insertAccount(db, { type: 'checking', current_balance: 500000 });
  // Sync 1 corrected Discover to a $308.68 credit and recorded it. On sync 2 the provider's balance
  // already counts two charges the ledger has not received, and the negation reads it as owed.
  const card = insertAccount(db, { account_name: 'Discover', type: 'credit', current_balance: 29368, is_liability: 1 });
  settledSheet(db, '2026-08-05', { [checking]: 500000, [card]: -30868 });

  correctLiabilitySigns(db, '2026-10-20T12:00:00Z');
  takeSnapshot();

  const row = todaySheet(db);
  assert.deepEqual(JSON.parse(row.breakdown), { [checking]: 500000 });
  assert.deepEqual([row.covered_accounts, row.total_accounts], [1, 2]);
  assert.equal(row.net_worth, 500000);
  db.close();
});

test('HEALTHY: a corrected card on a complete ledger is recorded as its credit, covering every account', () => {
  const db = migratedTestDb();
  _setDbForTesting(db);
  const checking = insertAccount(db, { type: 'checking', current_balance: 500000 });
  const card = insertAccount(db, { account_name: 'Discover', type: 'credit', current_balance: 30868, is_liability: 1 });
  settledSheet(db, '2026-08-05', { [checking]: 500000, [card]: -30868 });

  const report = correctLiabilitySigns(db, '2026-10-20T12:00:00Z');
  takeSnapshot();

  assert.deepEqual(report.unverifiable, []);
  const row = todaySheet(db);
  assert.deepEqual(JSON.parse(row.breakdown), { [checking]: 500000, [card]: -30868 });
  assert.deepEqual([row.covered_accounts, row.total_accounts], [2, 2]);
  db.close();
});
