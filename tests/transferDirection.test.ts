import test from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { confirmAdvisorDraftsByIds } from '../server/src/services/advisorDrafts';
import {
  applyMerchantRuleToMatchingTransactions,
  applyMerchantRulesToExistingTransactions,
  countMerchantRuleImpact,
  upsertMerchantRule,
} from '../server/src/services/rules';
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
