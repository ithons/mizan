import test from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { confirmAdvisorDraftsByIds } from '../server/src/services/advisorDrafts';
import {
  applyMerchantRuleToMatchingTransactions,
  applyMerchantRulesToExistingTransactions,
  autoCategorizeTransactions,
  countMerchantRuleImpact,
  upsertMerchantRule,
} from '../server/src/services/rules';
import { refreshTransactionIntegrity, refreshTransferCandidates, settleDirectionContradictions } from '../server/src/services/transactionIntegrity';
import { TEST_NOW, insertAccount, insertTransaction, migratedTestDb } from './helpers/schema';

function wealthfrontRows(db: Database.Database) {
  const checking = insertAccount(db, { type: 'checking' });
  const savings = insertAccount(db, { type: 'savings' });
  return {
    deposit: insertTransaction(db, { account_id: checking, amount: -50000, merchant_name: 'Wealthfront', category_id: null }),
    arrival: insertTransaction(db, { account_id: savings, amount: 50000, merchant_name: 'Wealthfront', category_id: null }),
    interest: insertTransaction(db, { account_id: savings, amount: 163, merchant_name: 'Wealthfront Interest', category_id: null }),
  };
}

const categoryOf = (db: Database.Database, id: string) =>
  (db.prepare('SELECT category_id FROM transactions WHERE id = ?').get(id) as { category_id: string | null }).category_id;

test('a Transfer Out rule files money leaving an account and leaves money arriving alone', () => {
  const db = migratedTestDb();
  const rows = wealthfrontRows(db);
  upsertMerchantRule(db, 'Wealthfront', 'cat_xfer_out', TEST_NOW, { source: 'ai' });
  applyMerchantRulesToExistingTransactions(db, { onlyUncategorized: true });
  assert.equal(categoryOf(db, rows.deposit), 'cat_xfer_out');
  assert.equal(categoryOf(db, rows.arrival), null);
  assert.equal(categoryOf(db, rows.interest), null);
});

test('the impact a rule reports is the rows it then files, with the contradicting ones left out of both', () => {
  const db = migratedTestDb();
  wealthfrontRows(db);
  const counted = countMerchantRuleImpact(db, 'Wealthfront', 'cat_xfer_in', { ruleSource: 'ai' });
  const applied = applyMerchantRuleToMatchingTransactions(db, 'Wealthfront', 'cat_xfer_in', TEST_NOW, { ruleSource: 'ai' }).updated;
  assert.equal(counted, 2);
  assert.equal(applied, counted);
});

test('HEALTHY: a rule whose category is not a transfer direction files every matching row, either sign', () => {
  const db = migratedTestDb();
  wealthfrontRows(db);
  assert.equal(applyMerchantRuleToMatchingTransactions(db, 'Wealthfront', 'cat_xfer', TEST_NOW).updated, 3);
});

test('the advisor cannot file money arriving as Transfer Out', () => {
  const db = migratedTestDb();
  const { interest } = wealthfrontRows(db);
  db.prepare(`
    INSERT INTO advisor_drafts (id, kind, label, summary, route, payload, changes, citations, status, created_at, updated_at)
    VALUES ('d_dir', 'categorize_transaction', 'File it', 'summary', '/ledger', ?, '[]', '[]', 'open', ?, ?)
  `).run(JSON.stringify({ kind: 'categorize_transaction', transaction_id: interest, category_id: 'cat_xfer_out' }), TEST_NOW, TEST_NOW);
  const result = confirmAdvisorDraftsByIds(db, ['d_dir']);
  assert.equal(result.outcomes[0].refused, 'contradicts_direction');
  assert.equal(categoryOf(db, interest), null);
});

const rowOf = (db: Database.Database, id: string) =>
  db.prepare('SELECT category_id, category_source, review_status FROM transactions WHERE id = ?').get(id) as
    { category_id: string | null; category_source: string | null; review_status: string };
const revisionCount = (db: Database.Database) =>
  (db.prepare('SELECT COUNT(*) AS n FROM transaction_category_revisions').get() as { n: number }).n;

