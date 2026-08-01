import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import type { AdvisorDraftAction, AdvisorDraftPayload } from '../shared/types';
import {
  confirmAdvisorDraft,
  confirmAdvisorDraftsByIds,
  isDraftStillActionable,
} from '../server/src/services/advisorDrafts';
import { DraftRefusedError } from '../server/src/services/aiWriteGuards';
import type { GuardRejectionReason } from '../server/src/services/aiWriteGuards';
import { getTransactionReviewSummary } from '../server/src/services/transactionReview';
import { upsertMerchantRule } from '../server/src/services/rules';
import { TEST_NOW, insertAccount, insertCategory, insertTransaction, migratedTestDb } from './helpers/schema';

function setupDb(): Database.Database {
  const db = migratedTestDb();
  db.prepare(`
    INSERT INTO goals (id, name, type, target_amount, created_at, updated_at)
    VALUES ('goal_1', 'Goal one', 'savings', 100000, '2026-07-01', '2026-07-01'),
           ('goal_2', 'Goal two', 'savings', 200000, '2026-07-01', '2026-07-01')
  `).run();
  return db;
}

function insertDraft(
  db: Database.Database,
  id: string,
  payload: unknown,
  status = 'open'
): void {
  db.prepare(`
    INSERT INTO advisor_drafts (id, kind, label, summary, route, payload, changes, citations, status,
                                created_at, updated_at)
    VALUES (?, 'update_goal_target', ?, 'summary', '/goals', ?, '[]', '[]', ?, '2026-07-01', '2026-07-01')
  `).run(id, `Draft ${id}`, JSON.stringify(payload), status);
}

test('confirms several drafts and reports each outcome', (t) => {
  const db = setupDb();
  t.after(() => db.close());

  insertDraft(db, 'd1', { kind: 'update_goal_target', goal_id: 'goal_1', target_amount: 5000 });
  insertDraft(db, 'd2', { kind: 'update_goal_target', goal_id: 'goal_2', target_amount: 7000 });

  const result = confirmAdvisorDraftsByIds(db, ['d1', 'd2']);
  assert.equal(result.applied, 2);
  assert.equal(result.skipped, 0);
  // Nothing skipped means nothing to explain: no reason, no refusal, on either outcome.
  assert.equal(result.outcomes.every((o) => o.reason === undefined && o.refused === undefined), true);

  const goals = db.prepare('SELECT id, target_amount FROM goals ORDER BY id').all() as Array<{
    id: string;
    target_amount: number;
  }>;
  // Money crosses the boundary in dollars and lands as integer cents.
  assert.deepEqual(goals, [
    { id: 'goal_1', target_amount: 500000 },
    { id: 'goal_2', target_amount: 700000 },
  ]);

  const statuses = db.prepare('SELECT status FROM advisor_drafts ORDER BY id').all();
  assert.deepEqual(statuses, [{ status: 'confirmed' }, { status: 'confirmed' }]);

  // Every applied draft is recorded in the visible audit trail.
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM advisor_actions').get() as { n: number }).n, 2);
});

test('one bad draft does not roll back the drafts that already applied', (t) => {
  const db = setupDb();
  t.after(() => db.close());

  insertDraft(db, 'good', { kind: 'update_goal_target', goal_id: 'goal_1', target_amount: 5000 });
  // Rejected by AdvisorDraftPayloadSchema before any write (the trust boundary).
  insertDraft(db, 'bad', { kind: 'update_goal_target', goal_id: 'goal_2', target_amount: 'not-a-number' });

  const result = confirmAdvisorDraftsByIds(db, ['good', 'bad']);
  assert.equal(result.applied, 1);
  assert.equal(result.skipped, 1);

  const good = db.prepare("SELECT target_amount FROM goals WHERE id = 'goal_1'").get() as { target_amount: number };
  assert.equal(good.target_amount, 500000, 'the valid draft must survive its neighbour failing');

  const untouched = db.prepare("SELECT target_amount FROM goals WHERE id = 'goal_2'").get() as { target_amount: number };
  assert.equal(untouched.target_amount, 200000);

  const badOutcome = result.outcomes.find((o) => o.id === 'bad');
  assert.equal(badOutcome?.status, 'skipped');
  // A fault, not a refusal. The Zod issue path that explains it is server-log material; what
  // reaches the owner is that applying failed, never the exception text.
  assert.equal(badOutcome?.reason, 'apply_failed');
  assert.equal(badOutcome?.refused, undefined);

  // The failed draft stays open so it can be inspected or dismissed, not silently consumed.
  const status = db.prepare("SELECT status FROM advisor_drafts WHERE id = 'bad'").get() as { status: string };
  assert.equal(status.status, 'open');
});

