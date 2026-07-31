import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  applyMerchantRuleToMatchingTransactions,
  applyMerchantRulesToExistingTransactions,
  autoCategorizeTransactions,
  countMerchantRuleImpact,
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

/**
 * The single-rule paths used to answer a different question from the whole-ledger pass.
 *
 * `applyMerchantRulesToExistingTransactions` walks the ordered rules and takes the first match, so
 * a row a higher-precedence rule holds is not this rule's to relabel. `countMerchantRuleImpact` and
 * `applyMerchantRuleToMatchingTransactions` asked only "does the pattern match", and on the owner's
 * real ledger the two disagreed: with `UBER *EATS` -> food delivery installed, the whole-ledger
 * pass left all 13 rows named "Uber" in ride share, while the single-rule path relabelled all 13
 * and the blast radius shown to the owner read 13.
 */
test('a rule does not relabel a row a higher-precedence rule holds', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const ride = insertCategory(db, { name: 'Ride share' });
  const delivery = insertCategory(db, { name: 'Food delivery' });
  const account = insertAccount(db);

  upsertMerchantRule(db, 'UBER   *TRIP HELP.UBER.COM, CA', ride, TEST_NOW, { source: 'human' });
  const held = insertTransaction(db, {
    account_id: account,
    merchant_name: 'Uber',
    category_id: ride,
    category_source: 'rule',
  });
  const free = insertTransaction(db, {
    account_id: account,
    merchant_name: 'UBER   *EATS HELP.UBER.COM, CA',
  });

  // The matcher sweeps the bare name into the eats pattern; precedence is what withholds the row.
  assert.equal(merchantMatchesRulePattern('Uber', 'UBER *EATS'), true);

  assert.equal(
    countMerchantRuleImpact(db, 'UBER *EATS', delivery, { overwrite: true, ruleSource: 'ai' }),
    1,
    'the eats row, and not the ride row the owner rule holds'
  );

  upsertMerchantRule(db, 'UBER *EATS', delivery, TEST_NOW, { source: 'ai' });
  const applied = applyMerchantRuleToMatchingTransactions(db, 'UBER *EATS', delivery, TEST_NOW, {
    overwrite: true,
  });
  assert.equal(applied.updated, 1);

  const categoryOf = (id: string): string | null =>
    (db.prepare('SELECT category_id FROM transactions WHERE id = ?').get(id) as {
      category_id: string | null;
    }).category_id;
  assert.equal(categoryOf(held), ride);
  assert.equal(categoryOf(free), delivery);

  // And the whole-ledger pass, run afterwards, changes nothing: the two paths now agree, so the
  // single-rule write is not one the next "Re-check all transactions" silently reverts.
  const recheck = applyMerchantRulesToExistingTransactions(db, {
    onlyUncategorized: false,
    skipManual: true,
  });
  assert.equal(recheck.updated, 0);
  assert.equal(categoryOf(held), ride);
  assert.equal(categoryOf(free), delivery);
});

/**
 * Precedence must be invisible whenever nothing actually outranks the rule. Every case here is an
 * ordinary event, and every one of them has to behave exactly as it did before.
 */
