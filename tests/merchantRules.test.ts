import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  applyMerchantRuleToMatchingTransactions,
  applyMerchantRulesToExistingTransactions,
  autoCategorizeTransactions,
  merchantMatchesRulePattern,
  upsertMerchantRule,
} from '../server/src/services/rules';

function setupDb(): Database.Database {
  const db = new Database(':memory:');

  db.exec(`
    CREATE TABLE categories (
      id TEXT PRIMARY KEY
    );

    INSERT OR IGNORE INTO categories (id) VALUES ('cat_shop_amazon'), ('cat_ent_streaming');

    CREATE TABLE merchant_rules (
      id TEXT PRIMARY KEY,
      pattern TEXT NOT NULL,
      category_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE transactions (
      id TEXT PRIMARY KEY,
      merchant_name TEXT,
      original_name TEXT NOT NULL,
      category_id TEXT,
      review_status TEXT NOT NULL DEFAULT 'open',
      updated_at TEXT NOT NULL
    );

    INSERT INTO categories (id)
    VALUES
      ('cat_food_coffee'),
      ('cat_travel');
  `);

  return db;
}

test('merchant rule matching handles identical and similar merchant names conservatively', () => {
  assert.equal(merchantMatchesRulePattern('STARBUCKS STORE 456', 'Starbucks Store 123'), true);
  assert.equal(merchantMatchesRulePattern('Starbucks', 'Starbucks Store 123'), true);
  assert.equal(merchantMatchesRulePattern('Different Cafe', 'Starbucks Store 123'), false);
});

test('single transaction categorization propagates to matching uncategorized merchants only', (t) => {
  const db = setupDb();
  t.after(() => db.close());

  db.prepare(`
    INSERT INTO transactions (id, merchant_name, original_name, category_id, review_status, updated_at)
    VALUES
      ('current', 'Starbucks Store 123', 'STARBUCKS 123', 'cat_food_coffee', 'reviewed', '2026-06-01'),
      ('similar', 'STARBUCKS STORE 456', 'STARBUCKS 456', NULL, 'open', '2026-06-01'),
      ('shorter', 'Starbucks', 'STARBUCKS', NULL, 'open', '2026-06-01'),
      ('different', 'Different Cafe', 'DIFFERENT CAFE', NULL, 'open', '2026-06-01'),
      ('user_set', 'Starbucks Store 789', 'STARBUCKS 789', 'cat_travel', 'reviewed', '2026-06-01')
  `).run();

  const ruleId = upsertMerchantRule(
    db,
    'Starbucks Store 123',
    'cat_food_coffee',
    '2026-06-30T12:00:00.000Z'
  );
  const result = applyMerchantRuleToMatchingTransactions(
    db,
    'Starbucks Store 123',
    'cat_food_coffee',
    '2026-06-30T12:00:00.000Z'
  );

  assert.ok(ruleId);
  assert.equal(result.updated, 2);

  const rows = db.prepare(`
    SELECT id, category_id, review_status, updated_at
    FROM transactions
    ORDER BY id
  `).all() as Array<{
    id: string;
    category_id: string | null;
    review_status: string;
    updated_at: string;
  }>;

  assert.deepEqual(rows, [
    {
      id: 'current',
      category_id: 'cat_food_coffee',
      review_status: 'reviewed',
      updated_at: '2026-06-01',
    },
    {
      id: 'different',
      category_id: null,
      review_status: 'open',
      updated_at: '2026-06-01',
    },
    {
      id: 'shorter',
      category_id: 'cat_food_coffee',
      review_status: 'reviewed',
      updated_at: '2026-06-30T12:00:00.000Z',
    },
    {
      id: 'similar',
      category_id: 'cat_food_coffee',
      review_status: 'reviewed',
      updated_at: '2026-06-30T12:00:00.000Z',
    },
    {
      id: 'user_set',
      category_id: 'cat_travel',
      review_status: 'reviewed',
      updated_at: '2026-06-01',
    },
  ]);
});

test('applyMerchantRulesToExistingTransactions marks matched transactions reviewed, used by the rule-suggestion Apply button', (t) => {
  const db = setupDb();
  t.after(() => db.close());

  db.prepare(`
    INSERT INTO transactions (id, merchant_name, original_name, category_id, review_status, updated_at)
    VALUES
      ('matched', 'Starbucks Store 123', 'STARBUCKS 123', NULL, 'open', '2026-06-01'),
      ('no_match', 'Some Random Merchant', 'SOME RANDOM MERCHANT', NULL, 'open', '2026-06-01')
  `).run();

  upsertMerchantRule(db, 'Starbucks Store 123', 'cat_food_coffee', '2026-06-30T12:00:00.000Z');

  const result = applyMerchantRulesToExistingTransactions(db, { onlyUncategorized: true });
  assert.equal(result.updated, 1);

  const rows = db.prepare(`
    SELECT id, category_id, review_status FROM transactions ORDER BY id
  `).all() as Array<{ id: string; category_id: string | null; review_status: string }>;

  assert.deepEqual(rows, [
    { id: 'matched', category_id: 'cat_food_coffee', review_status: 'reviewed' },
    { id: 'no_match', category_id: null, review_status: 'open' },
  ]);
});

test('autoCategorizeTransactions applies merchant rules first, then falls back to the text heuristic, and never touches already-categorized rows', (t) => {
  const db = setupDb();
  t.after(() => db.close());

  db.prepare(`
    INSERT INTO transactions (id, merchant_name, original_name, category_id, review_status, updated_at)
    VALUES
      ('rule_match', 'Starbucks Store 123', 'STARBUCKS 123', NULL, 'open', '2026-06-01'),
      ('heuristic_match', 'AMAZON.COM*A1B2C3', 'AMAZON.COM*A1B2C3', NULL, 'open', '2026-06-01'),
      ('no_match', 'Some Random Merchant', 'SOME RANDOM MERCHANT', NULL, 'open', '2026-06-01'),
      ('already_set', 'Netflix.com', 'NETFLIX.COM', 'cat_travel', 'reviewed', '2026-06-01')
  `).run();

  upsertMerchantRule(db, 'Starbucks Store 123', 'cat_food_coffee', '2026-06-30T12:00:00.000Z');

  const result = autoCategorizeTransactions(db);
  assert.equal(result.updated, 2);

  const rows = db.prepare(`
    SELECT id, category_id FROM transactions ORDER BY id
  `).all() as Array<{ id: string; category_id: string | null }>;

  assert.deepEqual(rows, [
    { id: 'already_set', category_id: 'cat_travel' }, // untouched despite matching the streaming heuristic
    { id: 'heuristic_match', category_id: 'cat_shop_amazon' },
    { id: 'no_match', category_id: null },
    { id: 'rule_match', category_id: 'cat_food_coffee' },
  ]);
});
