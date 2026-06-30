import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { getTransactionReviewSummary } from '../server/src/services/transactionReview';

function setupReviewDb(): Database.Database {
  const db = new Database(':memory:');

  db.exec(`
    CREATE TABLE categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT,
      icon TEXT
    );

    CREATE TABLE transactions (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      date TEXT NOT NULL,
      amount REAL NOT NULL,
      merchant_name TEXT,
      original_name TEXT NOT NULL DEFAULT '',
      category_id TEXT,
      pending INTEGER NOT NULL DEFAULT 0,
      duplicate_group_id TEXT,
      duplicate_status TEXT NOT NULL DEFAULT 'none',
      transfer_pair_id TEXT,
      transfer_status TEXT NOT NULL DEFAULT 'none',
      review_status TEXT NOT NULL DEFAULT 'open'
    );

    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      account_name TEXT NOT NULL
    );

    CREATE TABLE recurring_patterns (
      id TEXT PRIMARY KEY,
      merchant_name TEXT NOT NULL,
      category_id TEXT,
      average_amount REAL NOT NULL,
      frequency TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      next_expected TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      is_confirmed INTEGER NOT NULL DEFAULT 0,
      transaction_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE advisor_drafts (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      label TEXT NOT NULL,
      summary TEXT NOT NULL,
      route TEXT NOT NULL,
      payload TEXT NOT NULL,
      changes TEXT NOT NULL,
      citations TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE merchant_rules (
      id TEXT PRIMARY KEY,
      pattern TEXT NOT NULL,
      category_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  db.prepare(`
    INSERT INTO categories (id, name, color, icon)
    VALUES
      ('cat_food', 'Food', '#e07070', 'fork'),
      ('cat_bills', 'Bills', '#d4a44c', 'receipt')
  `).run();

  db.prepare(`
    INSERT INTO accounts (id, account_name)
    VALUES ('acct_checking', 'Checking')
  `).run();

  db.prepare(`
    INSERT INTO transactions (id, account_id, date, amount, merchant_name, original_name, category_id, pending)
    VALUES
      ('target_1', 'acct_checking', '2026-06-01', -40, 'Target', 'TARGET STORE', 'cat_food', 0),
      ('target_2', 'acct_checking', '2026-06-02', -42, 'Target', 'TARGET STORE', 'cat_food', 0),
      ('target_3', 'acct_checking', '2026-06-03', -44, 'Target', 'TARGET STORE', NULL, 0),
      ('unknown_1', 'acct_checking', '2026-06-04', -20, 'Unknown Shop', 'UNKNOWN', NULL, 0),
      ('pending_1', 'acct_checking', '2026-06-05', -5, 'Coffee', 'COFFEE', NULL, 1),
      ('pending_2', 'acct_checking', '2026-06-06', -60, 'Grocery', 'GROCERY', 'cat_food', 1)
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
      ('rent', 'Rent', 'cat_bills', 1200, 'monthly', '2026-06-01', '2026-07-01', 1, 0, 3, '2026-06-01', '2026-06-01'),
      ('weak', 'Weak Pattern', 'cat_bills', 20, 'monthly', '2026-06-01', '2026-07-01', 1, 0, 2, '2026-06-01', '2026-06-01'),
      ('confirmed', 'Confirmed', 'cat_bills', 50, 'monthly', '2026-06-01', '2026-07-01', 1, 1, 5, '2026-06-01', '2026-06-01')
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
  assert.equal(summary.total_open, 6);

  assert.equal(summary.rule_suggestions[0].pattern, 'Target');
  assert.equal(summary.rule_suggestions[0].category_id, 'cat_food');
  assert.deepEqual(summary.rule_suggestions[0].affected_transaction_ids, ['target_3']);
  assert.match(summary.rule_suggestions[0].reason, /2 of 2 categorized Target transactions use Food/);
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
      transaction.category_name === 'Food'
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
