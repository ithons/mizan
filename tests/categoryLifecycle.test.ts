import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import type Database from 'better-sqlite3';
import { _setDbForTesting } from '../server/src/db/index';
import categoriesRouter from '../server/src/routes/categories';
import {
  confirmAdvisorDraft,
  dismissAdvisorDraft,
  undoAdvisorAction,
} from '../server/src/services/advisorDrafts';
import { upsertMerchantRule } from '../server/src/services/rules';
import { commitCsvImport } from '../server/src/services/csvImport';
import { createManualTransaction } from '../server/src/services/transactions';
import {
  getTransferCandidatePairs,
  refreshTransferCandidates,
} from '../server/src/services/transactionIntegrity';
import {
  TEST_NOW,
  insertAccount,
  insertCategory,
  insertTransaction,
  migratedTestDb,
} from './helpers/schema';
import type { AdvisorDraftAction, AdvisorDraftPayload } from '../shared/types';

/**
 * What deleting or merging a category takes with it.
 *
 * Both operations reach far past `categories`. Delete relied on `ON DELETE CASCADE` for the rules,
 * the budget and its rollover ledger, and on nothing at all for the revision logs, which carry no
 * foreign key: the ids simply stopped resolving, and `undoAdvisorAction` and the conservation
 * guard's auto-revert both stopped working for the affected rows with `{ success: true }` on the
 * wire. Merge moved the transactions and left the same logs behind. These tests are about what
 * survives.
 */