test('already-resolved and unknown ids are skipped, never re-applied', (t) => {
  const db = setupDb();
  t.after(() => db.close());

  insertDraft(db, 'done', { kind: 'update_goal_target', goal_id: 'goal_1', target_amount: 5000 }, 'confirmed');

  const result = confirmAdvisorDraftsByIds(db, ['done', 'nope']);
  assert.equal(result.applied, 0);
  assert.equal(result.skipped, 2);
  assert.equal(result.outcomes.every((o) => o.reason === 'not_found_or_resolved'), true);

  const goal = db.prepare("SELECT target_amount FROM goals WHERE id = 'goal_1'").get() as { target_amount: number };
  assert.equal(goal.target_amount, 100000, 'a confirmed draft must not apply twice');
});

test('a duplicated id in the request applies once', (t) => {
  const db = setupDb();
  t.after(() => db.close());

  insertDraft(db, 'd1', { kind: 'update_goal_target', goal_id: 'goal_1', target_amount: 5000 });

  const result = confirmAdvisorDraftsByIds(db, ['d1', 'd1', 'd1']);
  assert.equal(result.applied, 1);
  assert.equal(result.outcomes.length, 1);
});

test('an unreadable payload is reported rather than crashing the batch', (t) => {
  const db = setupDb();
  t.after(() => db.close());

  db.prepare(`
    INSERT INTO advisor_drafts (id, kind, label, summary, route, payload, changes, citations, status,
                                created_at, updated_at)
    VALUES ('broken', 'update_goal_target', 'Broken', 'summary', '/goals', 'not json', '[]', '[]', 'open',
            '2026-07-01', '2026-07-01')
  `).run();
  insertDraft(db, 'ok', { kind: 'update_goal_target', goal_id: 'goal_1', target_amount: 5000 });

  const result = confirmAdvisorDraftsByIds(db, ['broken', 'ok']);
  assert.equal(result.applied, 1);
  assert.equal(result.outcomes.find((o) => o.id === 'broken')?.reason, 'unreadable_payload');
});

/**
 * A refused draft is not an action.
 *
 * `confirmMerchantRule` returned `{ changed: 0 }` when a guard said no, and `confirmAdvisorDraft`
 * marked the draft confirmed, wrote an `advisor_actions` row and reported success anyway. The
 * refusal reached the owner as an applied action whose Undo reverted nothing, with the reason
 * buried in a `result` blob no client reads.
 */

function insertRuleDraft(db: Database.Database, id: string, payload: AdvisorDraftPayload): void {
  db.prepare(`
    INSERT INTO advisor_drafts
      (id, kind, label, summary, route, payload, changes, citations, status, created_at, updated_at)
    VALUES (?, ?, ?, 'summary', '/review', ?, '[]', '[]', 'open', ?, ?)
  `).run(id, payload.kind, `Draft ${id}`, JSON.stringify(payload), TEST_NOW, TEST_NOW);
}

function draftAction(id: string, payload: AdvisorDraftPayload): AdvisorDraftAction {
  return {
    id,
    kind: payload.kind,
    label: `Draft ${id}`,
    summary: 'summary',
    route: '/review',
    payload,
    changes: [],
    citations: [],
    confirmation_required: true,
  } as AdvisorDraftAction;
}

test('a refused merchant rule writes no action, leaves the draft open, and reports the refusal', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const software = insertCategory(db, { name: 'Software' });
  const subscriptions = insertCategory(db, { name: 'Subscriptions' });
  upsertMerchantRule(db, 'BACKBLAZE INC', software, TEST_NOW, { source: 'human' });
  insertRuleDraft(db, 'd_backblaze', {
    kind: 'create_merchant_rule',
    pattern: 'Backblaze',
    category_id: subscriptions,
    apply_existing: true,
  });

  const result = confirmAdvisorDraftsByIds(db, ['d_backblaze']);
  assert.equal(result.applied, 0);
  assert.equal(result.skipped, 1);
  assert.equal(result.outcomes[0].refused, 'contradicts_owner_rule');
  assert.match(String(result.outcomes[0].reason), /contends with your own rule "BACKBLAZE INC"/);

  const actions = db.prepare('SELECT COUNT(*) AS n FROM advisor_actions').get() as { n: number };
  assert.equal(actions.n, 0, 'an action with a no-op undo is worse than no action');

  const status = db.prepare("SELECT status FROM advisor_drafts WHERE id = 'd_backblaze'").get() as {
    status: string;
  };
  assert.equal(status.status, 'open', 'a refused draft was never applied, so it is not confirmed');

  const rules = db.prepare("SELECT COUNT(*) AS n FROM merchant_rules WHERE pattern = 'Backblaze'").get() as {
    n: number;
  };
  assert.equal(rules.n, 0);
});

