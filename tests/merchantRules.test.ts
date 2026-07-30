import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  applyMerchantRuleToMatchingTransactions,
  applyMerchantRulesToExistingTransactions,
  autoCategorizeTransactions,
  merchantMatchesRulePattern,
  recategorizeAll,
  upsertMerchantRule,
} from '../server/src/services/rules';
import {
  TEST_NOW,
  insertAccount,
  insertCategory,
  insertTransaction,
  migratedTestDb,
} from './helpers/schema';

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
      created_at TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'human',
      action_id TEXT,
      updated_at TEXT,
      retired_at TEXT
    );
    CREATE UNIQUE INDEX idx_merchant_rules_pattern_live
      ON merchant_rules(lower(pattern)) WHERE retired_at IS NULL;
    CREATE TABLE merchant_rule_revisions (
      id TEXT PRIMARY KEY, rule_id TEXT NOT NULL, pattern TEXT NOT NULL,
      from_category_id TEXT, to_category_id TEXT, source TEXT NOT NULL,
      action_id TEXT, operation TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE transaction_category_revisions (
      id TEXT PRIMARY KEY, transaction_id TEXT NOT NULL,
      from_category_id TEXT, to_category_id TEXT, from_source TEXT, to_source TEXT,
      action_id TEXT, revert_of TEXT, reverted_at TEXT, created_at TEXT NOT NULL
    );

    -- suggestMerchantRules reads skipped suggestions from here.
    CREATE TABLE app_preferences (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE transactions (
      manually_categorized INTEGER NOT NULL DEFAULT 0,
      category_source TEXT, category_action_id TEXT, category_previous_id TEXT,
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

// Every rule below is written at TEST_NOW. The identical timestamps ARE the test: the live table
// holds 236 rules across 41 distinct created_at values, so the old `ORDER BY created_at DESC`
// decided nothing for a merchant several rules reach and left the winner to the sorter, which
// walked the pattern index and handed the shortest, alphabetically-first pattern the match.
test('an AI rule never outranks an owner rule, whatever the sorter would have picked', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const streaming = insertCategory(db, { name: 'Streaming' });
  const subscriptions = insertCategory(db, { name: 'Subscriptions' });
  const account = insertAccount(db);

  // The 2026-07-29 arrangement, exactly: one broad AI rule against two specific owner rules.
  upsertMerchantRule(db, 'Spotify', subscriptions, TEST_NOW, { source: 'ai' });
  upsertMerchantRule(db, 'SPOTIFY 877-778-1161, NY', streaming, TEST_NOW, { source: 'human' });
  upsertMerchantRule(db, 'Spotify USA', streaming, TEST_NOW, { source: 'human' });

  const ids = [
    insertTransaction(db, {
      account_id: account,
      merchant_name: 'SPOTIFY 877-778-1161, NY',
      category_id: subscriptions,
      category_source: 'ai',
    }),
    insertTransaction(db, { account_id: account, merchant_name: 'Spotify USA' }),
    insertTransaction(db, {
      account_id: account,
      merchant_name: 'Spotify USA',
      category_id: streaming,
      category_source: 'rule',
    }),
  ];

  recategorizeAll(db);

  for (const id of ids) {
    const row = db.prepare('SELECT category_id FROM transactions WHERE id = ?').get(id) as {
      category_id: string | null;
    };
    assert.equal(row.category_id, streaming, `${id} must resolve to the owner's category`);
  }
});

test('an owner-approved suggestion rule ranks with the owner, not with the model', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const streaming = insertCategory(db, { name: 'Streaming' });
  const subscriptions = insertCategory(db, { name: 'Subscriptions' });

  // 'suggestion' is written only by approveMerchantRuleSuggestions, which is the owner accepting
  // it. No live row on the real database carries this source yet, so this is the only evidence.
  // The AI pattern is the longer of the two, so specificity would pick it: only source can save
  // this row.
  upsertMerchantRule(db, 'Family Plan', subscriptions, TEST_NOW, { source: 'ai' });
  upsertMerchantRule(db, 'Spotify', streaming, TEST_NOW, { source: 'suggestion' });

  const id = insertTransaction(db, { merchant_name: 'Spotify Family Plan' });
  recategorizeAll(db);

  const row = db.prepare('SELECT category_id FROM transactions WHERE id = ?').get(id) as {
    category_id: string | null;
  };
  assert.equal(row.category_id, streaming);
});

test('two rules alike in source, length and timestamp are still separated, by id', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const shopping = insertCategory(db, { name: 'Shopping' });
  const books = insertCategory(db, { name: 'Books' });
  const account = insertAccount(db);

  // Inserted with chosen ids because that is the tiebreak under test: same source, same pattern
  // length, same instant. Without `id ASC` the winner is whatever the sorter hands back, which
  // here is the alphabetically earlier pattern.
  const insert = db.prepare(
    'INSERT INTO merchant_rules (id, pattern, category_id, created_at, source, updated_at) VALUES (?,?,?,?,?,?)'
  );
  insert.run('rule_zzz', 'Amazon Prime', shopping, TEST_NOW, 'human', TEST_NOW);
  insert.run('rule_aaa', 'Kindle Books', books, TEST_NOW, 'human', TEST_NOW);

  const id = insertTransaction(db, { account_id: account, merchant_name: 'AMAZON PRIME KINDLE BOOKS' });
  applyMerchantRulesToExistingTransactions(db, { onlyUncategorized: false, skipManual: true });

  const row = db.prepare('SELECT category_id FROM transactions WHERE id = ?').get(id) as {
    category_id: string | null;
  };
  assert.equal(row.category_id, books, 'the lower id wins, and does so every time');
});
