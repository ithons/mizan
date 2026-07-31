import test from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import {
  buildAiDigest,
  DEFAULT_DIGEST_ACTION_LIMIT,
  MAX_REVERT_ACTIONS,
  revertAiDigestSince,
} from '../server/src/services/aiDigest';
import { writeTransactionCategory } from '../server/src/services/categoryWrites';
import { undoAdvisorAction } from '../server/src/services/advisorDrafts';
import {
  insertAccount,
  insertAdvisorAction,
  insertCategory,
  insertTransaction,
  migratedTestDb,
} from './helpers/schema';

/**
 * The digest is a diff read out of the revision log, so every fixture here writes through
 * `categoryWrites` rather than seeding the log by hand: a test that inserts its own revisions
 * proves the reader and nothing about the writer it has to agree with.
 */

interface Fixture {
  db: Database.Database;
  account: string;
  groceries: string;
  dining: string;
}

function fixture(): Fixture {
  const db = migratedTestDb();
  return {
    db,
    account: insertAccount(db, { account_name: 'Chase Checking' }),
    groceries: insertCategory(db, { id: 'cat_groceries', name: 'Groceries' }),
    dining: insertCategory(db, { id: 'cat_dining', name: 'Dining' }),
  };
}

/** One AI action that categorizes one transaction, written the way the apply path writes it. */
function aiCategorized(
  f: Fixture,
  params: { merchant: string; amount: number; to: string; from?: string | null; at: string }
): { actionId: string; transactionId: string } {
  const transactionId = insertTransaction(f.db, {
    account_id: f.account,
    merchant_name: params.merchant,
    amount: params.amount,
    date: '2026-07-10',
    category_id: params.from ?? null,
  });
  const actionId = insertAdvisorAction(f.db, { kind: 'categorize_transaction' });
  f.db.prepare('UPDATE advisor_actions SET created_at = ?, label = ? WHERE id = ?').run(
    params.at,
    `Categorize ${params.merchant}`,
    actionId
  );
  writeTransactionCategory(
    f.db,
    { transactionId, categoryId: params.to, source: 'ai', actionId },
    params.at
  );
  return { actionId, transactionId };
}

test('HEALTHY: an install where the AI has done nothing reports the fact and offers no revert', (t) => {
  const f = fixture();
  t.after(() => f.db.close());

  // A ledger with real data in it, just no AI action: the empty case must be about the AI, not
  // about the install being empty.
  insertTransaction(f.db, { account_id: f.account, merchant_name: 'Whole Foods', amount: -4212 });

  const digest = buildAiDigest(f.db);

  assert.equal(digest.action_count, 0);
  assert.equal(digest.row_count, 0);
  assert.equal(digest.standing_rows, 0);
  assert.equal(digest.revertable_rows, 0, 'nothing to revert means the control cannot render');
  assert.equal(digest.already_reverted_rows, 0);
  assert.equal(digest.changed_since_rows, 0);
  assert.equal(digest.replaced_within_action_rows, 0);
  assert.equal(digest.actions_that_changed_no_rows, 0, 'no actions at all, so none of either kind');
  assert.equal(digest.actions_unrecorded, 0);
  assert.equal(digest.truncated, false);
  assert.equal(digest.action_limit, DEFAULT_DIGEST_ACTION_LIMIT);
  assert.deepEqual(digest.actions, []);
});

test('HEALTHY: an untouched AI categorization reads as standing work, row-level and revertable', (t) => {
  const f = fixture();
  t.after(() => f.db.close());

  aiCategorized(f, {
    merchant: "Trader Joe's",
    amount: -6350,
    to: f.groceries,
    at: '2026-07-20T10:00:00.000Z',
  });

  const digest = buildAiDigest(f.db);
  assert.equal(digest.action_count, 1);
  assert.equal(digest.row_count, 1);

  const [action] = digest.actions;
  assert.equal(action.record_state, 'rows');
  assert.equal(action.revert_scope, 'full');
  assert.equal(action.standing_rows, 1);
  assert.equal(action.revertable_rows, 1);
  assert.equal(action.blocked_rows, 0);
  assert.deepEqual(action.owner_feedback, []);

  const [row] = action.rows;
  assert.equal(row.merchant, "Trader Joe's");
  assert.equal(row.amount, -63.5, 'cents in the DB, dollars at the edge');
  assert.equal(row.before_category_id, null);
  assert.equal(row.after_category_id, f.groceries);
  assert.equal(row.after_category_name, 'Groceries');
  assert.equal(row.status, 'standing');
  assert.equal(row.revertable, true);
  assert.equal(row.blocked_reason, null);
});