test('the refusal carries its reason and a 409 out to the caller', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const software = insertCategory(db, { name: 'Software' });
  const subscriptions = insertCategory(db, { name: 'Subscriptions' });
  upsertMerchantRule(db, 'BACKBLAZE INC', software, TEST_NOW, { source: 'human' });

  assert.throws(
    () =>
      confirmAdvisorDraft(
        db,
        draftAction('d1', {
          kind: 'create_merchant_rule',
          pattern: 'Backblaze',
          category_id: subscriptions,
          apply_existing: true,
        }),
        true,
        'worker_auto'
      ),
    (err: unknown) => {
      assert.ok(err instanceof DraftRefusedError);
      assert.equal(err.reason, 'contradicts_owner_rule');
      // The owner's data saying no is not a server fault, and the message is written to be shown.
      assert.equal(err.status, 409);
      assert.match(err.message, /^Refused: /);
      return true;
    }
  );

  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM advisor_actions').get() as { n: number }).n, 0);
});

/**
 * The write path decides what may happen; the queue does not pre-judge it.
 *
 * `isDraftStillActionable` briefly asked these same guards, which removed from the review queue
 * every draft they would refuse: no reason shown, no way to see it, four healthy proposals hidden on
 * the live ledger (see the UBER case below). A suggestion nobody can see is worse than one that
 * refuses when clicked, because the refusal is a 409 carrying its own sentence and the draft can be
 * dismissed. The queue asks only whether the draft's premise still exists.
 */

interface RuleScenario {
  name: string;
  /** Prepares the ledger, then returns the pattern and category the draft proposes. */
  build: (db: Database.Database) => { pattern: string; category_id: string };
  refusal: GuardRejectionReason | null;
}

const RULE_SCENARIOS: RuleScenario[] = [
  {
    name: 'a rule with nothing standing against it',
    build: (db) => {
      const streaming = insertCategory(db, { name: 'Streaming' });
      insertTransaction(db, { merchant_name: 'Spotify USA' });
      return { pattern: 'Spotify', category_id: streaming };
    },
    refusal: null,
  },
  {
    name: 'a pattern too short to have a bounded reach',
    build: (db) => ({ pattern: 'REI', category_id: insertCategory(db, { name: 'Outdoors' }) }),
    refusal: 'pattern_too_short',
  },
  {
    name: 'a rule contending with one the owner wrote',
    build: (db) => {
      const software = insertCategory(db, { name: 'Software' });
      const subscriptions = insertCategory(db, { name: 'Subscriptions' });
      upsertMerchantRule(db, 'BACKBLAZE INC', software, TEST_NOW, { source: 'human' });
      return { pattern: 'Backblaze', category_id: subscriptions };
    },
    refusal: 'contradicts_owner_rule',
  },
  {
    name: 'a rule contradicting settled history',
    build: (db) => {
      const streaming = insertCategory(db, { name: 'Streaming' });
      const subscriptions = insertCategory(db, { name: 'Subscriptions' });
      const account = insertAccount(db);
      for (let i = 0; i < 5; i += 1) {
        insertTransaction(db, { account_id: account, merchant_name: 'Spotify USA', category_id: streaming });
      }
      return { pattern: 'Spotify', category_id: subscriptions };
    },
    refusal: 'contradicts_history',
  },
  {
    name: 'a rule that would sweep more rows than one autonomous action may',
    build: (db) => {
      const shopping = insertCategory(db, { name: 'Shopping' });
      const account = insertAccount(db);
      for (let i = 0; i < 201; i += 1) {
        insertTransaction(db, { account_id: account, merchant_name: 'Klarna Purchase' });
      }
      return { pattern: 'Klarna', category_id: shopping };
    },
    refusal: 'blast_radius_exceeded',
  },
  {
    name: 'a rule the model already wrote, now pointed somewhere else',
    build: (db) => {
      const streaming = insertCategory(db, { name: 'Streaming' });
      const subscriptions = insertCategory(db, { name: 'Subscriptions' });
      upsertMerchantRule(db, 'Spotify', streaming, TEST_NOW, { source: 'ai' });
      return { pattern: 'Spotify', category_id: subscriptions };
    },
    refusal: 'rule_exists_with_different_category',
  },
];

