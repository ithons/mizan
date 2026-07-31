import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import Database from 'better-sqlite3';
import { recategorizeAll, applyMerchantRuleToMatchingTransactions } from '../server/src/services/rules';
import { _setDbForTesting } from '../server/src/db/index';
import rulesRouter from '../server/src/routes/rules';
import { TEST_NOW, insertAccount, insertCategory, insertTransaction, migratedTestDb } from './helpers/schema';

function setup(): Database.Database {
  const db = migratedTestDb();
  insertAccount(db, { id: 'acct' });
  db.prepare(
    "INSERT INTO merchant_rules (id, pattern, category_id, created_at) VALUES ('r1','STARBUCKS','cat_food_coffee',?)"
  ).run(TEST_NOW);
  const ins = (id: string, categoryId: string | null, manual: number) =>
    insertTransaction(db, {
      id,
      account_id: 'acct',
      merchant_name: 'STARBUCKS',
      original_name: 'STARBUCKS',
      category_id: categoryId,
      manually_categorized: manual,
    });
  ins('t1', 'cat_shop', 0);          // rule/heuristic row: should be re-ruled
  ins('t2', 'cat_travel', 1);        // manual row: must be preserved
  ins('t3', null, 0);                // uncategorized: rule fills it
  return db;
}

test('recategorizeAll re-applies rules to non-manual rows', (t) => {
  const db = setup();
  t.after(() => db.close());
  recategorizeAll(db);
  const cat = (id: string) =>
    (db.prepare('SELECT category_id FROM transactions WHERE id = ?').get(id) as { category_id: string | null }).category_id;
  assert.equal(cat('t1'), 'cat_food_coffee'); // corrected by the rule
  assert.equal(cat('t3'), 'cat_food_coffee'); // filled by the rule
});

test('recategorizeAll never overwrites a manually categorized row', (t) => {
  const db = setup();
  t.after(() => db.close());
  recategorizeAll(db);
  const t2 = db.prepare("SELECT category_id FROM transactions WHERE id = 't2'").get() as { category_id: string };
  assert.equal(t2.category_id, 'cat_travel'); // preserved despite matching the rule
});

test('applyMerchantRuleToMatchingTransactions with overwrite re-labels past non-manual rows', (t) => {
  const db = setup();
  t.after(() => db.close());
  const result = applyMerchantRuleToMatchingTransactions(db, 'STARBUCKS', 'cat_food_coffee', '2026-02-01', {
    overwrite: true,
  });
  const cat = (id: string) =>
    (db.prepare('SELECT category_id FROM transactions WHERE id = ?').get(id) as { category_id: string | null }).category_id;
  assert.equal(cat('t1'), 'cat_food_coffee'); // was cat_wrong, relabeled
  assert.equal(cat('t3'), 'cat_food_coffee'); // was null, filled
  assert.equal(cat('t2'), 'cat_travel'); // manual, untouched
  assert.equal(result.updated, 2); // t1 + t3 (t2 skipped, and none already correct)
});

test('applyMerchantRuleToMatchingTransactions without overwrite only fills uncategorized', (t) => {
  const db = setup();
  t.after(() => db.close());
  applyMerchantRuleToMatchingTransactions(db, 'STARBUCKS', 'cat_food_coffee', '2026-02-01');
  const cat = (id: string) =>
    (db.prepare('SELECT category_id FROM transactions WHERE id = ?').get(id) as { category_id: string | null }).category_id;
  assert.equal(cat('t1'), 'cat_shop'); // already categorized -> left alone
  assert.equal(cat('t3'), 'cat_food_coffee'); // null -> filled
});

test('a rule pointing at a deleted category is skipped, not allowed to fail the whole pass', (t) => {
  const db = setup();
  t.after(() => db.close());

  // Categories get folded/renamed by migrations; a rule can outlive its target. Writing the
  // dangling id used to raise "FOREIGN KEY constraint failed" and abort the entire
  // auto-categorization sync stage, so one stale mapping took down every other row.
  // `merchant_rules.category_id` references `categories(id)` with ON DELETE CASCADE, so an
  // ordinary delete takes the rule with it and a dangling rule cannot be inserted. The state
  // still occurs, from a migration that folds or renames categories with foreign keys off
  // (`runMigrationsOn` disables them for the duration), which is how it is made here.
  db.pragma('foreign_keys = OFF');
  db.prepare("INSERT INTO merchant_rules (id, pattern, category_id, created_at) VALUES ('r2','WHOLEFOODS','cat_deleted','2026-01-02')").run();
  db.pragma('foreign_keys = ON');
  insertTransaction(db, {
    id: 't4', account_id: 'acct', merchant_name: 'WHOLEFOODS', original_name: 'WHOLEFOODS',
    category_id: null, manually_categorized: 0,
  });

  assert.doesNotThrow(() => recategorizeAll(db));

  const row = db.prepare("SELECT category_id FROM transactions WHERE id = 't4'").get() as { category_id: string | null };
  assert.equal(row.category_id, null, 'the unapplicable row stays uncategorized');
  // ...and the healthy rows in the same pass were still categorized.
  const t3 = db.prepare("SELECT category_id FROM transactions WHERE id = 't3'").get() as { category_id: string | null };
  assert.equal(t3.category_id, 'cat_food_coffee', 'a stale rule must not block the rest of the pass');
});

// POST /api/rules/apply is the only whole-ledger rule sweep that used to run without `skipManual`,
// so with only_uncategorized false it could relabel a row the owner categorized by hand. On the
// real database it writes zero human rows, but only because no human row happens to match a rule.
// That is luck, not a guard, so this drives the real router over HTTP.
test('POST /rules/apply over the whole ledger leaves hand-categorized rows alone', async (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const coffee = insertCategory(db, { name: 'Coffee' });
  const mine = insertCategory(db, { name: 'Mine' });
  db.prepare(
    'INSERT INTO merchant_rules (id, pattern, category_id, created_at, source, updated_at) VALUES (?,?,?,?,?,?)'
  ).run('r_starbucks', 'STARBUCKS', coffee, TEST_NOW, 'human', TEST_NOW);

  const byFlag = insertTransaction(db, {
    merchant_name: 'STARBUCKS',
    category_id: mine,
    manually_categorized: 1,
  });
  const bySource = insertTransaction(db, {
    merchant_name: 'STARBUCKS',
    category_id: mine,
    category_source: 'human',
  });
  const machine = insertTransaction(db, { merchant_name: 'STARBUCKS', category_source: 'rule' });

  _setDbForTesting(db);
  const app = express();
  app.use(express.json());
  app.use('/api/rules', rulesRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no server address');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/rules/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ only_uncategorized: false }),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { data: { updated: number } };
    assert.equal(body.data.updated, 1, 'only the machine-authored row may move');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  const cat = (id: string) =>
    (db.prepare('SELECT category_id FROM transactions WHERE id = ?').get(id) as { category_id: string | null })
      .category_id;
  assert.equal(cat(byFlag), mine);
  assert.equal(cat(bySource), mine);
  assert.equal(cat(machine), coffee);
});