async function withCategoriesServer(
  db: Database.Database,
  fn: (baseUrl: string) => Promise<void>
): Promise<void> {
  _setDbForTesting(db);
  const app = express();
  app.use(express.json());
  app.use('/api/categories', categoriesRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no server address');
    await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function deleteCategory(
  db: Database.Database,
  id: string
): Promise<{ status: number; error?: string }> {
  let outcome: { status: number; error?: string } = { status: 0 };
  await withCategoriesServer(db, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/categories/${id}`, { method: 'DELETE' });
    const body = (await res.json()) as { error?: string };
    outcome = { status: res.status, error: body.error };
  });
  return outcome;
}

async function mergeCategory(
  db: Database.Database,
  id: string,
  targetId: string
): Promise<{ status: number; error?: string }> {
  let outcome: { status: number; error?: string } = { status: 0 };
  await withCategoriesServer(db, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/categories/${id}/merge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetId }),
    });
    const body = (await res.json()) as { error?: string };
    outcome = { status: res.status, error: body.error };
  });
  return outcome;
}

function draft(payload: AdvisorDraftPayload): AdvisorDraftAction {
  return {
    id: `draft_${payload.kind}`,
    kind: payload.kind,
    label: 'test draft',
    summary: 'the model refiled a row',
    route: '/transactions',
    payload,
    changes: [],
    citations: [],
    confirmation_required: true,
  } as AdvisorDraftAction;
}

/**
 * The reproduction from the report: a row a rule filed, refiled by a real autonomous action.
 *
 * The action's revision records `from_category_id` = the rule's category, which is the id an undo
 * writes back. Everything below is about whether that id still resolves afterwards.
 */
function refiledByAi(db: Database.Database): {
  ruleCategory: string;
  aiCategory: string;
  transactionId: string;
  actionId: string;
} {
  const accountId = insertAccount(db);
  const ruleCategory = insertCategory(db, { name: 'Streaming' });
  const aiCategory = insertCategory(db, { name: 'Subscriptions' });
  const transactionId = insertTransaction(db, {
    account_id: accountId,
    merchant_name: 'Spotify USA',
    category_id: ruleCategory,
    category_source: 'rule',
  });

  confirmAdvisorDraft(
    db,
    draft({ kind: 'categorize_transaction', transaction_id: transactionId, category_id: aiCategory }),
    true,
    'worker_auto'
  );
  const action = db.prepare('SELECT id FROM advisor_actions').get() as { id: string };
  return { ruleCategory, aiCategory, transactionId, actionId: action.id };
}

/** One open draft from the background worker, so a dismissal goes through the real write path. */
function insertOpenDraft(db: Database.Database, id: string, payload: AdvisorDraftPayload): string {
  db.prepare(`
    INSERT INTO advisor_drafts (id, kind, label, summary, route, payload, changes, citations,
                                status, created_at, updated_at)
    VALUES (?, ?, 'draft', 'the model proposed a category', '/transactions', ?, '[]', '[]', 'open', ?, ?)
  `).run(id, payload.kind, JSON.stringify(payload), TEST_NOW, TEST_NOW);
  return id;
}

function categoryOf(db: Database.Database, transactionId: string): string | null {
  return (
    db.prepare('SELECT category_id FROM transactions WHERE id = ?').get(transactionId) as {
      category_id: string | null;
    }
  ).category_id;
}

// ── Delete ───────────────────────────────────────────────────────────────────

test('a category the change history still names cannot be deleted out from under undo', async (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const { ruleCategory, transactionId, actionId } = refiledByAi(db);
  // Nothing is filed there any more, so every guard that existed before this one passes.
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE category_id = ?').get(ruleCategory) as { n: number }).n,
    0
  );

  const refusal = await deleteCategory(db, ruleCategory);
  assert.equal(refusal.status, 409);
  assert.match(refusal.error ?? '', /1 entry in the change history/);
  assert.match(refusal.error ?? '', /Merge it instead/);

  // The point of the refusal: the undo the panel offers still works.
  const undone = undoAdvisorAction(db, actionId);
  assert.equal(undone.ok, true);
  assert.equal(undone.reverted, 1);
  assert.equal(categoryOf(db, transactionId), ruleCategory, 'the row is back where the rule put it');
});

test('a category whose merchant rules would cascade away is refused, and they survive', async (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const categoryId = insertCategory(db, { name: 'Pets' });
  upsertMerchantRule(db, 'Trupanion', categoryId, TEST_NOW, { source: 'human' });
  upsertMerchantRule(db, 'Chewy.com', categoryId, TEST_NOW, { source: 'human' });

  const refusal = await deleteCategory(db, categoryId);
  assert.equal(refusal.status, 409);
  assert.match(refusal.error ?? '', /2 merchant rules pointing at it/);

  assert.equal(
    (db.prepare('SELECT COUNT(*) AS n FROM merchant_rules WHERE category_id = ?').get(categoryId) as { n: number }).n,
    2,
    'ON DELETE CASCADE used to take both of these with no mention anywhere'
  );
});

test('a category whose budget and rollover would cascade away is refused, and they survive', async (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const categoryId = insertCategory(db, { name: 'Groceries' });
  db.prepare(`
    INSERT INTO budgets (id, category_id, amount, period, rollover, rollover_balance, created_at, updated_at)
    VALUES ('bud_1', ?, 40000, 'monthly', 1, 0, ?, ?)
  `).run(categoryId, TEST_NOW, TEST_NOW);
  db.prepare(`
    INSERT INTO budget_rollover_ledger
      (id, budget_id, month, starting_rollover, budget_amount, actual_spend, ending_rollover, calculated_at)
    VALUES ('led_1', 'bud_1', '2026-06', 0, 40000, 32000, 8000, ?)
  `).run(TEST_NOW);

  const refusal = await deleteCategory(db, categoryId);
  assert.equal(refusal.status, 409);
  assert.match(refusal.error ?? '', /would delete the budget and 1 recorded month of rollover/);

  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM budgets').get() as { n: number }).n, 1);
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS n FROM budget_rollover_ledger').get() as { n: number }).n,
    1,
    'the rollover cascaded through the budget, two tables removed from the category'
  );
});

test('HEALTHY: a category nothing points at still deletes in one call', async (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  // The ordinary case, and the one every new guard here has to leave alone: a category the owner
  // created, never used, and wants gone.
  const categoryId = insertCategory(db, { name: 'Typo' });

  const result = await deleteCategory(db, categoryId);
  assert.equal(result.status, 200);
  assert.equal(db.prepare('SELECT 1 FROM categories WHERE id = ?').get(categoryId), undefined);
});

/**
 * The two references the delete path used to walk past, both of which the merge path repoints.
 *
 * Neither carries a foreign key, so a delete does not take them with it and does not clear them: it
 * leaves them naming an id that resolves to no row. `ai_feedback.proposed_category_id` is what
 * `ownerDeclinedProposal` matches on, and the merge's own comment says of it that "left pointing at
 * a deleted id it silently stops matching anything", which is a description of what the delete did.
 */
test('a category named only by a recorded AI decision cannot be deleted out from under it', async (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const accountId = insertAccount(db);
  const categoryId = insertCategory(db, { name: 'Coffee' });
  const transactionId = insertTransaction(db, { account_id: accountId, category_id: null });
  // The ordinary way one of these appears: the model proposed a category and the owner said no.
  dismissAdvisorDraft(db, insertOpenDraft(db, 'draft_declined', {
    kind: 'categorize_transaction',
    transaction_id: transactionId,
    category_id: categoryId,
  }));

  const refusal = await deleteCategory(db, categoryId);
  assert.equal(refusal.status, 409);
  assert.match(refusal.error ?? '', /1 recorded AI decision names it/);
  assert.match(refusal.error ?? '', /clear the declined suggestion in Settings/);

  assert.equal(
    (db.prepare('SELECT COUNT(*) AS n FROM ai_feedback WHERE proposed_category_id = ?')
      .get(categoryId) as { n: number }).n,
    1,
    'the record of the refusal is intact and still names a category that exists'
  );
});

/**
 * `transactions.category_previous_id` is not covered by the change-history blocker, despite every
 * current writer of it also appending a revision row.
 *
 * Measured on a copy of .mizan/mizan.db at migration 054, 2026-07-31: both of the two rows carrying
 * a `category_previous_id` have no revision naming it, so "the revisions blocker catches this too"
 * is a claim that ledger refutes.
 *   SELECT COUNT(*) FROM transactions t WHERE t.category_previous_id IS NOT NULL
 *     AND NOT EXISTS (SELECT 1 FROM transaction_category_revisions r
 *                      WHERE r.transaction_id = t.id AND r.from_category_id = t.category_previous_id);
 *   -> 2, of 2.
 */
test('a category a transaction still records as its previous one cannot be deleted', async (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const accountId = insertAccount(db);
  const previous = insertCategory(db, { name: 'Coffee' });
  const current = insertCategory(db, { name: 'Dining' });
  const transactionId = insertTransaction(db, { account_id: accountId, category_id: current });
  db.prepare('UPDATE transactions SET category_previous_id = ? WHERE id = ?').run(previous, transactionId);

  const refusal = await deleteCategory(db, previous);
  assert.equal(refusal.status, 409);
  assert.match(refusal.error ?? '', /1 transaction records it as the category it was moved out of/);
  assert.match(refusal.error ?? '', /Merge it instead/);
});

/**
 * HEALTHY, and the case both blockers above have to stay silent on: a category with an AI decision
 * and a previous-category pointer that name some OTHER category. Every count here is zero and the
 * delete goes through in one call.
 */
test('HEALTHY: AI decisions and previous-category pointers about other categories block nothing', async (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const accountId = insertAccount(db);
  const unused = insertCategory(db, { name: 'Typo' });
  const elsewhere = insertCategory(db, { name: 'Coffee' });
  const current = insertCategory(db, { name: 'Dining' });
  const transactionId = insertTransaction(db, { account_id: accountId, category_id: current });
  db.prepare('UPDATE transactions SET category_previous_id = ? WHERE id = ?').run(elsewhere, transactionId);
  dismissAdvisorDraft(db, insertOpenDraft(db, 'draft_elsewhere', {
    kind: 'categorize_transaction',
    transaction_id: transactionId,
    category_id: elsewhere,
  }));

  const result = await deleteCategory(db, unused);
  assert.equal(result.status, 200);
  assert.equal(db.prepare('SELECT 1 FROM categories WHERE id = ?').get(unused), undefined);
});

test('a delete blocked by several things names all of them, not one per attempt', async (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const accountId = insertAccount(db);
  const categoryId = insertCategory(db, { name: 'Pets' });
  insertTransaction(db, { account_id: accountId, category_id: categoryId });
  upsertMerchantRule(db, 'Trupanion', categoryId, TEST_NOW, { source: 'human' });

  const refusal = await deleteCategory(db, categoryId);
  assert.equal(refusal.status, 409);
  assert.match(refusal.error ?? '', /1 linked transactions/);
  assert.match(refusal.error ?? '', /1 merchant rule pointing at it/);
});

// ── Merge ────────────────────────────────────────────────────────────────────

test('merging moves the change history, so undo still lands somewhere that exists', async (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const { ruleCategory, aiCategory, transactionId, actionId } = refiledByAi(db);
  const survivor = insertCategory(db, { name: 'Media' });

  const merged = await mergeCategory(db, ruleCategory, survivor);
  assert.equal(merged.status, 200);
  assert.equal(db.prepare('SELECT 1 FROM categories WHERE id = ?').get(ruleCategory), undefined);

  const revision = db.prepare(
    'SELECT from_category_id, to_category_id FROM transaction_category_revisions WHERE action_id = ?'
  ).get(actionId) as { from_category_id: string; to_category_id: string };
  assert.equal(revision.from_category_id, survivor, 'the merge said the two are one thing');
  assert.equal(revision.to_category_id, aiCategory);

  // The whole point: before this, the undo wrote a dangling id into a column with a foreign key on
  // it, and the engine rejected the undo.
  const undone = undoAdvisorAction(db, actionId);
  assert.equal(undone.ok, true);
  assert.equal(categoryOf(db, transactionId), survivor);
});

test('merging carries the rule history and the dismissal record with it', async (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const source = insertCategory(db, { name: 'Streaming' });
  const survivor = insertCategory(db, { name: 'Subscriptions' });
  upsertMerchantRule(db, 'Spotify USA', source, TEST_NOW, { source: 'ai' });
  db.prepare(`
    INSERT INTO ai_feedback
      (id, signal, proposal_kind, proposed_category_id, owner_choice, owner_category_id,
       affected_transactions, created_at)
    VALUES ('fb_1', 'draft_dismissed', 'create_merchant_rule', ?, 'declined', NULL, 0, ?)
  `).run(source, TEST_NOW);

  assert.equal((await mergeCategory(db, source, survivor)).status, 200);

  const ruleRevision = db.prepare(
    'SELECT to_category_id FROM merchant_rule_revisions WHERE operation = ?'
  ).get('create') as { to_category_id: string };
  assert.equal(ruleRevision.to_category_id, survivor, "a rule's own history still resolves");

  const feedback = db.prepare('SELECT proposed_category_id FROM ai_feedback WHERE id = ?').get('fb_1') as {
    proposed_category_id: string;
  };
  assert.equal(
    feedback.proposed_category_id,
    survivor,
    'the write paths read this back, so a dangling id silently stops honouring the owner'
  );
});

test('HEALTHY: merging a category nothing else references still just moves the rows', async (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const accountId = insertAccount(db);
  const source = insertCategory(db, { name: 'Coffee' });
  const survivor = insertCategory(db, { name: 'Dining' });
  const transactionId = insertTransaction(db, { account_id: accountId, category_id: source });

  assert.equal((await mergeCategory(db, source, survivor)).status, 200);
  assert.equal(categoryOf(db, transactionId), survivor);
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS n FROM transaction_category_revisions').get() as { n: number }).n,
    0,
    'a merge writes no revision of its own, and none was invented here'
  );
});

// ── Who filed it ─────────────────────────────────────────────────────────────
//
// Migration 041: a NULL `category_source` means the author was never recorded. These two paths know
// the author, and both used to write NULL anyway, so the owner's own choice read as pre-provenance
// data: the AI's refile pool excludes NULL for exactly that reason, and every provenance surface
// showed the row as unattributed.

function provenanceOf(db: Database.Database, id: string): Record<string, unknown> {
  return db.prepare(
    'SELECT category_id, category_source, manually_categorized, review_status FROM transactions WHERE id = ?'
  ).get(id) as Record<string, unknown>;
}

test('a manual transaction filed by the owner records the owner as the author', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const accountId = insertAccount(db);
  const categoryId = insertCategory(db, { name: 'Coffee' });

  const created = createManualTransaction(db, {
    account_id: accountId,
    date: '2026-07-15',
    amount: -4.5,
    original_name: 'Blue Bottle',
    category_id: categoryId,
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  assert.deepEqual(provenanceOf(db, created.row.id as string), {
    category_id: categoryId,
    category_source: 'human',
    manually_categorized: 1,
    review_status: 'reviewed',
  });
});

test('a manual transaction with no category claims no author', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const accountId = insertAccount(db);
  const created = createManualTransaction(db, {
    account_id: accountId,
    date: '2026-07-15',
    amount: -4.5,
    original_name: 'Blue Bottle',
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  assert.deepEqual(provenanceOf(db, created.row.id as string), {
    category_id: null,
    category_source: null,
    manually_categorized: 0,
    review_status: 'open',
  });
});

/**
 * A mapped CSV column is one decision about a file, not a decision about each row in it.
 *
 * `category_source = 'human'` and `manually_categorized = 1` are read by four other queries as "the
 * owner adjudicated THIS ROW", and writing them here cost a detector: see the transfer test below.
 * Where an imported row came from is recorded by the columns that mean it, `source_type` and
 * `is_manual`, and `review_status` records the one thing about the owner's attention this path can
 * honestly claim: they previewed the file and confirmed it.
 */
test('a mapped CSV column is not recorded as the owner authoring each row', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  insertAccount(db, { account_name: 'Checking', is_manual: 1 });
  insertCategory(db, { name: 'Coffee' });

  const result = commitCsvImport(db, {
    rows: [
      { Date: '2026-07-15', Amount: '-4.50', Merchant: 'Blue Bottle', Category: 'Coffee' },
      { Date: '2026-07-16', Amount: '-9.00', Merchant: 'Corner Store', Category: '' },
    ],
    mapping: {
      date: 'Date',
      amount: 'Amount',
      merchant: 'Merchant',
      category: 'Category',
      dateFormat: 'yyyy-MM-dd',
      // The fixture's amounts are already signed the way the ledger stores them.
      amountNegate: false,
    },
  });
  assert.equal(result.imported, 2, result.errors.join('; '));

  const rows = db.prepare(`
    SELECT merchant_name, category_id IS NOT NULL AS filed, category_source, manually_categorized,
           review_status, source_type
    FROM transactions ORDER BY date
  `).all();

  assert.deepEqual(rows, [
    {
      merchant_name: 'Blue Bottle',
      filed: 1,
      category_source: null,
      manually_categorized: 0,
      review_status: 'reviewed',
      source_type: 'import',
    },
    {
      merchant_name: 'Corner Store',
      filed: 0,
      category_source: null,
      manually_categorized: 0,
      review_status: 'open',
      source_type: 'import',
    },
  ]);
});

/**
 * The reader that made the author markers the wrong thing to write on an import.
 *
 * `transferCandidateRows` (transactionIntegrity.ts) gates on `manually_categorized = 0 AND
 * category_source <> 'human'`, so an import that claimed the owner as author of every categorized
 * row took every one of those rows out of transfer pairing, silently. On a copy of .mizan/mizan.db
 * at migration 054, 2026-07-31, 4 of the 22 standing transfer pairs contain an imported leg
 * (`SELECT transfer_pair_id, group_concat(source_type) FROM transactions WHERE transfer_pair_id IS
 * NOT NULL GROUP BY 1`), so this is a live path and not a hypothetical one.
 */
test('two legs of one transfer imported from a CSV that carried categories still pair', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  insertAccount(db, { account_name: 'Checking', is_manual: 1 });
  insertAccount(db, { account_name: 'Savings', is_manual: 1 });
  insertCategory(db, { name: 'Coffee' });

  const result = commitCsvImport(db, {
    rows: [
      { Date: '2026-07-15', Amount: '-500.00', Merchant: 'ONLINE TRANSFER TO SAVINGS', Category: 'Coffee', Account: 'Checking' },
      { Date: '2026-07-15', Amount: '500.00', Merchant: 'ONLINE TRANSFER FROM CHECKING', Category: 'Coffee', Account: 'Savings' },
    ],
    mapping: {
      date: 'Date',
      amount: 'Amount',
      merchant: 'Merchant',
      category: 'Category',
      account: 'Account',
      dateFormat: 'yyyy-MM-dd',
      amountNegate: false,
    },
  });
  assert.equal(result.imported, 2, result.errors.join('; '));

  const detected = refreshTransferCandidates(db);
  assert.equal(detected.pairCount, 1, 'the imported transfer is found');
  assert.equal(getTransferCandidatePairs(db).length, 1);
});

/**
 * The healthy case for the same detector: nothing to pair, and it says nothing.
 *
 * Two imported rows that are not two sides of anything, in one account, with the same category.
 * A detector that only ever proved it fires is how this codebase shipped findings on clean data.
 */
test('imported rows that are not a transfer produce no pair', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  insertAccount(db, { account_name: 'Checking', is_manual: 1 });
  insertCategory(db, { name: 'Coffee' });

  const result = commitCsvImport(db, {
    rows: [
      { Date: '2026-07-15', Amount: '-4.50', Merchant: 'Blue Bottle', Category: 'Coffee' },
      { Date: '2026-07-16', Amount: '-9.00', Merchant: 'Corner Store', Category: 'Coffee' },
    ],
    mapping: {
      date: 'Date',
      amount: 'Amount',
      merchant: 'Merchant',
      category: 'Category',
      dateFormat: 'yyyy-MM-dd',
      // The fixture's amounts are already signed the way the ledger stores them.
      amountNegate: false,
    },
  });
  assert.equal(result.imported, 2, result.errors.join('; '));

  const detected = refreshTransferCandidates(db);
  assert.deepEqual(
    { pairs: detected.pairCount, rows: detected.transactionCount },
    { pairs: 0, rows: 0 }
  );
  assert.equal(getTransferCandidatePairs(db).length, 0);
});