function actionCount(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM advisor_actions').get() as { n: number }).n;
}

function draftStatus(db: Database.Database, id: string): string {
  return (db.prepare('SELECT status FROM advisor_drafts WHERE id = ?').get(id) as { status: string }).status;
}

for (const scenario of RULE_SCENARIOS) {
  test(`the queue offers, and the write decides, for ${scenario.name}`, (t) => {
    const db = migratedTestDb();
    t.after(() => db.close());

    const { pattern, category_id } = scenario.build(db);
    const payload: AdvisorDraftPayload = {
      kind: 'create_merchant_rule',
      pattern,
      category_id,
      apply_existing: true,
    };
    insertRuleDraft(db, 'd_rule', payload);

    // The premise of a rule draft is its category, and nothing else: the guards are the write's
    // decision to make, out loud, where the owner can read it.
    assert.equal(isDraftStillActionable(db, payload), true);

    const outcome = confirmAdvisorDraftsByIds(db, ['d_rule']).outcomes[0];
    assert.equal(outcome.refused, scenario.refusal ?? undefined);
    assert.equal(outcome.status, scenario.refusal === null ? 'applied' : 'skipped');

    if (scenario.refusal === null) {
      assert.equal(actionCount(db), 1, 'a rule that was actually written is one action');
      assert.equal(draftStatus(db, 'd_rule'), 'confirmed');
    } else {
      assert.equal(actionCount(db), 0, 'an action with a no-op undo is worse than no action');
      assert.equal(draftStatus(db, 'd_rule'), 'open', 'a refused draft is left for the owner');
    }
  });
}

test('a draft the guards would refuse is still offered, with its refusal explainable', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const software = insertCategory(db, { name: 'Software' });
  const subscriptions = insertCategory(db, { name: 'Subscriptions' });
  upsertMerchantRule(db, 'BACKBLAZE INC', software, TEST_NOW, { source: 'human' });

  insertRuleDraft(db, 'd_refused', {
    kind: 'create_merchant_rule',
    pattern: 'Backblaze',
    category_id: subscriptions,
    apply_existing: true,
  });
  insertRuleDraft(db, 'd_fine', {
    kind: 'create_merchant_rule',
    pattern: 'Trupanion',
    category_id: subscriptions,
    apply_existing: true,
  });

  const summary = getTransactionReviewSummary(db);
  assert.deepEqual(
    summary.ai_drafts.map((d) => d.id).sort(),
    ['d_fine', 'd_refused'],
    'the queue hides neither: a guard decision is shown at confirm time, not by disappearing'
  );
  assert.equal(summary.queues.find((q) => q.id === 'ai_insights')?.count, 2);
});

/**
 * The healthy proposal the owner-rule guard used to mistake for a contradiction.
 *
 * `merchantMatchesRulePattern` matches on containment, so the bare merchant name "Uber" is swept by
 * BOTH "UBER *EATS" and the owner's "UBER   *TRIP HELP.UBER.COM, CA". `rulesContend` read that one
 * shared row as the two rules fighting and refused a food-delivery rule every settled delivery row
 * agrees with. On the owner's ledger that is exactly the shape: several distinct UBER EATS
 * descriptions filed under food delivery, and one bare "Uber" row that drags the ride rule in.
 *
 * The row was never the eats rule's to take, because every owner rule outranks every AI rule, so
 * the guard now asks what the proposal would actually CLAIM and this write goes through. What is
 * pinned here is the whole shape of it landing: the rule is created, the ride row does not move,
 * and the one thing counted as changed is the rule itself.
 */