test('a row the owner has since edited by hand is reported blocked, not silently reverted', (t) => {
  const f = fixture();
  t.after(() => f.db.close());

  const { transactionId } = aiCategorized(f, {
    merchant: 'Sweetgreen',
    amount: -1875,
    to: f.groceries,
    at: '2026-07-20T10:00:00.000Z',
  });
  writeTransactionCategory(
    f.db,
    { transactionId, categoryId: f.dining, source: 'human', markManual: true },
    '2026-07-21T09:00:00.000Z'
  );

  const digest = buildAiDigest(f.db);
  const [action] = digest.actions;
  assert.equal(action.revert_scope, 'none');
  assert.equal(action.standing_rows, 0);
  assert.equal(action.revertable_rows, 0);
  assert.equal(action.blocked_rows, 1);

  const [row] = action.rows;
  assert.equal(row.status, 'superseded');
  assert.equal(row.revertable, false);
  assert.equal(row.blocked_reason, 'changed_since');
  assert.equal(row.changed_since_by_source, 'human');
  assert.equal(row.changed_since_by_action_id, null);
  assert.equal(digest.revertable_rows, 0, 'the digest cannot offer to put back what it cannot reach');
});

test('a row a LATER AI action displaced is revertable, because the revert peels the newer one first', (t) => {
  const f = fixture();
  t.after(() => f.db.close());

  const first = aiCategorized(f, {
    merchant: 'Blue Bottle',
    amount: -725,
    to: f.groceries,
    at: '2026-07-20T10:00:00.000Z',
  });
  const secondAction = insertAdvisorAction(f.db, { kind: 'categorize_transaction' });
  f.db.prepare('UPDATE advisor_actions SET created_at = ? WHERE id = ?').run(
    '2026-07-22T10:00:00.000Z',
    secondAction
  );
  writeTransactionCategory(
    f.db,
    { transactionId: first.transactionId, categoryId: f.dining, source: 'ai', actionId: secondAction },
    '2026-07-22T10:00:00.000Z'
  );

  const digest = buildAiDigest(f.db, { since: '2026-07-01T00:00:00.000Z' });
  assert.equal(digest.action_count, 2);
  assert.equal(digest.actions[0].action_id, secondAction, 'newest first, which is undo order');
  assert.equal(digest.revertable_rows, 2, 'both, because the newer one comes off first');

  const older = digest.actions[1];
  assert.equal(older.rows[0].status, 'superseded', 'the older value is not what the ledger holds');
  assert.equal(older.rows[0].revertable, true, 'but this gesture can still reach it');

  // And the plan is what the gesture really does.
  const outcome = revertAiDigestSince(f.db, '2026-07-01T00:00:00.000Z');
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.result.planned_rows, 2);
  assert.equal(outcome.result.reverted_rows, 2);
  assert.deepEqual(outcome.result.discrepancies, []);

  const settled = f.db
    .prepare('SELECT category_id, category_source FROM transactions WHERE id = ?')
    .get(first.transactionId) as { category_id: string | null; category_source: string | null };
  assert.equal(settled.category_id, null, 'back to what it was before either action');
  assert.equal(settled.category_source, null);
});

test('revert-since restates what it left alone rather than reporting only what it managed', (t) => {
  const f = fixture();
  t.after(() => f.db.close());

  aiCategorized(f, { merchant: 'Costco', amount: -12045, to: f.groceries, at: '2026-07-20T10:00:00.000Z' });
  const edited = aiCategorized(f, {
    merchant: 'Philz',
    amount: -640,
    to: f.groceries,
    at: '2026-07-20T11:00:00.000Z',
  });
  writeTransactionCategory(
    f.db,
    { transactionId: edited.transactionId, categoryId: f.dining, source: 'human', markManual: true },
    '2026-07-21T09:00:00.000Z'
  );

  const outcome = revertAiDigestSince(f.db, '2026-07-01T00:00:00.000Z');
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.result.planned_rows, 1);
  assert.equal(outcome.result.reverted_rows, 1);
  assert.equal(outcome.result.changed_since_rows, 1, 'the row it never claimed is still in the answer');
  assert.equal(outcome.result.already_reverted_rows, 0);
  assert.deepEqual(outcome.result.discrepancies, []);
  assert.equal(outcome.result.actions.length, 1, 'the action with nothing revertable is not attempted');

  const stillEdited = f.db
    .prepare('SELECT category_id FROM transactions WHERE id = ?')
    .get(edited.transactionId) as { category_id: string | null };
  assert.equal(stillEdited.category_id, f.dining, 'the hand edit survived the revert');
});

