import test from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import {
  confirmAdvisorDraft,
  dismissAdvisorDraft,
  draftLiveness,
  isDraftStillActionable,
  listDeclinedProposals,
  ownerDeclinedProposal,
  restoreDeclinedProposal,
  undoAdvisorAction,
} from '../server/src/services/advisorDrafts';
import { listAiFeedback } from '../server/src/services/aiFeedback';
import { DraftRefusedError } from '../server/src/services/aiWriteGuards';
import { refilableTransactions, retirableOwnRules } from '../server/src/services/aiWorker';
import { upsertMerchantRule } from '../server/src/services/rules';
import { updateTransaction } from '../server/src/services/transactions';
import {
  migratedTestDb,
  insertAccount,
  insertCategory,
  insertTransaction,
  TEST_NOW,
} from './helpers/schema';
import type { AdvisorDraftAction, AdvisorDraftPayload } from '../shared/types';

function draft(payload: AdvisorDraftPayload): AdvisorDraftAction {
  return {
    id: `draft_${payload.kind}`,
    kind: payload.kind,
    label: 'test draft',
    summary: 'Blue Bottle looks like coffee',
    route: '/transactions',
    payload,
    changes: [],
    citations: [],
    confirmation_required: true,
  } as AdvisorDraftAction;
}

function insertOpenDraft(
  db: Database.Database,
  id: string,
  payload: AdvisorDraftPayload,
  summary = 'Blue Bottle looks like coffee'
): string {
  db.prepare(`
    INSERT INTO advisor_drafts (id, kind, label, summary, route, payload, changes, citations,
                                status, created_at, updated_at)
    VALUES (?, ?, 'draft', ?, '/transactions', ?, '[]', '[]', 'open', ?, ?)
  `).run(id, payload.kind, summary, JSON.stringify(payload), TEST_NOW, TEST_NOW);
  return id;
}

/** One AI-categorized transaction, its action, and the ids around it. */
function categorizedByAi(db: Database.Database): {
  transactionId: string;
  coffeeId: string;
  actionId: string;
} {
  const accountId = insertAccount(db);
  const coffeeId = insertCategory(db, { name: 'Coffee' });
  const transactionId = insertTransaction(db, {
    account_id: accountId,
    merchant_name: 'Blue Bottle Coffee',
  });

  confirmAdvisorDraft(
    db,
    draft({ kind: 'categorize_transaction', transaction_id: transactionId, category_id: coffeeId }),
    true,
    'worker_auto'
  );
  const action = db.prepare('SELECT id FROM advisor_actions').get() as { id: string };

  return { transactionId, coffeeId, actionId: action.id };
}

test('undoing an action records what was proposed and what replaced it', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const { transactionId, coffeeId, actionId } = categorizedByAi(db);
  assert.equal(listAiFeedback(db).length, 0, 'applying an action is not feedback');

  const undone = undoAdvisorAction(db, actionId);
  assert.equal(undone.ok, true);

  const feedback = listAiFeedback(db);
  assert.equal(feedback.length, 1);
  assert.equal(feedback[0].signal, 'undo');
  assert.equal(feedback[0].proposal_kind, 'categorize_transaction');
  assert.equal(feedback[0].action_id, actionId);
  assert.equal(feedback[0].transaction_id, transactionId);
  assert.equal(feedback[0].merchant_name, 'Blue Bottle Coffee');
  assert.equal(feedback[0].proposed_category_id, coffeeId, 'what the model chose');
  assert.equal(feedback[0].owner_choice, 'uncategorized', 'the owner preferred nothing to it');
  assert.equal(feedback[0].owner_category_id, null);
  assert.equal(feedback[0].affected_transactions, 1);
  assert.equal(feedback[0].stale, null, 'not a question an undo can be asked');
});

test('a merchant rule undo names the pattern and the row count, not one arbitrary row', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const accountId = insertAccount(db);
  const subscriptions = insertCategory(db, { name: 'Subscriptions' });
  for (const suffix of ['a', 'b', 'c']) {
    insertTransaction(db, {
      id: `txn_spotify_${suffix}`,
      account_id: accountId,
      merchant_name: 'Spotify USA',
    });
  }

  confirmAdvisorDraft(
    db,
    draft({
      kind: 'create_merchant_rule',
      pattern: 'Spotify USA',
      category_id: subscriptions,
      apply_existing: true,
    }),
    true,
    'worker_auto'
  );
  const action = db.prepare(
    "SELECT id FROM advisor_actions WHERE kind = 'create_merchant_rule'"
  ).get() as { id: string };

  const undone = undoAdvisorAction(db, action.id);
  assert.equal(undone.reverted, 3);

  const feedback = listAiFeedback(db);
  assert.equal(feedback.length, 1);
  assert.equal(feedback[0].proposed_pattern, 'Spotify USA');
  assert.equal(feedback[0].proposed_category_id, subscriptions);
  assert.equal(feedback[0].affected_transactions, 3);
  assert.equal(feedback[0].transaction_id, null, 'three rows, so no single row stands for them');
  assert.equal(feedback[0].merchant_name, null);
});