test('a healthy rule the owner-rule guard used to refuse is offered and applies', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const ride = insertCategory(db, { name: 'Ride share' });
  const delivery = insertCategory(db, { name: 'Food delivery' });
  upsertMerchantRule(db, 'UBER   *TRIP HELP.UBER.COM, CA', ride, TEST_NOW, { source: 'human' });

  const account = insertAccount(db);
  for (const name of [
    'UBER   *EATS HELP.UBER.COM, CA',
    'UBER *EATS HELP.UBER.C 800-5928996, CA',
    'UBER *EATS HELP.UBER.COMCA',
    'UBER *EATS 866-576-1039 CA',
    'UBER *EATS',
  ]) {
    insertTransaction(db, { account_id: account, merchant_name: name, category_id: delivery });
  }
  // The row that used to make the guard fire: swept by the proposal and by the owner's ride rule.
  const rideRow = insertTransaction(db, { account_id: account, merchant_name: 'Uber', category_id: ride });

  const payload: AdvisorDraftPayload = {
    kind: 'create_merchant_rule',
    pattern: 'UBER *EATS',
    category_id: delivery,
    apply_existing: true,
  };
  insertRuleDraft(db, 'd_eats', payload);

  assert.equal(isDraftStillActionable(db, payload), true, 'the owner must be able to see this one');
  assert.deepEqual(getTransactionReviewSummary(db).ai_drafts.map((d) => d.id), ['d_eats']);

  const outcome = confirmAdvisorDraftsByIds(db, ['d_eats']).outcomes[0];
  assert.equal(outcome.status, 'applied');
  assert.equal(outcome.refused, undefined);
  assert.equal(outcome.changed, 1);
  assert.equal(actionCount(db), 1);
  assert.equal(draftStatus(db, 'd_eats'), 'confirmed');

  // The 1 is the rule, and nothing else. Every category write appends a revision, so an empty
  // revisions table is proof no transaction was relabelled: the delivery rows were already filed
  // there, and the ride row belongs to the owner's rule.
  const rule = db.prepare(
    "SELECT category_id, source FROM merchant_rules WHERE pattern = 'UBER *EATS' AND retired_at IS NULL"
  ).get() as { category_id: string; source: string } | undefined;
  assert.deepEqual(rule, { category_id: delivery, source: 'ai' });
  const relabelled = db
    .prepare('SELECT COUNT(*) AS n FROM transaction_category_revisions')
    .get() as { n: number };
  assert.equal(relabelled.n, 0, 'changed: 1 counted the rule creation, not a moved transaction');
  const held = db.prepare('SELECT category_id FROM transactions WHERE id = ?').get(rideRow) as {
    category_id: string;
  };
  assert.equal(held.category_id, ride, 'the owner rule holds the row, so the eats rule cannot take it');
});

/**
 * The blast radius the guard refuses on is the one the write would have.
 *
 * `checkMerchantRuleWritable` ran the pre-write count without saying who was writing the rule, and
 * with no rule stored for the pattern yet there is nothing on disk to read the author off, so the
 * proposal was counted as the owner's. Every owner rule outranks every AI rule, so rows the owner's
 * own rule holds were counted into a limit they can never reach, and `checkBlastRadius` reported
 * that count to the owner verbatim as "would relabel N transactions".
 */
test('rows an owner rule holds are not counted into the autonomous blast radius', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const shopping = insertCategory(db, { name: 'Shopping' });
  const household = insertCategory(db, { name: 'Household' });
  const account = insertAccount(db);

  // Short enough not to contend with the proposal by pattern, so the owner-rule guard stays out of
  // this and the blast radius is the only thing left to decide it.
  upsertMerchantRule(db, 'AMZN.COM', shopping, TEST_NOW, { source: 'human' });
  const rows: string[] = [];
  for (let i = 0; i < 201; i += 1) {
    rows.push(
      insertTransaction(db, { account_id: account, merchant_name: 'AMAZON MKTPLACE PMTS AMZN.COM/BILL WA' })
    );
  }

  insertRuleDraft(db, 'd_amzn', {
    kind: 'create_merchant_rule',
    pattern: 'AMAZON MKTPLACE PMTS',
    category_id: household,
    apply_existing: true,
  });

  const outcome = confirmAdvisorDraftsByIds(db, ['d_amzn']).outcomes[0];
  assert.equal(outcome.refused, undefined, '201 rows the owner rule holds are not this rule to relabel');
  assert.equal(outcome.status, 'applied');
  assert.equal(outcome.changed, 1, 'the rule, and not one of the 201 rows');
  assert.equal(actionCount(db), 1);

  const relabelled = db
    .prepare('SELECT COUNT(*) AS n FROM transaction_category_revisions')
    .get() as { n: number };
  assert.equal(relabelled.n, 0);
  const stillOpen = db
    .prepare(`SELECT COUNT(*) AS n FROM transactions WHERE id IN (${rows.map(() => '?').join(',')}) AND category_id IS NULL`)
    .get(...rows) as { n: number };
  assert.equal(stillOpen.n, 201);
});

