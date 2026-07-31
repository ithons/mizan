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
  applyMerchantRuleToMatchingTransactions,
  applyMerchantRulesToExistingTransactions,
  countTransactionsHeldByRule,
  merchantMatchesRulePattern,
  retireMerchantRule,
  upsertMerchantRule,
} from '../server/src/services/rules';
import { checkRuleIsRetirableByAi } from '../server/src/services/aiWriteGuards';
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
  const filedByRule = insertTransaction(db, {
    merchant_name: 'Cafe',
    category_id: taxes,
    category_source: 'rule',
  });
  const filedByModel = insertTransaction(db, {
    merchant_name: 'Cafe',
    category_id: taxes,
    category_source: 'ai',
  });
  const handPicked = insertTransaction(db, {
    merchant_name: 'Cafe',
    category_id: taxes,
    category_source: 'human',
    manually_categorized: 1,
  });

  const draftFor = (transaction_id: string, category_id: string) =>
    isDraftStillActionable(db, { kind: 'categorize_transaction', transaction_id, category_id } as never);

  assert.equal(draftFor(uncategorized, food), true);
  // The premise WIDENED here, and this is the line that records it. It used to be "this row is
  // uncategorized", which lapsed every recategorization on sight. It is now the narrower thing that
  // was always the point: nobody has made a decision the model may not revisit.
  assert.equal(draftFor(filedByRule, food), true, 'a rule filed it, and a rule is not a decision the model must respect');
  // The 14 immortal drafts on the real database were this shape: a draft proposing the category the
  // row is already in has nothing to do, and confirming it would write nothing while recording an
  // action whose Undo reverts nothing.
  assert.equal(draftFor(filedByRule, taxes), false, 'already there');
  // The model's own settled answer. Re-proposing it is how the rule path moved Spotify twice in
  // two hours before allowRecategorize: false.
  assert.equal(draftFor(filedByModel, food), false);
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

/**
 * The healthy case that this guard used to fire on, measured on the owner's real ledger.
 *
 * `merchantMatchesRulePattern` sweeps the bare merchant name "Uber" into both `UBER *EATS` and the
 * owner's `UBER   *TRIP HELP.UBER.COM, CA`, so reading "one transaction matches both patterns" as
 * contention refused a food-delivery rule the owner's own settled delivery rows agree with. Across
 * every distinct merchant name on the real ledger (1,297) proposed against the category holding the
 * plurality of its own categorized rows, that reading produced 20 refusals, and 18 of them were
 * refused on the shared-row arm alone: nine `UBER *EATS`/`UBER *LIME` spellings through "Uber", two
 * `GRUBHUB*CHIPOTLE` through "Chipotle", `APPLE STORE #R149 BOSTON MA` through "Apple".
 *
 * What makes it a non-fight is precedence, not similarity: every owner rule outranks every AI rule,
 * so the row named "Uber" was never the eats rule's to take. Both halves are asserted here, because
 * a guard that allows the write is only correct if the write then leaves the row alone.
 */
test('a row the owner rule holds is not contention, and the AI rule cannot take it', () => {
  const db = migratedTestDb();
  const ride = insertCategory(db, { name: 'Ride share' });
  const delivery = insertCategory(db, { name: 'Food delivery' });
  const account = insertAccount(db);

  upsertMerchantRule(db, 'UBER   *TRIP HELP.UBER.COM, CA', ride, TEST_NOW, { source: 'human' });

  for (const name of [
    'UBER   *EATS HELP.UBER.COM, CA',
    'UBER *EATS HELP.UBER.C 800-5928996, CA',
    'UBER *EATS HELP.UBER.COMCA',
  ]) {
    insertTransaction(db, { account_id: account, merchant_name: name, category_id: delivery });
  }
  const rideRow = insertTransaction(db, {
    account_id: account,
    merchant_name: 'Uber',
    category_id: ride,
    category_source: 'rule',
  });

  // The matcher still sweeps that row into both patterns. Tightening it is not what fixed this:
  // every threshold tried lost correct matches, and the measurement is recorded on the matcher.
  assert.equal(merchantMatchesRulePattern('Uber', 'UBER *EATS'), true);
  assert.equal(merchantMatchesRulePattern('Uber', 'UBER   *TRIP HELP.UBER.COM, CA'), true);

  assert.equal(checkRuleDoesNotContradictOwnerRule(db, 'UBER *EATS', delivery).ok, true);
  assert.equal(checkRuleAgreesWithHistory(db, 'UBER *EATS', delivery).ok, true);

  upsertMerchantRule(db, 'UBER *EATS', delivery, TEST_NOW, { source: 'ai' });
  applyMerchantRuleToMatchingTransactions(db, 'UBER *EATS', delivery, TEST_NOW, { overwrite: true });

  const row = db.prepare('SELECT category_id FROM transactions WHERE id = ?').get(rideRow) as {
    category_id: string;
  };
  assert.equal(row.category_id, ride, 'the owner rule holds the row, so the eats rule cannot take it');
  db.close();
});

