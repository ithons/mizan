import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  applyMerchantRuleToMatchingTransactions,
  merchantMatchesRulePattern,
  upsertMerchantRule,
} from '../server/src/services/rules';

function setupDb(): Database.Database {
  const db = new Database(':memory:');

  db.exec(`
    CREATE TABLE categories (
      id TEXT PRIMARY KEY
    );

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
