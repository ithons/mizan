import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { recategorizeAll, applyMerchantRuleToMatchingTransactions } from '../server/src/services/rules';

function setup(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE merchant_rules (id TEXT PRIMARY KEY, pattern TEXT NOT NULL, category_id TEXT NOT NULL, created_at TEXT NOT NULL);

    -- suggestMerchantRules reads skipped suggestions from here.
    CREATE TABLE app_preferences (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE transactions (
      category_source TEXT, category_action_id TEXT, category_previous_id TEXT,
      id TEXT PRIMARY KEY, merchant_name TEXT, original_name TEXT DEFAULT '', category_id TEXT,
      manually_categorized INTEGER NOT NULL DEFAULT 0, review_status TEXT DEFAULT 'open', updated_at TEXT DEFAULT ''
    );

    -- Categorization now verifies the target category exists before writing it, so a rule can't
    -- fail the FK and abort the whole pass.
    CREATE TABLE categories (id TEXT PRIMARY KEY, name TEXT NOT NULL);
  `);
  db.prepare("INSERT INTO categories (id, name) VALUES ('cat_coffee','Coffee'), ('cat_wrong','Wrong'), ('cat_manual','Manual')").run();
  db.prepare("INSERT INTO merchant_rules VALUES ('r1','STARBUCKS','cat_coffee','2026-01-01')").run();
  const ins = db.prepare(
    'INSERT INTO transactions (id, merchant_name, original_name, category_id, manually_categorized) VALUES (?,?,?,?,?)'
  );
  ins.run('t1', 'STARBUCKS', 'STARBUCKS', 'cat_wrong', 0);   // rule/heuristic row: should be re-ruled
  ins.run('t2', 'STARBUCKS', 'STARBUCKS', 'cat_manual', 1);  // manual row: must be preserved
  ins.run('t3', 'STARBUCKS', 'STARBUCKS', null, 0);          // uncategorized: rule fills it
  return db;
}

test('recategorizeAll re-applies rules to non-manual rows', (t) => {
  const db = setup();
  t.after(() => db.close());
  recategorizeAll(db);
  const cat = (id: string) =>
    (db.prepare('SELECT category_id FROM transactions WHERE id = ?').get(id) as { category_id: string | null }).category_id;
  assert.equal(cat('t1'), 'cat_coffee'); // corrected by the rule
  assert.equal(cat('t3'), 'cat_coffee'); // filled by the rule
});

test('recategorizeAll never overwrites a manually categorized row', (t) => {
  const db = setup();
  t.after(() => db.close());
  recategorizeAll(db);
  const t2 = db.prepare("SELECT category_id FROM transactions WHERE id = 't2'").get() as { category_id: string };
  assert.equal(t2.category_id, 'cat_manual'); // preserved despite matching the rule
});

test('applyMerchantRuleToMatchingTransactions with overwrite re-labels past non-manual rows', (t) => {
  const db = setup();
  t.after(() => db.close());
  const result = applyMerchantRuleToMatchingTransactions(db, 'STARBUCKS', 'cat_coffee', '2026-02-01', {
    overwrite: true,
  });
  const cat = (id: string) =>
    (db.prepare('SELECT category_id FROM transactions WHERE id = ?').get(id) as { category_id: string | null }).category_id;
  assert.equal(cat('t1'), 'cat_coffee'); // was cat_wrong, relabeled
  assert.equal(cat('t3'), 'cat_coffee'); // was null, filled
  assert.equal(cat('t2'), 'cat_manual'); // manual, untouched
  assert.equal(result.updated, 2); // t1 + t3 (t2 skipped, and none already correct)
});

test('applyMerchantRuleToMatchingTransactions without overwrite only fills uncategorized', (t) => {
  const db = setup();
  t.after(() => db.close());
  applyMerchantRuleToMatchingTransactions(db, 'STARBUCKS', 'cat_coffee', '2026-02-01');
  const cat = (id: string) =>
    (db.prepare('SELECT category_id FROM transactions WHERE id = ?').get(id) as { category_id: string | null }).category_id;
  assert.equal(cat('t1'), 'cat_wrong'); // already categorized -> left alone
  assert.equal(cat('t3'), 'cat_coffee'); // null -> filled
});

test('a rule pointing at a deleted category is skipped, not allowed to fail the whole pass', (t) => {
  const db = setup();
  t.after(() => db.close());

  // Categories get folded/renamed by migrations; a rule can outlive its target. Writing the
  // dangling id used to raise "FOREIGN KEY constraint failed" and abort the entire
  // auto-categorization sync stage, so one stale mapping took down every other row.
  db.prepare("INSERT INTO merchant_rules VALUES ('r2','WHOLEFOODS','cat_deleted','2026-01-02')").run();
  db.prepare("INSERT INTO transactions (id, merchant_name, original_name, category_id, manually_categorized) VALUES ('t4','WHOLEFOODS','WHOLEFOODS',NULL,0)").run();

  assert.doesNotThrow(() => recategorizeAll(db));

  const row = db.prepare("SELECT category_id FROM transactions WHERE id = 't4'").get() as { category_id: string | null };
  assert.equal(row.category_id, null, 'the unapplicable row stays uncategorized');
  // ...and the healthy rows in the same pass were still categorized.
  const t3 = db.prepare("SELECT category_id FROM transactions WHERE id = 't3'").get() as { category_id: string | null };
  assert.equal(t3.category_id, 'cat_coffee', 'a stale rule must not block the rest of the pass');
});
