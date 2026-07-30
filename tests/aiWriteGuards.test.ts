import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_MAX_ROWS_PER_ACTION,
  AI_MIN_PATTERN_LENGTH,
  checkBlastRadius,
  checkPatternLength,
  checkRuleAgreesWithHistory,
  partitionByAuthorship,
} from '../server/src/services/aiWriteGuards';
import { upsertMerchantRule, retireMerchantRule } from '../server/src/services/rules';
import { isDraftStillActionable } from '../server/src/services/advisorDrafts';
import {
  revertAction,
  writeTransactionCategories,
  writeTransactionCategory,
} from '../server/src/services/categoryWrites';
import {
  TEST_NOW,
  insertAccount,
  insertAdvisorAction,
  insertCategory,
  insertTransaction,
  migratedTestDb,
} from './helpers/schema';

test('an autonomous rule pattern must be long enough to have a bounded reach', () => {
  assert.equal(checkPatternLength('Backblaze').ok, true);
  const short = checkPatternLength('REI');
  assert.equal(short.ok, false);
  assert.equal(short.ok === false && short.reason, 'pattern_too_short');
  // The bound is on the AI path only: an owner writing a three-character rule for their own
  // ledger is making a judgement, and upsertMerchantRule does not consult this guard.
  assert.ok(AI_MIN_PATTERN_LENGTH > 3);
});

test('an autonomous action refuses an unbounded blast radius', () => {
  assert.equal(checkBlastRadius(AI_MAX_ROWS_PER_ACTION).ok, true);
  const tooWide = checkBlastRadius(AI_MAX_ROWS_PER_ACTION + 1);
  assert.equal(tooWide.ok, false);
  assert.equal(tooWide.ok === false && tooWide.reason, 'blast_radius_exceeded');
});

test('a rule that contradicts settled history is refused, a rule over mixed history is not', () => {
  const db = migratedTestDb();
  const streaming = insertCategory(db, { name: 'Streaming' });
  const subscriptions = insertCategory(db, { name: 'Subscriptions' });
  const account = insertAccount(db);

  for (let i = 0; i < 9; i += 1) {
    insertTransaction(db, { account_id: account, merchant_name: 'Spotify', category_id: streaming });
  }
  insertTransaction(db, { account_id: account, merchant_name: 'Spotify', category_id: subscriptions });

  // This is the 2026-07-29 incident: the worker proposing Subscriptions against nine rows of
  // settled Streaming evidence. Changing your mind about settled data is not an observation.
  const contradicts = checkRuleAgreesWithHistory(db, 'Spotify', subscriptions);
  assert.equal(contradicts.ok, false);
  assert.equal(contradicts.ok === false && contradicts.reason, 'contradicts_history');

  assert.equal(checkRuleAgreesWithHistory(db, 'Spotify', streaming).ok, true);
  // A merchant with no settled answer has nothing to contradict.
  assert.equal(checkRuleAgreesWithHistory(db, 'Newmerchant', streaming).ok, true);
  db.close();
});

test('partitionByAuthorship protects rows marked human by either marker', () => {
  const db = migratedTestDb();
  const cat = insertCategory(db);
  const byFlag = insertTransaction(db, { category_id: cat, manually_categorized: 1 });
  const bySource = insertTransaction(db, { category_id: cat, category_source: 'human' });
  const machine = insertTransaction(db, { category_id: cat, category_source: 'rule' });
  const untouched = insertTransaction(db);

  const partition = partitionByAuthorship(db, [byFlag, bySource, machine, untouched, 'nope']);
  assert.deepEqual(partition.humanAuthored.sort(), [byFlag, bySource].sort());
  assert.deepEqual(partition.writable.sort(), [machine, untouched].sort());
  assert.deepEqual(partition.missing, ['nope']);
  db.close();
});

test('an AI upsert will not silently move an existing rule to a different category', () => {
  const db = migratedTestDb();
  const streaming = insertCategory(db, { name: 'Streaming' });
  const subscriptions = insertCategory(db, { name: 'Subscriptions' });

  const created = upsertMerchantRule(db, 'Spotify', streaming, TEST_NOW, { source: 'ai' });
  assert.equal(created.status, 'created');

  // The incident, replayed: a second autonomous pass proposing a different category.
  const conflict = upsertMerchantRule(db, 'Spotify', subscriptions, TEST_NOW, { source: 'ai' });
  assert.equal(conflict.status, 'conflict');
  assert.equal(conflict.fromCategoryId, streaming);

  const row = db.prepare('SELECT category_id FROM merchant_rules WHERE id = ?').get(created.ruleId) as {
    category_id: string;
  };
  assert.equal(row.category_id, streaming, 'the rule must not have moved');

  // The owner may still move it, and that move is recorded.
  const moved = upsertMerchantRule(db, 'Spotify', subscriptions, TEST_NOW, { source: 'human' });
  assert.equal(moved.status, 'recategorized');
  const revisions = db
    .prepare('SELECT operation, from_category_id, to_category_id FROM merchant_rule_revisions ORDER BY rowid')
    .all() as Array<{ operation: string; from_category_id: string | null; to_category_id: string | null }>;
  assert.deepEqual(
    revisions.map((r) => r.operation),
    ['create', 'recategorize']
  );
  assert.equal(revisions[1].from_category_id, streaming);
  assert.equal(revisions[1].to_category_id, subscriptions);
  db.close();
});