test('an action the owner already undid reads as answered, not as standing work', (t) => {
  const f = fixture();
  t.after(() => f.db.close());

  const { actionId } = aiCategorized(f, {
    merchant: "Peet's",
    amount: -510,
    to: f.groceries,
    at: '2026-07-20T10:00:00.000Z',
  });
  assert.equal(undoAdvisorAction(f.db, actionId).ok, true);

  const digest = buildAiDigest(f.db);
  const [action] = digest.actions;
  assert.equal(action.standing_rows, 0);
  assert.equal(action.revertable_rows, 0);
  assert.equal(action.revert_scope, 'none');
  assert.equal(action.rows[0].status, 'reverted');
  assert.equal(action.rows[0].blocked_reason, 'already_reverted');
  assert.equal(action.owner_feedback.length, 1, 'migration 047 recorded the reversal');
  assert.equal(action.owner_feedback[0].signal, 'undo');
  assert.equal(digest.revertable_rows, 0);

  // The distinction the first version of this collapsed: running the gesture again must not report
  // the owner's own undo as somebody else having changed the row since.
  const again = revertAiDigestSince(f.db, '2026-07-01T00:00:00.000Z');
  assert.equal(again.ok, true);
  if (!again.ok) return;
  assert.equal(again.result.reverted_rows, 0);
  assert.equal(again.result.already_reverted_rows, 1);
  assert.equal(again.result.changed_since_rows, 0, 'nobody changed it since; the owner reverted it');
});

/**
 * When the revision log began on this database. Migration 042 created it, and `migratedTestDb`
 * applies every migration at test time, so a fixture that wants to be ON the recorded side of that
 * boundary has to say so with a timestamp rather than a hardcoded date in the past.
 */
function revisionLogStart(db: Database.Database): string {
  const row = db
    .prepare('SELECT applied_at FROM schema_migrations WHERE name = ?')
    .get('042_ai_write_provenance.sql') as { applied_at: string } | undefined;
  assert.ok(row, 'migration 042 must be applied for the digest to know when the log began');
  return row.applied_at;
}

test('HEALTHY: a merchant rule that matched no transactions reads as changing none, not as a gap', (t) => {
  const f = fixture();
  t.after(() => f.db.close());

  // `create_merchant_rule` is autonomous, and a rule whose pattern matches no settled transaction
  // applies cleanly: {applied: 0, status: 'created'}, changed: 1. Its record is complete.
  const actionId = insertAdvisorAction(f.db, { kind: 'create_merchant_rule' });
  const at = new Date(Date.parse(revisionLogStart(f.db)) + 1000).toISOString();
  f.db.prepare('UPDATE advisor_actions SET created_at = ?, label = ? WHERE id = ?').run(
    at,
    'Create rule for Trupanion',
    actionId
  );
  f.db.prepare(`
    INSERT INTO merchant_rules (id, pattern, category_id, created_at, source, action_id)
    VALUES ('rule_1', 'Trupanion', ?, ?, 'ai', ?)
  `).run(f.groceries, at, actionId);

  const digest = buildAiDigest(f.db);
  const [action] = digest.actions;
  assert.equal(action.record_state, 'no_rows_changed');
  assert.equal(action.revert_scope, 'nothing_to_revert', 'nothing to put back is not a missing record');
  assert.deepEqual(action.rows, []);
  assert.equal(action.rule?.pattern, 'Trupanion', 'the rule it did write is still shown');
  assert.equal(action.rule?.category_name, 'Groceries');
  assert.equal(digest.actions_that_changed_no_rows, 1);
  assert.equal(digest.actions_unrecorded, 0, 'nothing about this action is unrecorded');
  assert.equal(digest.revertable_rows, 0);
});

test('an action applied before the revision log existed is reported unrecorded, not as a no-op', (t) => {
  const f = fixture();
  t.after(() => f.db.close());

  // The shape on the owner's ledger: every advisor_action on record predates migration 042
  // (measured 2026-07-30: max action created_at 2026-07-29T20:04:50.962Z, 042 applied
  // 2026-07-30T04:56:05.361Z). Whether such an action changed a row was never written down.
  const actionId = insertAdvisorAction(f.db, { kind: 'create_merchant_rule' });
  const before = new Date(Date.parse(revisionLogStart(f.db)) - 1000).toISOString();
  f.db.prepare('UPDATE advisor_actions SET created_at = ? WHERE id = ?').run(before, actionId);

  const digest = buildAiDigest(f.db);
  const [action] = digest.actions;
  assert.equal(action.record_state, 'unrecorded');
  assert.equal(action.revert_scope, 'unrecorded');
  assert.deepEqual(action.rows, []);
  assert.equal(digest.actions_unrecorded, 1);
  assert.equal(digest.actions_that_changed_no_rows, 0, 'silence is not evidence it changed nothing');
  assert.equal(digest.revertable_rows, 0);
});