test('a hand edit over an AI category records both categories before the link is cleared', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const { transactionId, coffeeId, actionId } = categorizedByAi(db);
  const groceriesId = insertCategory(db, { name: 'Groceries' });

  const result = updateTransaction(db, transactionId, { category_id: groceriesId });
  assert.equal(result.ok, true);

  const feedback = listAiFeedback(db);
  assert.equal(feedback.length, 1);
  assert.equal(feedback[0].signal, 'manual_override');
  assert.equal(feedback[0].action_id, actionId);
  assert.equal(feedback[0].transaction_id, transactionId);
  assert.equal(feedback[0].merchant_name, 'Blue Bottle Coffee');
  assert.equal(feedback[0].proposed_category_id, coffeeId);
  assert.equal(feedback[0].owner_choice, 'category');
  assert.equal(feedback[0].owner_category_id, groceriesId);

  // The evidence outlives the link the edit destroys, which is the whole point of migration 047.
  const row = db.prepare('SELECT category_action_id FROM transactions WHERE id = ?').get(transactionId) as {
    category_action_id: string | null;
  };
  assert.equal(row.category_action_id, null);
});

test('dismissing a live draft records the proposal, and marks it not stale', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const accountId = insertAccount(db);
  const coffeeId = insertCategory(db, { name: 'Coffee' });
  const transactionId = insertTransaction(db, {
    account_id: accountId,
    merchant_name: 'Blue Bottle Coffee',
  });
  const draftId = insertOpenDraft(db, 'draft_live', {
    kind: 'categorize_transaction',
    transaction_id: transactionId,
    category_id: coffeeId,
  });

  assert.equal(dismissAdvisorDraft(db, draftId).changed, 1);

  const feedback = listAiFeedback(db);
  assert.equal(feedback.length, 1);
  assert.equal(feedback[0].signal, 'draft_dismissed');
  assert.equal(feedback[0].draft_id, draftId);
  assert.equal(feedback[0].proposal_kind, 'categorize_transaction');
  assert.equal(feedback[0].transaction_id, transactionId);
  assert.equal(feedback[0].merchant_name, 'Blue Bottle Coffee');
  assert.equal(feedback[0].proposed_category_id, coffeeId);
  assert.equal(feedback[0].owner_choice, 'declined');
  assert.equal(feedback[0].affected_transactions, 0);
  assert.equal(feedback[0].stale, 0);
  assert.equal(feedback[0].proposal_summary, 'Blue Bottle looks like coffee');
});

test('dismissing a draft whose premise already lapsed is marked stale, not wrong', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const accountId = insertAccount(db);
  const coffeeId = insertCategory(db, { name: 'Coffee' });
  const settled = insertCategory(db, { name: 'Dining' });
  const transactionId = insertTransaction(db, {
    account_id: accountId,
    merchant_name: 'Blue Bottle Coffee',
    category_id: settled,
    category_source: 'human',
    manually_categorized: 1,
  });
  const draftId = insertOpenDraft(db, 'draft_stale', {
    kind: 'categorize_transaction',
    transaction_id: transactionId,
    category_id: coffeeId,
  });

  dismissAdvisorDraft(db, draftId);

  const feedback = listAiFeedback(db);
  assert.equal(feedback.length, 1);
  assert.equal(feedback[0].stale, 1, 'the model was late here, not wrong about the merchant');
});

/** Live targets for the kinds `draftLiveness` has no premise to check. */
function healthyTargets(db: Database.Database): { recurringId: string; holdingId: string; securityId: string } {
  const accountId = insertAccount(db);
  db.prepare(`
    INSERT INTO recurring_patterns
      (id, merchant_name, average_amount, frequency, last_seen, next_expected, created_at, updated_at)
    VALUES ('rec_gym', 'Gym', -4500, 'monthly', '2026-07-01', '2026-08-01', ?, ?)
  `).run(TEST_NOW, TEST_NOW);
  db.prepare("INSERT INTO securities (id, name, type) VALUES ('sec_vt', 'Vanguard Total World', 'etf')").run();
  db.prepare(`
    INSERT INTO holdings (id, account_id, security_id, quantity, institution_price, institution_value, updated_at)
    VALUES ('hold_vt', ?, 'sec_vt', 8, 156.08, 124862, ?)
  `).run(accountId, TEST_NOW);
  return { recurringId: 'rec_gym', holdingId: 'hold_vt', securityId: 'sec_vt' };
}