test('case variants resolve to one live rule, enforced by the schema', () => {
  const db = migratedTestDb();
  const cat = insertCategory(db);
  const first = upsertMerchantRule(db, 'Spotify', cat, TEST_NOW, { source: 'human' });
  const second = upsertMerchantRule(db, 'spotify', cat, TEST_NOW, { source: 'human' });
  assert.equal(second.ruleId, first.ruleId);
  const count = db.prepare('SELECT COUNT(*) AS n FROM merchant_rules').get() as { n: number };
  assert.equal(count.n, 1);

  // Retiring frees the pattern, which is why the unique index is partial.
  assert.equal(retireMerchantRule(db, first.ruleId as string), true);
  const reborn = upsertMerchantRule(db, 'Spotify', cat, TEST_NOW, { source: 'human' });
  assert.equal(reborn.status, 'created');
  assert.notEqual(reborn.ruleId, first.ruleId);
  db.close();
});

test('every category write appends a revision, so repeated writes do not erase history', () => {
  const db = migratedTestDb();
  const a = insertCategory(db, { name: 'A' });
  const b = insertCategory(db, { name: 'B' });
  const c = insertCategory(db, { name: 'C' });
  const txn = insertTransaction(db, { category_id: a, category_source: 'rule' });
  const first = insertAdvisorAction(db);
  const second = insertAdvisorAction(db);

  writeTransactionCategory(db, { transactionId: txn, categoryId: b, source: 'ai', actionId: first });
  writeTransactionCategory(db, { transactionId: txn, categoryId: c, source: 'ai', actionId: second });

  const revisions = db
    .prepare('SELECT from_category_id, to_category_id, action_id FROM transaction_category_revisions ORDER BY rowid')
    .all() as Array<{ from_category_id: string; to_category_id: string; action_id: string }>;
  assert.equal(revisions.length, 2);
  // The single-slot design lost this: the second write overwrote the first's memory of `a`.
  assert.equal(revisions[0].from_category_id, a);
  assert.equal(revisions[1].from_category_id, b);
  db.close();
});

test('undo restores the displaced category AND its source, and is stack-ordered', () => {
  const db = migratedTestDb();
  const mine = insertCategory(db, { name: 'Mine' });
  const guess = insertCategory(db, { name: 'Guess' });
  const later = insertCategory(db, { name: 'Later' });
  const txn = insertTransaction(db, { category_id: mine, category_source: 'human', manually_categorized: 1 });
  const first = insertAdvisorAction(db);
  const second = insertAdvisorAction(db);

  writeTransactionCategory(db, { transactionId: txn, categoryId: guess, source: 'ai', actionId: first });
  writeTransactionCategory(db, { transactionId: txn, categoryId: later, source: 'ai', actionId: second });

  // The earlier action is buried: reverting it would discard the later decision.
  assert.equal(revertAction(db, first), 0);

  assert.equal(revertAction(db, second), 1);
  assert.equal(revertAction(db, first), 1);

  const row = db.prepare('SELECT category_id, category_source FROM transactions WHERE id = ?').get(txn) as {
    category_id: string;
    category_source: string;
  };
  assert.equal(row.category_id, mine);
  // The old undo wrote 'rule' here unconditionally, handing a hand-made choice back relabelled as
  // machine-authored and leaving it open to the next skipManual pass.
  assert.equal(row.category_source, 'human');
  db.close();
});

test('a write that changes nothing is not counted as a change', () => {
  const db = migratedTestDb();
  const cat = insertCategory(db);
  const txn = insertTransaction(db, { category_id: cat, category_source: 'rule' });

  const changed = writeTransactionCategories(db, [
    { transactionId: txn, categoryId: cat, source: 'rule' },
    { transactionId: 'missing', categoryId: cat, source: 'rule' },
  ]);
  assert.equal(changed, 0, 'callers must never report a blast radius larger than what happened');
  db.close();
});

test('a draft whose premise no longer holds is not surfaced as work', () => {
  const db = migratedTestDb();
  const food = insertCategory(db, { name: 'Food' });
  const taxes = insertCategory(db, { name: 'Taxes' });

  const uncategorized = insertTransaction(db, { merchant_name: 'Cafe' });
  const alreadySettled = insertTransaction(db, { merchant_name: 'Cafe', category_id: taxes });
  const handPicked = insertTransaction(db, {
    merchant_name: 'Cafe',
    category_id: taxes,
    category_source: 'human',
    manually_categorized: 1,
  });

  const draftFor = (transaction_id: string, category_id: string) =>
    isDraftStillActionable(db, { kind: 'categorize_transaction', transaction_id, category_id } as never);

  assert.equal(draftFor(uncategorized, food), true);
  // The 14 immortal drafts on the real database were all this shape: the worker only drafts for
  // uncategorized rows, so once the row has a category the draft is proposing to overwrite a
  // decision nobody asked it to revisit.
  assert.equal(draftFor(alreadySettled, food), false);
  assert.equal(draftFor(handPicked, food), false);
  assert.equal(draftFor('missing-transaction', food), false);
  // Three of the real drafts pointed at a category migration 036 deleted.
  assert.equal(draftFor(uncategorized, 'cat_deleted_by_a_migration'), false);
  db.close();
});