test('precedence withholds nothing from a rule no other rule outranks', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const coffee = insertCategory(db, { name: 'Coffee' });
  const groceries = insertCategory(db, { name: 'Groceries' });
  const account = insertAccount(db);

  // 1. The only rule in the ledger: nothing to outrank it.
  const alone = insertTransaction(db, { account_id: account, merchant_name: 'BLUE BOTTLE COFFEE BOSTON MA' });
  upsertMerchantRule(db, 'Blue Bottle Coffee', coffee, TEST_NOW, { source: 'human' });
  assert.equal(countMerchantRuleImpact(db, 'Blue Bottle Coffee', coffee), 1);
  assert.equal(
    applyMerchantRuleToMatchingTransactions(db, 'Blue Bottle Coffee', coffee, TEST_NOW).updated,
    1
  );

  // 2. A longer rule written later outranks the shorter one, so it still applies over it.
  const specific = insertTransaction(db, {
    account_id: account,
    merchant_name: 'TRADER JOE S #502 CAMBRIDGE MA',
    category_id: coffee,
    category_source: 'rule',
  });
  upsertMerchantRule(db, 'Trader', coffee, TEST_NOW, { source: 'human' });
  upsertMerchantRule(db, 'TRADER JOE S #502 CAMBRIDGE MA', groceries, TEST_NOW, { source: 'human' });
  assert.equal(
    applyMerchantRuleToMatchingTransactions(db, 'TRADER JOE S #502 CAMBRIDGE MA', groceries, TEST_NOW, {
      overwrite: true,
    }).updated,
    1
  );

  // 3. An outranking rule pointing at the SAME category withholds nothing: the row is going there
  //    either way, so there is no fight to lose.
  const agreed = insertTransaction(db, { account_id: account, merchant_name: 'TRADER JOE S #502 CAMBRIDGE MA' });
  assert.equal(countMerchantRuleImpact(db, 'Trader Joe', groceries), 1);
  assert.equal(
    applyMerchantRuleToMatchingTransactions(db, 'Trader Joe', groceries, TEST_NOW).updated,
    1
  );

  const categoryOf = (id: string): string | null =>
    (db.prepare('SELECT category_id FROM transactions WHERE id = ?').get(id) as {
      category_id: string | null;
    }).category_id;
  assert.equal(categoryOf(alone), coffee);
  assert.equal(categoryOf(specific), groceries);
  assert.equal(categoryOf(agreed), groceries);
});

/**
 * The two paths have to separate a tie the same way, or the single-rule apply writes an answer the
 * next whole-ledger pass reverts.
 *
 * The order is `(source = 'ai') ASC, length(pattern) DESC, created_at DESC, id ASC`, and the
 * single-rule paths used to implement only the first two keys: an equal-length rule was read as
 * beaten, whatever the timestamp said. Both cases below are ordinary owner rules, not AI ones, and
 * `merchant_rules` on the real ledger is dense in exactly these ties (236 live rules over 41
 * distinct `created_at` values, 173 of them sharing one).
 */
function categoryOfTransaction(db: Database.Database, id: string): string | null {
  return (db.prepare('SELECT category_id FROM transactions WHERE id = ?').get(id) as {
    category_id: string | null;
  }).category_id;
}

test('an equal-length owner rule that wins on recency withholds the row from the older one', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const marketplace = insertCategory(db, { name: 'Marketplace' });
  const prime = insertCategory(db, { name: 'Prime' });
  const account = insertAccount(db);

  // Same author, same pattern length, different instants: only `created_at` can separate them.
  upsertMerchantRule(db, 'AMAZON MKTPL', marketplace, '2026-01-01T00:00:00.000Z', { source: 'human' });
  upsertMerchantRule(db, 'AMAZON PRIME', prime, '2026-06-01T00:00:00.000Z', { source: 'human' });

  const shared = insertTransaction(db, { account_id: account, merchant_name: 'AMAZON MKTPL AMAZON PRIME' });
  applyMerchantRulesToExistingTransactions(db, { onlyUncategorized: true });
  assert.equal(categoryOfTransaction(db, shared), prime, 'the newer of two equal-length rules takes it');

  // So the older rule may not take it back, and may not report that it would.
  assert.equal(countMerchantRuleImpact(db, 'AMAZON MKTPL', marketplace, { overwrite: true }), 0);
  assert.equal(
    applyMerchantRuleToMatchingTransactions(db, 'AMAZON MKTPL', marketplace, TEST_NOW, {
      overwrite: true,
    }).updated,
    0
  );
  assert.equal(categoryOfTransaction(db, shared), prime);

  // Nothing to revert, which is the property: a re-check is a no-op rather than an undo.
  assert.equal(recategorizeAll(db).updated, 0);
  assert.equal(categoryOfTransaction(db, shared), prime);

  // And precedence withholds nothing from the rule that wins the tie.
  const fresh = insertTransaction(db, { account_id: account, merchant_name: 'AMAZON MKTPL AMAZON PRIME' });
  assert.equal(applyMerchantRuleToMatchingTransactions(db, 'AMAZON PRIME', prime, TEST_NOW).updated, 1);
  assert.equal(categoryOfTransaction(db, fresh), prime);
});