test('dismissing a kind no liveness check covers records stale unknown, not live', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  // Every target below exists and is healthy, so a NULL here cannot be read as "the target was
  // gone". It is the honest answer: `draftLiveness` has no premise to check for these three kinds,
  // and migration 047 forbids defaulting an unasked question to 0.
  const { recurringId, holdingId, securityId } = healthyTargets(db);

  const unjudged: AdvisorDraftPayload[] = [
    { kind: 'create_recurring_adjustment', recurring_id: recurringId, original_date: '2026-08-01', action: 'skip' },
    { kind: 'set_manual_cost_basis', holding_id: holdingId, manual_cost_basis: 1200 },
    { kind: 'set_sector_metadata', security_id: securityId, sector: 'Technology' },
  ];

  for (const [index, payload] of unjudged.entries()) {
    const draftId = insertOpenDraft(db, `draft_unjudged_${index}`, payload);
    assert.equal(dismissAdvisorDraft(db, draftId).changed, 1);
  }

  const feedback = listAiFeedback(db);
  assert.equal(feedback.length, unjudged.length);
  for (const row of feedback) {
    assert.equal(row.stale, null, `${row.proposal_kind} was never judged, so it cannot record 0`);
    assert.equal(row.owner_choice, 'declined');
  }
  assert.deepEqual(
    new Set(feedback.map((row) => row.proposal_kind)),
    new Set(unjudged.map((payload) => payload.kind))
  );
});

test('a kind that IS judged still records the judgement it made', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  // The counterweight to the test above: not-judged must not swallow the judged cases.
  const liveCategory = insertCategory(db, { name: 'Groceries' });
  const doomedCategory = insertCategory(db, { name: 'Deleted Later' });
  insertOpenDraft(db, 'draft_budget_live', {
    kind: 'update_budget', category_id: liveCategory, amount: 400, period: 'monthly', rollover: false,
  });
  insertOpenDraft(db, 'draft_budget_lapsed', {
    kind: 'update_budget', category_id: doomedCategory, amount: 400, period: 'monthly', rollover: false,
  });
  db.prepare('DELETE FROM categories WHERE id = ?').run(doomedCategory);

  dismissAdvisorDraft(db, 'draft_budget_live');
  dismissAdvisorDraft(db, 'draft_budget_lapsed');

  const byDraft = new Map(listAiFeedback(db).map((row) => [row.draft_id, row]));
  assert.equal(byDraft.get('draft_budget_live')?.stale, 0);
  assert.equal(byDraft.get('draft_budget_lapsed')?.stale, 1);
});

test('a budget draft records no proposed category: its category_id is the target, not a proposal', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const categoryId = insertCategory(db, { name: 'Groceries' });
  insertOpenDraft(db, 'draft_budget', {
    kind: 'update_budget', category_id: categoryId, amount: 400, period: 'monthly', rollover: false,
  });

  dismissAdvisorDraft(db, 'draft_budget');

  for (const row of listAiFeedback(db)) {
    assert.equal(
      row.proposed_category_id,
      null,
      `${row.proposal_kind} proposed a budget, not a category for a transaction`
    );
  }
});

test('a draft whose stored payload no longer parses leaves stale unknown rather than 0', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  db.prepare(`
    INSERT INTO advisor_drafts (id, kind, label, summary, route, payload, changes, citations,
                                status, created_at, updated_at)
    VALUES ('draft_bad', 'categorize_transaction', 'draft', 'unreadable', '/transactions',
            'not json', '[]', '[]', 'open', ?, ?)
  `).run(TEST_NOW, TEST_NOW);

  assert.equal(dismissAdvisorDraft(db, 'draft_bad').changed, 1);

  const feedback = listAiFeedback(db);
  assert.equal(feedback.length, 1);
  assert.equal(feedback[0].stale, null);
  assert.equal(feedback[0].proposed_category_id, null);
  assert.equal(feedback[0].owner_choice, 'declined');
});

// The healthy cases. Every one of these is an ordinary event on a working ledger, and a feedback
// row for any of them is a false record of the model being rejected.

test('applying and confirming drafts writes no feedback at all', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  categorizedByAi(db);
  assert.deepEqual(listAiFeedback(db), []);
});

test('a hand edit that agrees with the AI is agreement, not feedback', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const { transactionId, coffeeId } = categorizedByAi(db);

  const result = updateTransaction(db, transactionId, { category_id: coffeeId });
  assert.equal(result.ok, true);
  assert.deepEqual(listAiFeedback(db), [], 'the owner picked the category the model picked');
});

test('editing a row the AI never touched writes no feedback', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const accountId = insertAccount(db);
  const categoryId = insertCategory(db, { name: 'Groceries' });
  const transactionId = insertTransaction(db, { account_id: accountId, merchant_name: 'Trader Joe' });

  updateTransaction(db, transactionId, { category_id: categoryId });
  assert.deepEqual(listAiFeedback(db), []);
});