test('an action that wrote one row twice is not reported as its own intruder', (t) => {
  const f = fixture();
  t.after(() => f.db.close());

  const first = aiCategorized(f, {
    merchant: 'Trupanion',
    amount: -8900,
    to: f.groceries,
    at: '2026-07-20T10:00:00.000Z',
  });
  // Same action, same transaction, written again. Undo restores the newest write's prior value, so
  // the earlier one genuinely cannot be put back; the reason is the action itself, not an outsider.
  writeTransactionCategory(
    f.db,
    { transactionId: first.transactionId, categoryId: f.dining, source: 'ai', actionId: first.actionId },
    '2026-07-20T10:00:05.000Z'
  );

  const digest = buildAiDigest(f.db);
  const [action] = digest.actions;
  assert.equal(action.rows.length, 2);

  const earlier = action.rows[0];
  assert.equal(earlier.revertable, false);
  assert.equal(earlier.blocked_reason, 'replaced_by_same_action');
  assert.equal(earlier.changed_since_by_action_id, first.actionId);
  assert.equal(digest.changed_since_rows, 0, 'nothing outside this action touched the row');
  assert.equal(digest.replaced_within_action_rows, 1);

  assert.equal(action.rows[1].revertable, true, 'the newest write is still reachable');
  assert.equal(action.revert_scope, 'partial');
});

test('a revert refuses a window wider than the limit it was planned against', (t) => {
  const f = fixture();
  t.after(() => f.db.close());

  aiCategorized(f, { merchant: 'One', amount: -100, to: f.groceries, at: '2026-07-20T10:00:00.000Z' });
  aiCategorized(f, { merchant: 'Two', amount: -200, to: f.groceries, at: '2026-07-20T11:00:00.000Z' });

  // What the panel would have described with a cap of 1: one action, one row.
  const shown = buildAiDigest(f.db, { since: '2026-07-01T00:00:00.000Z', limit: 1 });
  assert.equal(shown.truncated, true);
  assert.equal(shown.revertable_rows, 1);

  const outcome = revertAiDigestSince(f.db, '2026-07-01T00:00:00.000Z', 1);
  assert.equal(outcome.ok, false, 'reverting 2 rows after describing 1 is the failure this prevents');
  if (outcome.ok) return;
  assert.match(outcome.error, /more than this view counted/);

  const untouched = f.db
    .prepare("SELECT COUNT(*) AS n FROM transactions WHERE category_id = ?")
    .get(f.groceries) as { n: number };
  assert.equal(untouched.n, 2, 'the refusal wrote nothing');

  // And the same window with the limit that really covered it goes through.
  const full = revertAiDigestSince(f.db, '2026-07-01T00:00:00.000Z', 2);
  assert.equal(full.ok, true);
  if (!full.ok) return;
  assert.equal(full.result.action_limit, 2);
  assert.equal(full.result.planned_rows, 2);
  assert.equal(full.result.reverted_rows, 2);
});

test('a revert limit outside the accepted range is refused rather than clamped', (t) => {
  const f = fixture();
  t.after(() => f.db.close());

  for (const limit of [0, -1, 1.5, MAX_REVERT_ACTIONS + 1]) {
    const outcome = revertAiDigestSince(f.db, '2026-07-01T00:00:00.000Z', limit);
    assert.equal(outcome.ok, false, `limit ${limit} must be refused`);
  }
});

test('since filters on the action timestamp, and a truncated window says it is truncated', (t) => {
  const f = fixture();
  t.after(() => f.db.close());

  aiCategorized(f, { merchant: 'Old', amount: -100, to: f.groceries, at: '2026-06-01T10:00:00.000Z' });
  aiCategorized(f, { merchant: 'New', amount: -200, to: f.groceries, at: '2026-07-25T10:00:00.000Z' });

  const windowed = buildAiDigest(f.db, { since: '2026-07-01T00:00:00.000Z' });
  assert.equal(windowed.action_count, 1);
  assert.equal(windowed.actions[0].rows[0].merchant, 'New');
  assert.equal(windowed.truncated, false);

  const capped = buildAiDigest(f.db, { limit: 1 });
  assert.equal(capped.action_count, 1);
  assert.equal(capped.truncated, true, 'silent truncation would read as completeness');
});

test('a deleted category is named as deleted rather than dropped from the diff', (t) => {
  const f = fixture();
  t.after(() => f.db.close());

  const doomed = insertCategory(f.db, { name: 'Retired category' });
  const { transactionId } = aiCategorized(f, {
    merchant: 'Somewhere',
    amount: -999,
    to: f.groceries,
    from: doomed,
    at: '2026-07-20T10:00:00.000Z',
  });
  f.db.prepare('UPDATE transactions SET category_id = NULL WHERE id = ?').run(transactionId);
  f.db.prepare('DELETE FROM categories WHERE id = ?').run(doomed);

  const [row] = buildAiDigest(f.db).actions[0].rows;
  assert.equal(row.before_category_id, doomed, 'the id it displaced is still on the record');
  assert.equal(row.before_category_name, null, 'the name is gone, and the digest does not invent one');
});