/**
 * An upsert that changes nothing is not an action.
 *
 * The worker re-proposes a rule the ledger already has on every pass. That returns 'unchanged' with
 * zero rows stamped, and it still wrote an `advisor_actions` row and marked the draft confirmed:
 * the same "action with no blast radius and an Undo that reverts nothing" the refusal path was fixed
 * to stop producing.
 */
test('re-proposing a rule the ledger already has writes no action', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const subscriptions = insertCategory(db, { name: 'Subscriptions' });
  upsertMerchantRule(db, 'Trupanion', subscriptions, TEST_NOW, { source: 'ai' });

  insertRuleDraft(db, 'd_again', {
    kind: 'create_merchant_rule',
    pattern: 'Trupanion',
    category_id: subscriptions,
    apply_existing: true,
  });

  const outcome = confirmAdvisorDraftsByIds(db, ['d_again']).outcomes[0];
  assert.equal(outcome.status, 'applied');
  assert.equal(outcome.changed, 0, 'nothing was relabelled and no rule was created');
  assert.equal(actionCount(db), 0, 'an Undo over an empty blast radius is a button that can only fail');

  // Resolved all the same: the state it proposes already holds, so leaving it open makes it
  // immortal, which is the symptom this whole area exists to kill.
  assert.equal(draftStatus(db, 'd_again'), 'confirmed');
});

test('a rule whose stored pattern is rewritten did write, and is recorded', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const subscriptions = insertCategory(db, { name: 'Subscriptions' });
  upsertMerchantRule(db, 'trupanion', subscriptions, TEST_NOW, { source: 'ai' });

  insertRuleDraft(db, 'd_case', {
    kind: 'create_merchant_rule',
    pattern: 'Trupanion',
    category_id: subscriptions,
    apply_existing: true,
  });

  const outcome = confirmAdvisorDraftsByIds(db, ['d_case']).outcomes[0];
  assert.equal(outcome.status, 'applied');
  // Zero rows relabelled, but the rule row and its revision were rewritten: "changed nothing" is
  // not the same question as "changed zero rows", which is why the no-op is decided on the write
  // and not on this count.
  assert.equal(outcome.changed, 0);
  assert.equal(actionCount(db), 1);
  const stored = db.prepare('SELECT pattern FROM merchant_rules WHERE retired_at IS NULL').get() as {
    pattern: string;
  };
  assert.equal(stored.pattern, 'Trupanion');
});

test('drafts of other kinds are judged on their own premise, not on the rule guards', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const food = insertCategory(db, { name: 'Food' });
  const txn = insertTransaction(db, { merchant_name: 'Cafe' });

  assert.equal(
    isDraftStillActionable(db, { kind: 'categorize_transaction', transaction_id: txn, category_id: food }),
    true
  );
  assert.equal(
    isDraftStillActionable(db, {
      kind: 'update_budget',
      category_id: food,
      amount: 100,
      period: 'monthly',
      rollover: false,
    }),
    true
  );
});

test('a categorization the owner made by hand refuses the same way, without an action', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const mine = insertCategory(db, { name: 'Mine' });
  const guess = insertCategory(db, { name: 'Guess' });
  const txn = insertTransaction(db, {
    merchant_name: 'Blue Bottle',
    category_id: mine,
    category_source: 'human',
    manually_categorized: 1,
  });
  insertRuleDraft(db, 'd_hand', {
    kind: 'categorize_transaction',
    transaction_id: txn,
    category_id: guess,
  });

  const result = confirmAdvisorDraftsByIds(db, ['d_hand']);
  assert.equal(result.applied, 0);
  assert.equal(result.outcomes[0].refused, 'human_authored');

  const row = db.prepare('SELECT category_id FROM transactions WHERE id = ?').get(txn) as {
    category_id: string;
  };
  assert.equal(row.category_id, mine);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM advisor_actions').get() as { n: number }).n, 0);
  const status = db.prepare("SELECT status FROM advisor_drafts WHERE id = 'd_hand'").get() as { status: string };
  assert.equal(status.status, 'open');
});