test('editing notes, date or amount on an AI-categorized row writes no feedback', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const { transactionId } = categorizedByAi(db);

  updateTransaction(db, transactionId, { notes: 'reimbursable' });
  updateTransaction(db, transactionId, { date: '2026-07-04' });
  updateTransaction(db, transactionId, { amount: -12.5 });

  assert.deepEqual(listAiFeedback(db), [], 'the category was never in dispute');
});

test('a second undo of the same action adds nothing', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const { actionId } = categorizedByAi(db);

  assert.equal(undoAdvisorAction(db, actionId).ok, true);
  assert.equal(listAiFeedback(db).length, 1);

  const again = undoAdvisorAction(db, actionId);
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'nothing_to_undo');
  assert.equal(listAiFeedback(db).length, 1, 'a no-op undo is not a second rejection');
});

test('dismissing an already-dismissed draft adds nothing', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const accountId = insertAccount(db);
  const coffeeId = insertCategory(db, { name: 'Coffee' });
  const transactionId = insertTransaction(db, { account_id: accountId, merchant_name: 'Blue Bottle' });
  const draftId = insertOpenDraft(db, 'draft_twice', {
    kind: 'categorize_transaction',
    transaction_id: transactionId,
    category_id: coffeeId,
  });

  assert.equal(dismissAdvisorDraft(db, draftId).changed, 1);
  assert.equal(dismissAdvisorDraft(db, draftId).changed, 0);
  assert.equal(listAiFeedback(db).length, 1);
});

test('undoing an action id that does not exist writes nothing', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const result = undoAdvisorAction(db, 'no_such_action');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not_found');
  assert.deepEqual(listAiFeedback(db), []);
});

// ── Something reads it ───────────────────────────────────────────────────────
//
// The table was write-only. `dismissAdvisorDraft` wrote the row and nothing anywhere read one back,
// so the owner declining a suggestion taught nothing: the next pass re-proposed it, and for an
// autonomous kind applied it while they were not looking. These are the tests that a no is a no.

function actionCount(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM advisor_actions').get() as { n: number }).n;
}

function refuses(fn: () => unknown): DraftRefusedError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof DraftRefusedError, `expected a refusal, got ${String(err)}`);
    return err;
  }
  throw new assert.AssertionError({ message: 'the write was not refused' });
}

test('a dismissed categorization is not applied unattended when it comes back', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const accountId = insertAccount(db);
  const coffeeId = insertCategory(db, { name: 'Coffee' });
  const transactionId = insertTransaction(db, {
    account_id: accountId,
    merchant_name: 'Blue Bottle Coffee',
  });
  const payload: AdvisorDraftPayload = {
    kind: 'categorize_transaction',
    transaction_id: transactionId,
    category_id: coffeeId,
  };

  dismissAdvisorDraft(db, insertOpenDraft(db, 'draft_declined', payload));

  // The same suggestion, a pass later, with a new draft id: matching on the id would match nothing.
  const refusal = refuses(() => confirmAdvisorDraft(db, draft(payload), true, 'worker_auto'));
  assert.equal(refusal.reason, 'owner_declined');
  assert.match(refusal.detail, /you dismissed this same proposal/);

  const row = db.prepare('SELECT category_id FROM transactions WHERE id = ?').get(transactionId);
  assert.deepEqual(row, { category_id: null }, 'the ledger is where the owner left it');
  assert.equal(actionCount(db), 0, 'a refusal is not an action');

  // And the queue stops offering it, because the premise a dismissal removes is the owner's own.
  assert.equal(isDraftStillActionable(db, payload), false);
  assert.equal(draftLiveness(db, payload), 'lapsed');
});

test('the owner confirming the same thing by hand still applies: they changed their mind', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const accountId = insertAccount(db);
  const coffeeId = insertCategory(db, { name: 'Coffee' });
  const transactionId = insertTransaction(db, { account_id: accountId, merchant_name: 'Blue Bottle' });
  const payload: AdvisorDraftPayload = {
    kind: 'categorize_transaction',
    transaction_id: transactionId,
    category_id: coffeeId,
  };

  dismissAdvisorDraft(db, insertOpenDraft(db, 'draft_declined', payload));

  const result = confirmAdvisorDraft(db, draft(payload), true, 'user_confirm');
  assert.equal(result.changed, 1);
  const row = db.prepare('SELECT category_id FROM transactions WHERE id = ?').get(transactionId);
  assert.deepEqual(row, { category_id: coffeeId });
});