test('an equal-length owner rule that wins on id withholds the row from the other', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const marketplace = insertCategory(db, { name: 'Marketplace' });
  const prime = insertCategory(db, { name: 'Prime' });
  const account = insertAccount(db);

  // Written with chosen ids because the id is the only key left: same source, same pattern length,
  // same instant. That is the live shape, where 173 rules were minted in one pass.
  const insert = db.prepare(
    'INSERT INTO merchant_rules (id, pattern, category_id, created_at, source, updated_at) VALUES (?,?,?,?,?,?)'
  );
  insert.run('rule_aaa', 'AMAZON PRIME', prime, TEST_NOW, 'human', TEST_NOW);
  insert.run('rule_zzz', 'AMAZON MKTPL', marketplace, TEST_NOW, 'human', TEST_NOW);

  const shared = insertTransaction(db, { account_id: account, merchant_name: 'AMAZON MKTPL AMAZON PRIME' });
  applyMerchantRulesToExistingTransactions(db, { onlyUncategorized: true });
  assert.equal(categoryOfTransaction(db, shared), prime, 'the lower id wins the tie');

  assert.equal(countMerchantRuleImpact(db, 'AMAZON MKTPL', marketplace, { overwrite: true }), 0);
  assert.equal(
    applyMerchantRuleToMatchingTransactions(db, 'AMAZON MKTPL', marketplace, TEST_NOW, {
      overwrite: true,
    }).updated,
    0
  );
  assert.equal(categoryOfTransaction(db, shared), prime);
  assert.equal(recategorizeAll(db).updated, 0);
});

/**
 * The blast radius shown before the write has to be counted against the write that will happen.
 *
 * With no rule stored for the pattern yet, nothing on disk says who is authoring it, so
 * `countMerchantRuleImpact` fell back to the owner and counted rows an AI write can never take:
 * every owner rule outranks every AI rule. `checkBlastRadius` refuses with "would relabel N
 * transactions", so that count is also the one number the owner reads.
 */
test('the pre-write blast radius is counted as the source the rule will be written with', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const shopping = insertCategory(db, { name: 'Shopping' });
  const household = insertCategory(db, { name: 'Household' });
  const account = insertAccount(db);

  upsertMerchantRule(db, 'Amazon', shopping, TEST_NOW, { source: 'human' });
  const rows = Array.from({ length: 5 }, () =>
    insertTransaction(db, { account_id: account, merchant_name: 'AMAZON MKTPLACE PMTS' })
  );

  assert.equal(
    countMerchantRuleImpact(db, 'AMAZON MKTPLACE PMTS', household, { overwrite: true }),
    5,
    'read as the owner writing it, the longer pattern outranks the shorter one and takes every row'
  );
  assert.equal(
    countMerchantRuleImpact(db, 'AMAZON MKTPLACE PMTS', household, { overwrite: true, ruleSource: 'ai' }),
    0,
    'read as the model writing it, the owner rule holds all five'
  );

  upsertMerchantRule(db, 'AMAZON MKTPLACE PMTS', household, TEST_NOW, { source: 'ai' });
  assert.equal(
    applyMerchantRuleToMatchingTransactions(db, 'AMAZON MKTPLACE PMTS', household, TEST_NOW, {
      overwrite: true,
    }).updated,
    0,
    'and 0 is what the write does, which is what the count had to say'
  );
  for (const id of rows) assert.equal(categoryOfTransaction(db, id), null);

  // The owner's rule is what files them, and the AI rule does not fight it on the next pass.
  applyMerchantRulesToExistingTransactions(db, { onlyUncategorized: true });
  for (const id of rows) assert.equal(categoryOfTransaction(db, id), shopping);
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
