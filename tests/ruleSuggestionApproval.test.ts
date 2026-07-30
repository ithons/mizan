import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  approveMerchantRuleSuggestions,
  suggestMerchantRules,
} from '../server/src/services/rules';

function setupDb(): Database.Database {
  const db = new Database(':memory:');

  db.exec(`
    CREATE TABLE categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT,
      icon TEXT
    );

    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      account_name TEXT NOT NULL
    );

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

    CREATE TABLE app_preferences (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE transactions (
      category_source TEXT, category_action_id TEXT, category_previous_id TEXT,
      id TEXT PRIMARY KEY,
      account_id TEXT,
      date TEXT NOT NULL,
      amount INTEGER NOT NULL,
      merchant_name TEXT,
      original_name TEXT NOT NULL,
      category_id TEXT,
      pending INTEGER NOT NULL DEFAULT 0,
      review_status TEXT NOT NULL DEFAULT 'open',
      manually_categorized INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    INSERT INTO categories (id, name) VALUES
      ('cat_food_coffee', 'Coffee'),
      ('cat_travel', 'Travel');

    INSERT INTO accounts (id, account_name) VALUES ('acct', 'Checking');
  `);

  const ins = db.prepare(`
    INSERT INTO transactions (id, account_id, date, amount, merchant_name, original_name, category_id, updated_at)
    VALUES (@id, 'acct', @date, @amount, @merchant, @merchant, @category_id, '2026-07-01')
  `);

  // Three already categorized as Coffee + two uncategorized: a high-confidence suggestion.
  ins.run({ id: 'bb1', date: '2026-06-01', amount: -500, merchant: 'Blue Bottle', category_id: 'cat_food_coffee' });
  ins.run({ id: 'bb2', date: '2026-06-08', amount: -520, merchant: 'Blue Bottle', category_id: 'cat_food_coffee' });
  ins.run({ id: 'bb3', date: '2026-06-15', amount: -480, merchant: 'Blue Bottle', category_id: 'cat_food_coffee' });
  ins.run({ id: 'bb4', date: '2026-06-22', amount: -510, merchant: 'Blue Bottle', category_id: null });
  ins.run({ id: 'bb5', date: '2026-06-29', amount: -505, merchant: 'Blue Bottle', category_id: null });

  return db;
}

test('approving a suggestion creates the rule and categorizes exactly its affected transactions', (t) => {
  const db = setupDb();
  t.after(() => db.close());

  const suggestion = suggestMerchantRules(db)[0];
  assert.ok(suggestion, 'fixture should produce a suggestion');

  const result = approveMerchantRuleSuggestions(db, [{ pattern: suggestion.pattern }]);
  assert.equal(result.approved, 1);
  assert.equal(result.applied, 2);
  assert.deepEqual(result.skipped, []);

  const rule = db.prepare('SELECT pattern, category_id FROM merchant_rules').get() as {
    pattern: string;
    category_id: string;
  };
  assert.equal(rule.category_id, 'cat_food_coffee');

  const rows = db.prepare(
    "SELECT id, category_id, review_status, manually_categorized FROM transactions WHERE id IN ('bb4','bb5')"
  ).all() as Array<{ category_id: string; review_status: string; manually_categorized: number }>;
  assert.equal(rows.every((r) => r.category_id === 'cat_food_coffee'), true);
  assert.equal(rows.every((r) => r.review_status === 'reviewed'), true);
  assert.equal(rows.every((r) => r.manually_categorized === 1), true);
});

test('an override category wins over the suggested one', (t) => {
  const db = setupDb();
  t.after(() => db.close());

  const suggestion = suggestMerchantRules(db)[0];
  const result = approveMerchantRuleSuggestions(db, [
    { pattern: suggestion.pattern, category_id: 'cat_travel' },
  ]);

  assert.equal(result.applied, 2);
  const row = db.prepare("SELECT category_id FROM transactions WHERE id = 'bb4'").get() as { category_id: string };
  assert.equal(row.category_id, 'cat_travel');
});

test('approval never relabels a transaction the user categorized in the meantime', (t) => {
  const db = setupDb();
  t.after(() => db.close());

  const suggestion = suggestMerchantRules(db)[0];
  // Simulates the user hand-categorizing one of the affected rows before hitting Approve.
  db.prepare("UPDATE transactions SET category_id = 'cat_travel' WHERE id = 'bb4'").run();

  const result = approveMerchantRuleSuggestions(db, [{ pattern: suggestion.pattern }]);
  assert.equal(result.applied, 1);

  const kept = db.prepare("SELECT category_id FROM transactions WHERE id = 'bb4'").get() as { category_id: string };
  assert.equal(kept.category_id, 'cat_travel', 'the hand-picked category must survive');
});

test('unknown patterns and categories are reported, not silently dropped', (t) => {
  const db = setupDb();
  t.after(() => db.close());

  const suggestion = suggestMerchantRules(db)[0];
  const result = approveMerchantRuleSuggestions(db, [
    { pattern: 'Merchant That Does Not Exist' },
    { pattern: suggestion.pattern, category_id: 'cat_nope' },
  ]);

  assert.equal(result.approved, 0);
  assert.equal(result.applied, 0);
  assert.deepEqual(result.skipped, [
    { pattern: 'Merchant That Does Not Exist', reason: 'unknown_pattern' },
    { pattern: suggestion.pattern, reason: 'unknown_category' },
  ]);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM merchant_rules').get() as { n: number }).n, 0);
});

test('affected ids come from the server, so a stale client cannot widen the blast radius', (t) => {
  const db = setupDb();
  t.after(() => db.close());

  // An unrelated uncategorized transaction the suggestion has nothing to do with.
  db.prepare(`
    INSERT INTO transactions (id, account_id, date, amount, merchant_name, original_name, category_id, updated_at)
    VALUES ('other', 'acct', '2026-06-30', -900, 'Some Airline', 'Some Airline', NULL, '2026-07-01')
  `).run();

  const suggestion = suggestMerchantRules(db).find((s) => s.pattern === 'Blue Bottle');
  assert.ok(suggestion);
  approveMerchantRuleSuggestions(db, [{ pattern: suggestion.pattern }]);

  const other = db.prepare("SELECT category_id FROM transactions WHERE id = 'other'").get() as {
    category_id: string | null;
  };
  assert.equal(other.category_id, null);
});