test('a dismissed merchant rule is not written unattended when it comes back', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const accountId = insertAccount(db);
  const subscriptions = insertCategory(db, { name: 'Subscriptions' });
  insertTransaction(db, { account_id: accountId, merchant_name: 'Spotify USA' });
  const payload: AdvisorDraftPayload = {
    kind: 'create_merchant_rule',
    pattern: 'Spotify USA',
    category_id: subscriptions,
    apply_existing: true,
  };

  dismissAdvisorDraft(db, insertOpenDraft(db, 'draft_rule', payload));

  const refusal = refuses(() => confirmAdvisorDraft(db, draft(payload), true, 'worker_auto'));
  assert.equal(refusal.reason, 'owner_declined');
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS n FROM merchant_rules').get() as { n: number }).n,
    0,
    'no rule was written'
  );
  assert.equal(actionCount(db), 0);
});

test('a dismissed retirement is not applied unattended when it comes back', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const pets = insertCategory(db, { name: 'Pets' });
  const ruleId = upsertMerchantRule(db, 'Trupanion', pets, TEST_NOW, { source: 'ai' }).ruleId as string;
  const payload: AdvisorDraftPayload = { kind: 'retire_merchant_rule', rule_id: ruleId };

  dismissAdvisorDraft(db, insertOpenDraft(db, 'draft_retire', payload));

  // `ai_feedback` has no rule column, so the dismissal has to carry the rule's pattern or nothing
  // on the row names which rule the owner defended.
  assert.equal(listAiFeedback(db)[0].proposed_pattern, 'Trupanion');

  const refusal = refuses(() => confirmAdvisorDraft(db, draft(payload), true, 'worker_auto'));
  assert.equal(refusal.reason, 'owner_declined');
  const rule = db.prepare('SELECT retired_at FROM merchant_rules WHERE id = ?').get(ruleId);
  assert.deepEqual(rule, { retired_at: null }, 'the rule the owner kept is still live');
});

/**
 * What the collection queries may and may not do with a dismissal.
 *
 * They used to drop the whole row, which is a wider statement than the block it stood in for: the
 * write guard matches the transaction AND the proposed category, so "file this as Coffee" being
 * refused leaves "file this as Dining" perfectly applicable. Dropping the row hid it from every
 * category at once while it sat in the owner's own uncategorized queue, and there was no way back.
 * The declined category is named on the row instead, and the prompt tells the model what that means.
 */
test('a declined category is named on the row, not used to withhold the row', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const accountId = insertAccount(db);
  const coffee = insertCategory(db, { name: 'Coffee' });
  const dining = insertCategory(db, { name: 'Dining' });
  const declinedRow = insertTransaction(db, {
    account_id: accountId,
    merchant_name: 'Blue Bottle Coffee',
    category_id: dining,
    category_source: 'rule',
  });
  const otherRow = insertTransaction(db, {
    account_id: accountId,
    merchant_name: 'Peet\'s Coffee',
    category_id: dining,
    category_source: 'rule',
  });

  dismissAdvisorDraft(db, insertOpenDraft(db, 'draft_declined_row', {
    kind: 'categorize_transaction', transaction_id: declinedRow, category_id: coffee,
  }));

  const pool = new Map(refilableTransactions(db).map((row) => [row.id, row.declined_categories]));
  assert.deepEqual(
    [...pool.keys()].sort(),
    [declinedRow, otherRow].sort(),
    'the row the owner said no to about ONE category is still offered'
  );
  assert.equal(pool.get(declinedRow), 'Coffee', 'and what they said no to travels with it');
  assert.equal(pool.get(otherRow), null, 'the untouched row carries no such note');
});

/**
 * HEALTHY: nothing dismissed, so nothing is annotated and nothing is withheld.
 *
 * The silence case for the same query. A pool that only ever proved it excludes is how a filter
 * that excludes too much ships.
 */
test('HEALTHY: with no dismissals the pool is annotated with nothing at all', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const accountId = insertAccount(db);
  const dining = insertCategory(db, { name: 'Dining' });
  insertTransaction(db, {
    account_id: accountId, merchant_name: 'Blue Bottle Coffee', category_id: dining, category_source: 'rule',
  });
  insertTransaction(db, {
    account_id: accountId, merchant_name: 'Peet\'s Coffee', category_id: dining, category_source: 'rule',
  });

  const rows = refilableTransactions(db);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.declined_categories), [null, null]);
});

/**
 * A pattern does not identify a rule, and the collection query has to match what the write guard
 * matches.
 *
 * `idx_merchant_rules_pattern_live` is partial (`WHERE retired_at IS NULL`), so any number of
 * retired rules may share a live rule's pattern. Matching a retirement dismissal on the pattern
 * meant a no about a rule the owner has since retired hid a DIFFERENT, later rule from the model and
 * refused its retirement at the write, permanently.
 */
