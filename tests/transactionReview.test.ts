import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migratedTestDb, insertAccount } from './helpers/schema';
import { getTransactionReviewSummary } from '../server/src/services/transactionReview';

function setupReviewDb(): Database.Database {
  const db = migratedTestDb();
  insertAccount(db, { id: 'acct_checking', account_name: 'Checking' });

  db.prepare(`
    INSERT INTO transactions (id, account_id, date, amount, merchant_name, original_name, category_id, pending, created_at, updated_at)
    VALUES
      ('target_1', 'acct_checking', '2026-06-01', -40, 'Target', 'TARGET STORE', 'cat_food', 0, '2026-06-01', '2026-06-01'),
      ('target_2', 'acct_checking', '2026-06-02', -42, 'Target', 'TARGET STORE', 'cat_food', 0, '2026-06-02', '2026-06-02'),
      ('target_3', 'acct_checking', '2026-06-03', -44, 'Target', 'TARGET STORE', NULL, 0, '2026-06-03', '2026-06-03'),
      ('unknown_1', 'acct_checking', '2026-06-04', -20, 'Unknown Shop', 'UNKNOWN', NULL, 0, '2026-06-04', '2026-06-04'),
      ('pending_1', 'acct_checking', '2026-06-05', -5, 'Coffee', 'COFFEE', NULL, 1, '2026-06-05', '2026-06-05'),
      ('pending_2', 'acct_checking', '2026-06-06', -60, 'Grocery', 'GROCERY', 'cat_food', 1, '2026-06-06', '2026-06-06')
  `).run();

  db.prepare(`
    INSERT INTO recurring_patterns (
      id,
      merchant_name,
      category_id,
      average_amount,
      frequency,
      last_seen,
      next_expected,
      is_active,
      is_confirmed,
      transaction_count,
      created_at,
      updated_at
    )
    VALUES
      ('rent', 'Rent', 'cat_home_utilities', 1200, 'monthly', '2026-06-01', '2026-07-01', 1, 0, 3, '2026-06-01', '2026-06-01'),
      ('weak', 'Weak Pattern', 'cat_home_utilities', 20, 'monthly', '2026-06-01', '2026-07-01', 1, 0, 2, '2026-06-01', '2026-06-01'),
      ('confirmed', 'Confirmed', 'cat_home_utilities', 50, 'monthly', '2026-06-01', '2026-07-01', 1, 1, 5, '2026-06-01', '2026-06-01')
  `).run();

  return db;
}

test('transaction review summary combines review queues from existing data', (t) => {
  const db = setupReviewDb();
  t.after(() => db.close());

  const summary = getTransactionReviewSummary(db);
  const counts = new Map(summary.queues.map((queue) => [queue.id, queue.count]));

  assert.equal(counts.get('uncategorized'), 2);
  assert.equal(counts.get('pending'), 2);
  assert.equal(counts.get('rule_suggestions'), 1);
  assert.equal(counts.get('recurring_candidates'), 1);
  // total_open is the ACTIONABLE total and deliberately excludes `pending`: a pending
  // authorization can't be acted on (it posts on its own) and the inbox never renders one, so
  // counting it produced the "N items to review / nothing to review" mismatch. 2 + 1 + 1 = 4.
  assert.equal(summary.total_open, 4);

  assert.equal(summary.rule_suggestions[0].pattern, 'Target');
  assert.equal(summary.rule_suggestions[0].category_id, 'cat_food');
  assert.deepEqual(summary.rule_suggestions[0].affected_transaction_ids, ['target_3']);
  assert.match(summary.rule_suggestions[0].reason, /2 of 2 categorized Target transactions use Food & Drink/);
  assert.equal(
    summary.rule_suggestions[0].preview_transactions.some((transaction) =>
      transaction.id === 'target_3' &&
      transaction.will_apply &&
      transaction.account_name === 'Checking'
    ),
    true
  );
  assert.equal(
    summary.rule_suggestions[0].preview_transactions.some((transaction) =>
      transaction.id === 'target_2' &&
      !transaction.will_apply &&
      transaction.category_name === 'Food & Drink'
    ),
    true
  );
  assert.equal(summary.recurring_candidates[0].id, 'rent');
});

test('transaction review suppresses rule suggestions already covered by rules', (t) => {
  const db = setupReviewDb();
  t.after(() => db.close());

  db.prepare(`
    INSERT INTO merchant_rules (id, pattern, category_id, created_at)
    VALUES ('rule_target', 'Target', 'cat_food', '2026-06-01')
  `).run();

  const summary = getTransactionReviewSummary(db);
  const ruleQueue = summary.queues.find((queue) => queue.id === 'rule_suggestions');

  assert.equal(ruleQueue?.count, 0);
  assert.equal(summary.rule_suggestions.length, 0);
});

test('uncategorized counts rows whose review_status is "reviewed" (the dead-zone regression)', (t) => {
  const db = setupReviewDb();
  t.after(() => db.close());

  // Categorization side effects (merchant rules, bulk categorize, transfer confirm) set
  // review_status='reviewed', and a bulk pass once marked 1,735 imported rows reviewed. Gating the
  // uncategorized count on review_status='open' therefore hid 432 real uncategorized transactions
  // from the inbox while routes/insights.ts still counted them.
  db.prepare("UPDATE transactions SET review_status = 'reviewed' WHERE category_id IS NULL").run();

  const summary = getTransactionReviewSummary(db);
  const uncategorized = summary.queues.find((q) => q.id === 'uncategorized')?.count ?? 0;
  assert.equal(uncategorized, 2, 'reviewed-but-uncategorized rows must still be counted');
});

test('an explicitly dismissed transaction is the only thing suppressed from uncategorized', (t) => {
  const db = setupReviewDb();
  t.after(() => db.close());

  db.prepare("UPDATE transactions SET review_status = 'dismissed' WHERE id = 'unknown_1'").run();

  const summary = getTransactionReviewSummary(db);
  const uncategorized = summary.queues.find((q) => q.id === 'uncategorized')?.count ?? 0;
  assert.equal(uncategorized, 1, "only 'dismissed' suppresses a row");
});