/**
 * The other shape the narrowing lifted, 3 of the 18: no bare short name involved, a single provider
 * descriptor that names both parties. `CLAUDE.AI SUBSCRIPTION ANTHROPIC.COMCA` is matched by the
 * proposal and by the owner's `Anthropic` rule alike, and the owner's rule holds it.
 */
test('a descriptor naming both parties is not contention either, and the owner keeps its row', () => {
  const db = migratedTestDb();
  const software = insertCategory(db, { name: 'Software' });
  const subscriptions = insertCategory(db, { name: 'Subscriptions' });
  const account = insertAccount(db);

  upsertMerchantRule(db, 'Anthropic', software, TEST_NOW, { source: 'human' });
  const shared = insertTransaction(db, {
    account_id: account,
    merchant_name: 'CLAUDE.AI SUBSCRIPTION ANTHROPIC.COMCA',
    category_id: software,
    category_source: 'rule',
  });
  const own = insertTransaction(db, { account_id: account, merchant_name: 'Claude.ai Subscription' });

  assert.equal(merchantMatchesRulePattern('CLAUDE.AI SUBSCRIPTION ANTHROPIC.COMCA', 'Anthropic'), true);
  assert.equal(
    merchantMatchesRulePattern('CLAUDE.AI SUBSCRIPTION ANTHROPIC.COMCA', 'Claude.ai Subscription'),
    true
  );
  assert.equal(checkRuleDoesNotContradictOwnerRule(db, 'Claude.ai Subscription', subscriptions).ok, true);

  upsertMerchantRule(db, 'Claude.ai Subscription', subscriptions, TEST_NOW, { source: 'ai' });
  applyMerchantRuleToMatchingTransactions(db, 'Claude.ai Subscription', subscriptions, TEST_NOW, {
    overwrite: true,
  });

  const categoryOf = (id: string): string | null =>
    (db.prepare('SELECT category_id FROM transactions WHERE id = ?').get(id) as {
      category_id: string | null;
    }).category_id;
  assert.equal(categoryOf(shared), software, 'the owner rule outranks the proposal on the row it holds');
  assert.equal(categoryOf(own), subscriptions);
  db.close();
});

test('an AI rule that contradicts an owner rule by pattern is still refused', () => {
  const db = migratedTestDb();
  const streaming = insertCategory(db, { name: 'Streaming' });
  const subscriptions = insertCategory(db, { name: 'Subscriptions' });
  const software = insertCategory(db, { name: 'Software' });

  // The two rules Phase 5b found outranking the owner's. Both are caught by pattern overlap alone,
  // which is why narrowing the shared-transaction arm does not reopen them: "Spotify" is contained
  // in "Spotify USA", "Backblaze" in "BACKBLAZE INC".
  upsertMerchantRule(db, 'Spotify USA', streaming, TEST_NOW, { source: 'human' });
  upsertMerchantRule(db, 'BACKBLAZE INC', software, TEST_NOW, { source: 'human' });

  const spotify = checkRuleDoesNotContradictOwnerRule(db, 'Spotify', subscriptions);
  assert.equal(spotify.ok, false);
  assert.equal(spotify.ok === false && spotify.reason, 'contradicts_owner_rule');

  const backblaze = checkRuleDoesNotContradictOwnerRule(db, 'Backblaze', subscriptions);
  assert.equal(backblaze.ok, false);
  assert.equal(backblaze.ok === false && backblaze.reason, 'contradicts_owner_rule');

  // Not through any transaction: the guard exists to protect rows that do not exist yet, and an AI
  // rule contradicting an owner rule would activate silently if the owner ever retired theirs.
  const count = db.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number };
  assert.equal(count.n, 0);
  db.close();
});