test('a dismissal about one rule does not silence a different rule that shares its pattern', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const coffee = insertCategory(db, { name: 'Coffee' });
  const first = upsertMerchantRule(db, 'Spotify', coffee, TEST_NOW, { source: 'ai' }).ruleId as string;
  dismissAdvisorDraft(db, insertOpenDraft(db, 'draft_retire_first', {
    kind: 'retire_merchant_rule', rule_id: first,
  }));

  // The owner retires it themselves, and a later pass writes a new rule for the same merchant.
  db.prepare('UPDATE merchant_rules SET retired_at = ? WHERE id = ?').run(TEST_NOW, first);
  const second = upsertMerchantRule(db, 'Spotify', coffee, TEST_NOW, { source: 'ai' }).ruleId as string;
  assert.notEqual(first, second);

  const payload: AdvisorDraftPayload = { kind: 'retire_merchant_rule', rule_id: second };
  assert.equal(
    ownerDeclinedProposal(db, payload),
    null,
    'the no was about the first rule, and this is not the first rule'
  );
  assert.equal(draftLiveness(db, payload), 'live');
  assert.deepEqual(
    retirableOwnRules(db).map((r) => r.id),
    [second],
    'the model can still see the rule nobody refused'
  );
});

/** HEALTHY: the same no still covers the rule it was actually about. */
test('HEALTHY: a dismissal about a rule still silences that rule', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const coffee = insertCategory(db, { name: 'Coffee' });
  const kept = upsertMerchantRule(db, 'Trupanion', coffee, TEST_NOW, { source: 'ai' }).ruleId as string;
  const other = upsertMerchantRule(db, 'Backblaze', coffee, TEST_NOW, { source: 'ai' }).ruleId as string;

  assert.deepEqual(
    retirableOwnRules(db).map((r) => r.id).sort(),
    [kept, other].sort(),
    'both start offered'
  );

  dismissAdvisorDraft(db, insertOpenDraft(db, 'draft_declined_rule', {
    kind: 'retire_merchant_rule', rule_id: kept,
  }));

  assert.deepEqual(
    retirableOwnRules(db).map((r) => r.id),
    [other],
    'the rule the owner kept is no longer offered'
  );
  assert.notEqual(ownerDeclinedProposal(db, { kind: 'retire_merchant_rule', rule_id: kept }), null);
});

/**
 * `stale = 1` means one thing (migration 047): the premise had already lapsed before the owner
 * acted. Consulting the owner's own earlier decline first made a second, genuine refusal of a
 * still-live suggestion record itself as the model merely being late, on evidence the code produced
 * from its own suppression.
 */
test('a second decline of the same live proposal is recorded as a refusal, not as staleness', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const accountId = insertAccount(db);
  const coffee = insertCategory(db, { name: 'Coffee' });
  const transactionId = insertTransaction(db, { account_id: accountId, merchant_name: 'Blue Bottle' });
  const payload: AdvisorDraftPayload = {
    kind: 'categorize_transaction', transaction_id: transactionId, category_id: coffee,
  };

  dismissAdvisorDraft(db, insertOpenDraft(db, 'draft_first', payload));
  dismissAdvisorDraft(db, insertOpenDraft(db, 'draft_second', payload));

  assert.deepEqual(
    (db.prepare('SELECT draft_id, stale FROM ai_feedback ORDER BY rowid').all() as Array<{
      draft_id: string; stale: number | null;
    }>),
    [
      { draft_id: 'draft_first', stale: 0 },
      { draft_id: 'draft_second', stale: 0 },
    ],
    'the transaction is still uncategorized both times, so neither dismissal was late'
  );
});

test('declining one category does not silence a different proposal about the same row', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const accountId = insertAccount(db);
  const coffee = insertCategory(db, { name: 'Coffee' });
  const dining = insertCategory(db, { name: 'Dining' });
  const transactionId = insertTransaction(db, { account_id: accountId, merchant_name: 'Blue Bottle' });

  dismissAdvisorDraft(db, insertOpenDraft(db, 'draft_coffee', {
    kind: 'categorize_transaction', transaction_id: transactionId, category_id: coffee,
  }));

  const result = confirmAdvisorDraft(
    db,
    draft({ kind: 'categorize_transaction', transaction_id: transactionId, category_id: dining }),
    true,
    'worker_auto'
  );
  assert.equal(result.changed, 1, 'the owner said no to Coffee, not to the row');
});

test('declining a LATE suggestion does not silence a later live one', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const accountId = insertAccount(db);
  const coffee = insertCategory(db, { name: 'Coffee' });
  const transactionId = insertTransaction(db, {
    account_id: accountId,
    merchant_name: 'Blue Bottle',
    // Hand-categorized, so the draft below has already lapsed when it is dismissed.
    category_id: coffee,
    category_source: 'human',
    manually_categorized: 1,
  });
  const payload: AdvisorDraftPayload = {
    kind: 'categorize_transaction', transaction_id: transactionId, category_id: coffee,
  };

  dismissAdvisorDraft(db, insertOpenDraft(db, 'draft_late', payload));
  assert.equal(listAiFeedback(db)[0].stale, 1, 'the model was late, not wrong');

  // A stale dismissal says nothing about the merchant, so it must not read as a refusal.
  assert.equal(ownerDeclinedProposal(db, payload), null);
});