test('an arriving leg the model filed as Transfer Out is paired and relabelled Transfer In', () => {
  const db = migratedTestDb();
  const checking = insertAccount(db, { type: 'checking' });
  const savings = insertAccount(db, { type: 'savings' });
  const out = insertTransaction(db, { account_id: checking, date: '2026-02-23', amount: -100000, merchant_name: 'Wealthfront', category_id: 'cat_xfer_out', category_source: 'ai', review_status: 'reviewed' });
  const into = insertTransaction(db, { account_id: savings, date: '2026-02-23', amount: 100000, merchant_name: 'Wealthfront Deposit', category_id: 'cat_xfer_out', category_source: 'ai', review_status: 'reviewed' });
  refreshTransferCandidates(db);
  assert.equal(categoryOf(db, out), 'cat_xfer_out');
  assert.equal(categoryOf(db, into), 'cat_xfer_in');
});

test('a leg of a pair the owner confirmed takes its own side when the model filed it backwards', () => {
  const db = migratedTestDb();
  const out = insertTransaction(db, { date: '2026-06-09', amount: -251730, merchant_name: 'Wealthfront', category_id: 'cat_xfer_out', category_source: 'ai' });
  const into = insertTransaction(db, { date: '2026-06-09', amount: 251730, merchant_name: 'Wealthfront', category_id: 'cat_xfer_out', category_source: 'ai' });
  db.prepare("UPDATE transactions SET transfer_pair_id = 'xfer_owner', transfer_status = 'confirmed', transfer_source = 'owner' WHERE id IN (?, ?)").run(out, into);
  settleDirectionContradictions(db);
  assert.deepEqual(rowOf(db, into), { category_id: 'cat_xfer_in', category_source: 'heuristic', review_status: 'open' });
  assert.equal(categoryOf(db, out), 'cat_xfer_out');
});

test('interest the model filed as Transfer Out goes back to review, and the keyword then files it as interest', () => {
  const db = migratedTestDb();
  const savings = insertAccount(db, { type: 'savings' });
  const interest = insertTransaction(db, { account_id: savings, amount: 163, merchant_name: 'Wealthfront Interest', category_id: 'cat_xfer_out', category_source: 'ai', review_status: 'reviewed' });
  const zelle = insertTransaction(db, { amount: -4600, merchant_name: 'Zelle Transfer To A Friend', category_id: 'cat_xfer_in', category_source: 'ai', review_status: 'reviewed' });
  upsertMerchantRule(db, 'Zelle Transfer', 'cat_xfer_in', TEST_NOW, { source: 'ai' });
  refreshTransactionIntegrity(db);
  assert.deepEqual(rowOf(db, interest), { category_id: null, category_source: null, review_status: 'open' });
  assert.deepEqual(rowOf(db, zelle), { category_id: null, category_source: null, review_status: 'open' });
  autoCategorizeTransactions(db);
  assert.equal(categoryOf(db, interest), 'cat_income_interest');
  assert.equal(categoryOf(db, zelle), null, 'the rule that wrote it backwards cannot write it again');
});

test('the owner filing money arriving as Transfer Out is their decision and is left alone', () => {
  const db = migratedTestDb();
  const row = insertTransaction(db, { amount: 5000, category_id: 'cat_xfer_out', category_source: 'human', manually_categorized: 1, review_status: 'reviewed' });
  assert.equal(settleDirectionContradictions(db), 0);
  assert.deepEqual(rowOf(db, row), { category_id: 'cat_xfer_out', category_source: 'human', review_status: 'reviewed' });
});

test('HEALTHY: transfers filed on their own side write nothing', () => {
  const db = migratedTestDb();
  const checking = insertAccount(db, { type: 'checking' });
  const savings = insertAccount(db, { type: 'savings' });
  insertTransaction(db, { account_id: checking, date: '2026-02-23', amount: -100000, merchant_name: 'Wealthfront', category_id: 'cat_xfer_out', category_source: 'ai' });
  insertTransaction(db, { account_id: savings, date: '2026-02-23', amount: 100000, merchant_name: 'Wealthfront Deposit', category_id: 'cat_xfer_in', category_source: 'ai' });
  insertTransaction(db, { account_id: savings, amount: 163, merchant_name: 'Wealthfront Interest', category_id: 'cat_income_interest', category_source: 'ai' });
  refreshTransactionIntegrity(db);
  const before = revisionCount(db);
  assert.equal(settleDirectionContradictions(db), 0);
  refreshTransactionIntegrity(db);
  assert.equal(revisionCount(db), before);
});