test('the owner-rule guard stays silent on ordinary proposals', () => {
  const db = migratedTestDb();
  const groceries = insertCategory(db, { name: 'Groceries' });
  const restaurants = insertCategory(db, { name: 'Restaurants' });
  const delivery = insertCategory(db, { name: 'Food delivery' });
  const account = insertAccount(db);

  upsertMerchantRule(db, 'TRADER JOE S #502 CAMBRIDGE MA', groceries, TEST_NOW, { source: 'human' });
  upsertMerchantRule(db, 'CHIPOTLE 1615 CAMBRIDGE MA', restaurants, TEST_NOW, { source: 'human' });
  insertTransaction(db, { account_id: account, merchant_name: 'Trader Joe\'s', category_id: groceries });
  insertTransaction(db, { account_id: account, merchant_name: 'Chipotle', category_id: restaurants });

  // A merchant the owner has never written a rule about.
  assert.equal(checkRuleDoesNotContradictOwnerRule(db, 'Newmerchant Cafe', restaurants).ok, true);
  // A proposal agreeing with the owner's own rule.
  assert.equal(checkRuleDoesNotContradictOwnerRule(db, 'Trader Joe\'s', groceries).ok, true);
  // A different product line that reaches the owner's merchant only through the bare short name
  // the owner's own rule already holds. 15 of the 18 refusals the narrowing lifted were this shape.
  assert.equal(
    checkRuleDoesNotContradictOwnerRule(db, 'GRUBHUB*CHIPOTLE GRUBHUB.COM NY', delivery).ok,
    true
  );
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

// ─── What a rule holds, and what that does and does not prove ─────────────────

/**
 * `countTransactionsHeldByRule` no longer asks each transaction which rule wins it; it asks each
 * DISTINCT merchant name whether the target's pattern reaches it and whether anything ahead of the
 * target in the resolved order got there first. That took one call on the owner's ledger from
 * 1630.2 / 1675.3 / 1656.3 ms to 7.7 / 8.1 / 7.8 ms, inside a write transaction on the process that
 * also serves the UI.
 *
 * The count it returns has to be the same one, so this pins it against the resolver itself rather
 * than against a second copy of the resolution rules: each rule points at its own category, the
 * whole-ledger pass runs, and the rows it files under a category are the rows that rule holds. The
 * ledger is built so a wrong answer is reachable, with the bare name "Uber" that the matcher sweeps
 * into both patterns and that precedence, not similarity, awards to the owner.
 */
test('a rule holds exactly the rows the whole-ledger pass files under it', () => {
  const db = migratedTestDb();
  const ride = insertCategory(db, { name: 'Ride share' });
  const delivery = insertCategory(db, { name: 'Food delivery' });
  const pets = insertCategory(db, { name: 'Pets' });
  const account = insertAccount(db);

  const owner = upsertMerchantRule(db, 'UBER   *TRIP HELP.UBER.COM, CA', ride, TEST_NOW, { source: 'human' });
  const eats = upsertMerchantRule(db, 'UBER *EATS', delivery, TEST_NOW, { source: 'ai' });
  const inert = upsertMerchantRule(db, 'Trupanion', pets, TEST_NOW, { source: 'ai' });

  for (const name of ['Uber', 'Uber', 'Uber']) {
    insertTransaction(db, { account_id: account, merchant_name: name });
  }
  for (const name of ['UBER   *EATS HELP.UBER.COM, CA', 'UBER *EATS HELP.UBER.COMCA']) {
    insertTransaction(db, { account_id: account, merchant_name: name });
  }

  const held = {
    owner: countTransactionsHeldByRule(db, owner.ruleId as string),
    eats: countTransactionsHeldByRule(db, eats.ruleId as string),
    inert: countTransactionsHeldByRule(db, inert.ruleId as string),
  };

  applyMerchantRulesToExistingTransactions(db, { onlyUncategorized: false, skipManual: true });
  const filedUnder = (categoryId: string): number =>
    (db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE category_id = ?').get(categoryId) as {
      n: number;
    }).n;

  assert.deepEqual(held, { owner: filedUnder(ride), eats: filedUnder(delivery), inert: filedUnder(pets) });
  // Not vacuous, and not a tie: the bare "Uber" rows match the eats pattern too and go to the owner.
  assert.equal(merchantMatchesRulePattern('Uber', 'UBER *EATS'), true);
  assert.equal(held.owner, 3);
  assert.equal(held.eats, 2);
  assert.equal(held.inert, 0);

  // And an id with no live rule behind it is "there is nothing there", not "it holds nothing".
  assert.equal(countTransactionsHeldByRule(db, 'no_such_rule'), null);
  assert.equal(retireMerchantRule(db, inert.ruleId as string), true);
  assert.equal(countTransactionsHeldByRule(db, inert.ruleId as string), null);
  db.close();
});

/**
 * The claim the retirement guard is entitled to make, and the one it is not.
 *
 * `countTransactionsHeldByRule` returning zero establishes that no row resolves to the rule TODAY,
 * so retiring it moves no category now. The note on that function used to add "and none later,
 * because the row it would have taken is already filed by the rule that beat it", which is false for
 * a row that only the retired rule would ever have matched. Nothing beat it there; it simply is not
 * there any more.
 */
test('an inert rule moves no category now, and retiring it still changes where a later row lands', () => {
  const db = migratedTestDb();
  const pets = insertCategory(db, { name: 'Pets' });
  const groceries = insertCategory(db, { name: 'Groceries' });
  const account = insertAccount(db);

  const settled = insertTransaction(db, {
    account_id: account,
    merchant_name: 'Whole Foods',
    category_id: groceries,
    category_source: 'rule',
  });
  const rule = upsertMerchantRule(db, 'Trupanion', pets, TEST_NOW, { source: 'ai' });

  assert.equal(countTransactionsHeldByRule(db, rule.ruleId as string), 0);
  assert.equal(checkRuleIsRetirableByAi(db, rule.ruleId as string).ok, true);

  assert.equal(retireMerchantRule(db, rule.ruleId as string, { source: 'ai' }), true);
  applyMerchantRulesToExistingTransactions(db, { onlyUncategorized: false, skipManual: true });
  const after = db.prepare('SELECT category_id FROM transactions WHERE id = ?').get(settled) as {
    category_id: string | null;
  };
  assert.equal(after.category_id, groceries, 'no row that existed at retirement time moved');

  // The row that arrives afterwards is the part "and none later" got wrong: nothing else claims it,
  // so it lands uncategorized instead of under Pets.
  const later = insertTransaction(db, { account_id: account, merchant_name: 'Trupanion Pet Insurance' });
  applyMerchantRulesToExistingTransactions(db, { onlyUncategorized: true });
  const landed = db.prepare('SELECT category_id FROM transactions WHERE id = ?').get(later) as {
    category_id: string | null;
  };
  assert.equal(landed.category_id, null, 'the retired rule would have filed it, and no rule replaced it');
  db.close();
});

test('the retirement guard refuses a rule that still holds rows, and says how many', () => {
  const db = migratedTestDb();
  const pets = insertCategory(db, { name: 'Pets' });
  const account = insertAccount(db);
  const rule = upsertMerchantRule(db, 'Trupanion', pets, TEST_NOW, { source: 'ai' });
  for (let i = 0; i < 3; i += 1) {
    insertTransaction(db, { account_id: account, merchant_name: 'Trupanion Pet Insurance' });
  }

  assert.equal(countTransactionsHeldByRule(db, rule.ruleId as string), 3);
  const refused = checkRuleIsRetirableByAi(db, rule.ruleId as string);
  assert.equal(refused.ok, false);
  assert.equal(refused.ok === false && refused.reason, 'rule_holds_transactions');
  assert.match(refused.ok === false ? refused.detail : '', /files 3 transactions/);

  // And an owner rule is out of scope whatever it holds.
  const ownRule = upsertMerchantRule(db, 'BACKBLAZE INC', pets, TEST_NOW, { source: 'human' });
  const owned = checkRuleIsRetirableByAi(db, ownRule.ruleId as string);
  assert.equal(owned.ok, false);
  assert.equal(owned.ok === false && owned.reason, 'owner_authored_rule');
  db.close();
});

// ─── The refusal is read by a person ──────────────────────────────────────────

test('the refusal names the owner rule\'s category, never its row id', () => {
  const db = migratedTestDb();
  const subscriptions = insertCategory(db, { id: 'cat_test_subs', name: 'Subscriptions' });
  const softwareLeaf = insertCategory(db, {
    id: 'cat_test_sub_software',
    name: 'Software & AI Tools',
    parent_id: subscriptions,
  });
  const entertainment = insertCategory(db, { id: 'cat_test_ent', name: 'Entertainment' });

  upsertMerchantRule(db, 'BACKBLAZE INC', softwareLeaf, TEST_NOW, { source: 'human' });

  const refused = checkRuleDoesNotContradictOwnerRule(db, 'Backblaze', entertainment);
  assert.equal(refused.ok, false);
  const detail = refused.ok === false ? refused.detail : '';
  assert.equal(
    detail,
    '"Backblaze" contends with your own rule "BACKBLAZE INC", which points at Subscriptions / Software & AI Tools.'
  );
  assert.ok(!detail.includes('cat_test_sub_software'), 'a row id must not reach the owner');
});

test('a root category is named without a phantom parent, and a deleted one says so', () => {
  const db = migratedTestDb();
  const root = insertCategory(db, { id: 'cat_test_root', name: 'Travel' });
  const other = insertCategory(db, { id: 'cat_test_other', name: 'Transport' });
  upsertMerchantRule(db, 'DELTA AIR LINES', root, TEST_NOW, { source: 'human' });

  const refused = checkRuleDoesNotContradictOwnerRule(db, 'Delta Air', other);
  assert.equal(
    refused.ok === false ? refused.detail : '',
    '"Delta Air" contends with your own rule "DELTA AIR LINES", which points at Travel.'
  );

  // A rule left pointing at a category that no longer exists has no name to resolve. Saying so beats
  // inventing one, and the id stays because it is the only handle that still exists.
  db.prepare('PRAGMA foreign_keys = OFF').run();
  db.prepare('DELETE FROM categories WHERE id = ?').run(root);
  const orphaned = checkRuleDoesNotContradictOwnerRule(db, 'Delta Air', other);
  assert.equal(
    orphaned.ok === false ? orphaned.detail : '',
    '"Delta Air" contends with your own rule "DELTA AIR LINES", which points at a category that no longer exists (cat_test_root).'
  );
  db.close();
});

test('nothing in the schema stops two branches holding the same leaf name', () => {
  // The reason `describeCategory` leads with the parent, checked rather than asserted in prose. Read
  // off the migrated schema: `categories` carries exactly one index, and it is over `id`.
  const db = migratedTestDb();
  const indexes = db
    .prepare("SELECT name, origin, `unique` FROM pragma_index_list('categories')")
    .all() as Array<{ name: string; origin: string; unique: number }>;
  assert.deepEqual(indexes, [{ name: 'sqlite_autoindex_categories_1', origin: 'pk', unique: 1 }]);
  assert.deepEqual(db.prepare('SELECT name FROM pragma_index_info(?)').all(indexes[0].name), [{ name: 'id' }]);

  // So the same leaf name under two parents is a state the table accepts, not a hypothetical. The
  // leaf is named for this test because the shipped taxonomy already owns the obvious ones.
  const travel = insertCategory(db, { id: 'cat_dup_travel', name: 'Trips' });
  const work = insertCategory(db, { id: 'cat_dup_work', name: 'Contracting' });
  insertCategory(db, { id: 'cat_dup_travel_leaf', name: 'Kite Repair', parent_id: travel });
  insertCategory(db, { id: 'cat_dup_work_leaf', name: 'Kite Repair', parent_id: work });
  const sameName = db.prepare("SELECT COUNT(*) AS n FROM categories WHERE name = 'Kite Repair'").get() as { n: number };
  assert.equal(sameName.n, 2, 'two leaves, two parents, one name, and the table took it');

  db.close();
});