test('nothing is declined on a ledger with no feedback at all', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const accountId = insertAccount(db);
  const coffee = insertCategory(db, { name: 'Coffee' });
  const transactionId = insertTransaction(db, { account_id: accountId, merchant_name: 'Blue Bottle' });

  assert.equal(
    ownerDeclinedProposal(db, {
      kind: 'categorize_transaction', transaction_id: transactionId, category_id: coffee,
    }),
    null
  );
  assert.equal(
    ownerDeclinedProposal(db, {
      kind: 'create_merchant_rule', pattern: 'Blue Bottle', category_id: coffee, apply_existing: true,
    }),
    null
  );
});

test('an undo is not a dismissal: it does not stop the model proposing again', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  // Undo and manual_override rows are feedback too, and reading them as refusals would make one
  // reversal permanent policy. Only 'draft_dismissed' is a no about a proposal not yet applied.
  const { transactionId, coffeeId, actionId } = categorizedByAi(db);
  assert.equal(undoAdvisorAction(db, actionId).ok, true);
  assert.equal(listAiFeedback(db)[0].signal, 'undo');

  assert.equal(
    ownerDeclinedProposal(db, {
      kind: 'categorize_transaction', transaction_id: transactionId, category_id: coffeeId,
    }),
    null
  );
});

test('the table carries no score, rating or confidence column', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const columns = (
    db.prepare('PRAGMA table_info(ai_feedback)').all() as Array<{ name: string }>
  ).map((column) => column.name);

  for (const forbidden of ['confidence', 'score', 'rating', 'accuracy', 'correct']) {
    assert.equal(columns.includes(forbidden), false, `ai_feedback must not carry ${forbidden}`);
  }
});

// ── The owner's way back ─────────────────────────────────────────────────────

/**
 * A decline is a standing decision, so it has to be one the owner can see and take back.
 *
 * For a while it was neither. `draftLiveness` dropped the draft, `total_open` fell by one, no field
 * on any response named the reason, `listAiFeedback` had no production caller, and the digest joins
 * `ai_feedback` on `action_id`, which a dismissal never carries. The escape hatch the code named
 * (the owner confirming the same thing by hand) ran through `summary.ai_drafts`, which is exactly
 * what the suppression had already emptied.
 */
test('a declined proposal is listed, with what it was about and whether it still suppresses', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const accountId = insertAccount(db);
  const coffeeId = insertCategory(db, { name: 'Coffee' });
  const transactionId = insertTransaction(db, { account_id: accountId, merchant_name: 'Blue Bottle' });
  const draftId = insertOpenDraft(db, 'draft_declined', {
    kind: 'categorize_transaction', transaction_id: transactionId, category_id: coffeeId,
  });
  dismissAdvisorDraft(db, draftId);

  const declined = listDeclinedProposals(db);
  assert.equal(declined.length, 1);
  assert.equal(declined[0].kind, 'categorize_transaction');
  assert.equal(declined[0].category_id, coffeeId);
  assert.equal(declined[0].category_name, 'Coffee');
  assert.equal(declined[0].summary, 'Blue Bottle looks like coffee');
  assert.equal(declined[0].suppressing, true, 'this one is why the suggestion stopped appearing');
});

/** HEALTHY: nothing declined, nothing listed. No standing entry on a clean ledger. */
test('HEALTHY: a ledger with no dismissals lists no declined proposals', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const { actionId } = categorizedByAi(db);
  assert.equal(undoAdvisorAction(db, actionId).ok, true);
  assert.equal(listAiFeedback(db).length, 1, 'there IS feedback on record');
  assert.deepEqual(listDeclinedProposals(db), [], 'but an undo is not a refusal of a proposal');
});

test('restoring a decline lifts the block, reopens the draft, and says whether it is queued', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const accountId = insertAccount(db);
  const coffeeId = insertCategory(db, { name: 'Coffee' });
  const transactionId = insertTransaction(db, { account_id: accountId, merchant_name: 'Blue Bottle' });
  const payload: AdvisorDraftPayload = {
    kind: 'categorize_transaction', transaction_id: transactionId, category_id: coffeeId,
  };
  dismissAdvisorDraft(db, insertOpenDraft(db, 'draft_declined', payload));

  assert.equal(isDraftStillActionable(db, payload), false, 'hidden while the decline stands');

  const restored = restoreDeclinedProposal(db, listDeclinedProposals(db)[0].id);
  assert.deepEqual(restored, { ok: true, draft_reopened: true, queued: true });

  assert.deepEqual(listDeclinedProposals(db), [], 'the refusal is off the record');
  assert.equal(ownerDeclinedProposal(db, payload), null);
  assert.equal(isDraftStillActionable(db, payload), true);
  assert.equal(
    (db.prepare("SELECT status FROM advisor_drafts WHERE id = 'draft_declined'").get() as { status: string }).status,
    'open'
  );
  // And the write path the decline was a bound on is open again.
  assert.equal(confirmAdvisorDraft(db, draft(payload), true, 'worker_auto').changed, 1);
});

