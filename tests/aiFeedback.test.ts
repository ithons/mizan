import test from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import {
  confirmAdvisorDraft,
  dismissAdvisorDraft,
  undoAdvisorAction,
} from '../server/src/services/advisorDrafts';
import { listAiFeedback } from '../server/src/services/aiFeedback';
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
