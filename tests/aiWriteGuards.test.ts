import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_MAX_ROWS_PER_ACTION,
  AI_MIN_PATTERN_LENGTH,
  checkBlastRadius,
  checkPatternLength,
  checkRuleAgreesWithHistory,
  checkRuleDoesNotContradictOwnerRule,
  partitionByAuthorship,
} from '../server/src/services/aiWriteGuards';
import {
  applyMerchantRulesToExistingTransactions,
  merchantMatchesRulePattern,
  retireMerchantRule,
  upsertMerchantRule,
} from '../server/src/services/rules';
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

test('an owner rule with no matching history still blocks a contradicting AI rule', () => {
  const db = migratedTestDb();
  const software = insertCategory(db, { name: 'Software' });
  const subscriptions = insertCategory(db, { name: 'Subscriptions' });

  upsertMerchantRule(db, 'BACKBLAZE INC', software, TEST_NOW, { source: 'human' });

  // Zero settled transactions, so the history guard has nothing to weigh and waves it through.
  // That is exactly the hole: an owner rule is a statement of intent about rows that do not exist
  // yet, and reading only `transactions` cannot see it.
  assert.equal(checkRuleAgreesWithHistory(db, 'Backblaze', subscriptions).ok, true);

  const blocked = checkRuleDoesNotContradictOwnerRule(db, 'Backblaze', subscriptions);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.ok === false && blocked.reason, 'contradicts_owner_rule');

  // Agreeing with the owner is not contention, and neither is an unrelated merchant.
  assert.equal(checkRuleDoesNotContradictOwnerRule(db, 'Backblaze', software).ok, true);
  assert.equal(checkRuleDoesNotContradictOwnerRule(db, 'Netflix', subscriptions).ok, true);
  db.close();
});

test('two patterns that miss each other still contend when one transaction matches both', () => {
  const db = migratedTestDb();
  const hotels = insertCategory(db, { name: 'Hotels' });
  const travel = insertCategory(db, { name: 'Travel' });

  upsertMerchantRule(db, 'SILVER CITY MOUNTAIN', hotels, TEST_NOW, { source: 'human' });
  // Neither pattern matches the other, so pattern overlap alone would let this through.
  assert.equal(merchantMatchesRulePattern('SILVER CITY MOUNTAIN', 'THREE RIVERS CA'), false);
  assert.equal(checkRuleDoesNotContradictOwnerRule(db, 'THREE RIVERS CA', travel).ok, true);

  insertTransaction(db, { merchant_name: 'SILVER CITY MOUNTAIN RES THREE RIVERS CA' });

  const blocked = checkRuleDoesNotContradictOwnerRule(db, 'THREE RIVERS CA', travel);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.ok === false && blocked.reason, 'contradicts_owner_rule');
  db.close();
});

test('a retired owner rule stops contending, and an AI rule does not gate another AI rule', () => {
  const db = migratedTestDb();
  const software = insertCategory(db, { name: 'Software' });
  const subscriptions = insertCategory(db, { name: 'Subscriptions' });

  const owner = upsertMerchantRule(db, 'BACKBLAZE INC', software, TEST_NOW, { source: 'human' });
  assert.equal(checkRuleDoesNotContradictOwnerRule(db, 'Backblaze', subscriptions).ok, false);

  assert.equal(retireMerchantRule(db, owner.ruleId as string), true);
  assert.equal(checkRuleDoesNotContradictOwnerRule(db, 'Backblaze', subscriptions).ok, true);

  // An AI rule pointing elsewhere is handled by the upsert conflict path, not by this guard.
  upsertMerchantRule(db, 'BACKBLAZE INC', software, TEST_NOW, { source: 'ai' });
  assert.equal(checkRuleDoesNotContradictOwnerRule(db, 'Backblaze', subscriptions).ok, true);
  db.close();
});

test('the rule matcher is symmetric, which is why contention needs one containment test', () => {
  // `rulesContend` used to call the matcher in both directions. It cannot matter: the substring
  // clause already tests containment both ways, and equality and the bigram similarity are
  // symmetric relations. 200,000 random pairs and every pair drawn from the 236 live rule patterns
  // and 4,000 live merchant names found no asymmetric case. This pins the property the single call
  // rests on, so making the matcher directional breaks here rather than silently in the guard.
  const corpus = [
    'Backblaze',
    'BACKBLAZE INC',
    'Spotify',
    'SPOTIFY 877-778-1161, NY',
    'Spotify USA',
    'REI',
    'REI #123 SEATTLE',
    'MOGE TEE BOS_CENTRAL 131-27305592, IL',
    'MGE TEE (BOS_CENTRAL 131-27305592 IL',
    'Blue Bottle',
    'Blue Bottle Coffee',
    'Netflix',
    '',
    'ab',
  ];

  for (const left of corpus) {
    for (const right of corpus) {
      assert.equal(
        merchantMatchesRulePattern(left, right),
        merchantMatchesRulePattern(right, left),
        `"${left}" vs "${right}" answered differently depending on argument order`
      );
    }
  }

  // Not vacuous: the corpus contains pairs that match and pairs that do not.
  assert.equal(merchantMatchesRulePattern('BACKBLAZE INC', 'Backblaze'), true);
  assert.equal(merchantMatchesRulePattern('Netflix', 'Backblaze'), false);
});

test('among the owner rules the more specific pattern wins the overlap, not the newest', () => {
  const db = migratedTestDb();
  const streaming = insertCategory(db, { name: 'Streaming' });
  const subscriptions = insertCategory(db, { name: 'Subscriptions' });

  // Both are the owner's, so the human-first term in the ordering cannot decide this. The longer
  // pattern is the OLDER one, so specificity and recency point at different categories.
  upsertMerchantRule(db, 'SPOTIFY 877-778-1161, NY', streaming, '2026-01-01T00:00:00.000Z', { source: 'human' });
  upsertMerchantRule(db, 'Spotify', subscriptions, '2026-07-01T00:00:00.000Z', { source: 'human' });

  const txn = insertTransaction(db, { merchant_name: 'SPOTIFY 877-778-1161, NY' });
  applyMerchantRulesToExistingTransactions(db, { onlyUncategorized: true });

  const row = db.prepare('SELECT category_id FROM transactions WHERE id = ?').get(txn) as {
    category_id: string;
  };
  // `length(pattern) DESC` re-ranks the owner's rules against each other and not only against the
  // model's. That is a deliberate policy: the narrower claim about a row beats the more recent one.
  // Under the old `created_at DESC` the newer, vaguer rule took it.
  assert.equal(row.category_id, streaming);
  db.close();
});