/**
 * The reopened draft is not promised to be drawable, it is checked.
 *
 * Here the premise lapsed for an unrelated reason while the decline stood: the owner filed the row
 * by hand. The block is lifted and the row is honestly reported as not queued.
 */
test('restoring a decline whose draft lapsed meanwhile reports it as not queued', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const accountId = insertAccount(db);
  const coffeeId = insertCategory(db, { name: 'Coffee' });
  const groceriesId = insertCategory(db, { name: 'Groceries' });
  const transactionId = insertTransaction(db, { account_id: accountId, merchant_name: 'Blue Bottle' });
  const payload: AdvisorDraftPayload = {
    kind: 'categorize_transaction', transaction_id: transactionId, category_id: coffeeId,
  };
  dismissAdvisorDraft(db, insertOpenDraft(db, 'draft_declined', payload));
  assert.equal(updateTransaction(db, transactionId, { category_id: groceriesId }).ok, true);

  const restored = restoreDeclinedProposal(db, listDeclinedProposals(db)[0].id);
  assert.deepEqual(restored, { ok: true, draft_reopened: true, queued: false });
  assert.equal(ownerDeclinedProposal(db, payload), null, 'the refusal is still lifted');
});

test('restoring something that is not a recorded decline is a miss, not a silent success', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const { actionId } = categorizedByAi(db);
  assert.equal(undoAdvisorAction(db, actionId).ok, true);
  const undoRow = listAiFeedback(db)[0];

  assert.deepEqual(
    restoreDeclinedProposal(db, undoRow.id),
    { ok: false, reason: 'not_found', draft_reopened: false, queued: false },
    'an undo row is not a decline and is not deletable through this door'
  );
  assert.equal(listAiFeedback(db).length, 1, 'and it is still on record');
});

test('a declined proposal whose category was merged away is listed as such, not as one about nothing', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const accountId = insertAccount(db);
  const coffeeId = insertCategory(db, { name: 'Coffee' });
  const transactionId = insertTransaction(db, { account_id: accountId, merchant_name: 'Blue Bottle' });
  dismissAdvisorDraft(db, insertOpenDraft(db, 'draft_declined', {
    kind: 'categorize_transaction', transaction_id: transactionId, category_id: coffeeId,
  }));

  // Not something a delete can do any more (it is a blocker), but a merge can leave the id behind
  // if it is ever changed, and the reader must not read the two apart wrongly.
  db.prepare('UPDATE ai_feedback SET proposed_category_id = ?').run('cat_gone');

  const declined = listDeclinedProposals(db);
  assert.equal(declined[0].category_id, 'cat_gone');
  assert.equal(declined[0].category_name, null, 'named, but no longer resolvable');
});

/**
 * One unreadable draft payload must not take the guard down with it.
 *
 * The retirement identity is read with `json_extract` over `advisor_drafts.payload`, and SQLite
 * RAISES "malformed JSON" rather than returning NULL when handed something that is not JSON. A
 * single such row would have thrown out of both the write guard and the worker's rule collection,
 * which is a far larger failure than the one it was added to fix.
 */
test('a dismissed draft whose payload is not JSON breaks neither the guard nor the rule list', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const coffee = insertCategory(db, { name: 'Coffee' });
  const ruleId = upsertMerchantRule(db, 'Spotify', coffee, TEST_NOW, { source: 'ai' }).ruleId as string;

  db.prepare(`
    INSERT INTO advisor_drafts (id, kind, label, summary, route, payload, changes, citations,
                                status, created_at, updated_at)
    VALUES ('draft_broken', 'retire_merchant_rule', 'l', 's', '/x', 'not json at all', '[]', '[]',
            'dismissed', ?, ?)
  `).run(TEST_NOW, TEST_NOW);
  db.prepare(`
    INSERT INTO ai_feedback (id, signal, proposal_kind, draft_id, owner_choice,
                             affected_transactions, created_at)
    VALUES ('fb_broken', 'draft_dismissed', 'retire_merchant_rule', 'draft_broken', 'declined', 0, ?)
  `).run(TEST_NOW);

  assert.deepEqual(retirableOwnRules(db).map((r) => r.id), [ruleId]);
  assert.equal(ownerDeclinedProposal(db, { kind: 'retire_merchant_rule', rule_id: ruleId }), null);
});
