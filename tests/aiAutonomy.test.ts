import test from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import {
  confirmAdvisorDraft,
  undoAdvisorAction,
} from '../server/src/services/advisorDrafts';
import {
  AUTONOMOUS_DRAFT_KINDS,
  CARVE_OUT_WRITES_WITHOUT_A_DRAFT_KIND,
  DRAFT_KIND_AUTONOMY,
  OWNER_CARVE_OUT_KINDS,
  describeAutonomyForPrompt,
  isAutonomousDraftKind,
} from '../server/src/services/draftAutonomy';
import { AI_JOBS, runAiJob, type AiJobCollect, type AiJobProposal } from '../server/src/services/aiJobs';
import { buildAiDigest, revertAiDigestSince } from '../server/src/services/aiDigest';
import { listAiIncidents } from '../server/src/services/aiGuards';
import { autoCategorizeTransactions, recategorizeAll, upsertMerchantRule } from '../server/src/services/rules';
import { refilableTransactions } from '../server/src/services/aiWorker';
import { buildRecurringForecast } from '../server/src/services/recurringForecast';
import { refreshTransactionIntegrity } from '../server/src/services/transactionIntegrity';
import { writeTransactionCategories } from '../server/src/services/categoryWrites';
import { updateTransaction } from '../server/src/services/transactions';
import type { AdvisorDraftAction, AdvisorDraftActionKind, AdvisorDraftPayload } from '../shared/types';
import {
  TEST_NOW,
  insertAccount,
  insertTransaction,
  migratedTestDb,
} from './helpers/schema';

/**
 * The AI applies categorization, merchant rules and rule retirements with no human in the loop.
 * That is only safe if a bad batch is findable and reversible, which is what the provenance columns
 * are for (migrations 041, 042, 052). These tests pin the boundary, the undo path and the digest
 * together, because any one alone is worthless: autonomy without undo is unrecoverable, undo without
 * provenance cannot find the rows, and neither without the digest is something the owner ever sees.
 *
 * The schema is the real one (`migratedTestDb`). It has to be: the conservation guard reads through
 * reporting, the forecast and the snapshot tables, and a hand-written schema would let a divergence
 * between the test's tables and production's pass silently.
 */

const CREDENTIAL_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_PROFILE',
  'ANTHROPIC_CONFIG_DIR',
] as const;

/** `runAiJob` refuses to start without credentials, and never calls the model in these tests. */
function withCredentials(): () => void {
  const previous = new Map<string, string | undefined>();
  for (const key of CREDENTIAL_VARS) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env.ANTHROPIC_API_KEY = 'test-key-never-used';
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

interface Fixture {
  db: Database.Database;
  accountId: string;
}

function setup(): Fixture {
  const db = migratedTestDb();
  const accountId = insertAccount(db, { current_balance: 500_000, type: 'checking' });
  // cat_food, cat_food_coffee and cat_shop are seeded by the migrations, so nothing is inserted
  // here: creating them would collide on the primary key, and using the seeded taxonomy is what
  // makes the report-scope classification these tests run through the real one.
  for (const id of ['cat_food', 'cat_food_coffee', 'cat_shop']) {
    assert.ok(
      db.prepare('SELECT 1 FROM categories WHERE id = ?').get(id),
      `the migrated taxonomy no longer seeds ${id}`
    );
  }
  return { db, accountId };
}

function txn(
  fx: Fixture,
  overrides: Partial<{
    id: string;
    merchant_name: string;
    category_id: string | null;
    category_source: string | null;
    manually_categorized: number;
  }> = {}
): string {
  return insertTransaction(fx.db, {
    account_id: fx.accountId,
    date: '2026-07-10',
    amount: -1_200,
    merchant_name: overrides.merchant_name ?? 'Blue Bottle',
    original_name: overrides.merchant_name ?? 'Blue Bottle',
    id: overrides.id,
    category_id: overrides.category_id ?? null,
    category_source: overrides.category_source ?? null,
    manually_categorized: overrides.manually_categorized ?? 0,
  });
}

function draft(payload: AdvisorDraftPayload): AdvisorDraftAction {
  return {
    id: `draft_${payload.kind}_${Math.random().toString(36).slice(2, 8)}`,
    kind: payload.kind,
    label: `test ${payload.kind}`,
    summary: `test ${payload.kind}`,
    route: '/transactions',
    payload,
    changes: [],
    citations: [],
    confirmation_required: true,
  } as AdvisorDraftAction;
}

function proposal(payload: AdvisorDraftPayload): AiJobProposal {
  return {
    kind: payload.kind,
    label: `test ${payload.kind}`,
    summary: `test ${payload.kind}`,
    route: '/transactions',
    payload,
    changes: [],
    citations: [],
  };
}

function collecting(proposals: AiJobProposal[]): AiJobCollect {
  return async () => ({ status: 'collected', proposals, malformed: 0, usage: null });
}

function onlyAction(db: Database.Database): string {
  const rows = db.prepare('SELECT id FROM advisor_actions').all() as Array<{ id: string }>;
  assert.equal(rows.length, 1, 'expected exactly one advisor action');
  return rows[0].id;
}

// ─── The declaration itself ──────────────────────────────────────────────────

test('every draft kind declares its own autonomy, and the set is derived from that', () => {
  // The compiler already refuses a kind with no declaration: DRAFT_KIND_AUTONOMY is a Record over
  // the whole union. This is the other half, which types cannot say: the derived set must be
  // exactly the kinds that declared themselves autonomous, so nothing can be autonomous by
  // omission and nothing autonomous can be missing an argument.
  const declared = Object.entries(DRAFT_KIND_AUTONOMY);
  const autonomous = declared.filter(([, d]) => d.autonomy === 'autonomous').map(([k]) => k);
  assert.deepEqual([...AUTONOMOUS_DRAFT_KINDS].sort(), autonomous.sort());

  for (const [kind, decision] of declared) {
    assert.ok(decision.argument.trim().length > 0, `${kind} declares no argument`);
    if (decision.autonomy === 'proposal_only') {
      assert.ok(
        decision.fails.length > 0,
        `${kind} is proposal-only and names no criterion it fails, which is a decision with nothing behind it`
      );
    }
  }
});

test("the owner's carve-out is fixed proposal-only and is not a judgement call", () => {
  for (const kind of ['update_budget', 'update_goal_target', 'set_manual_cost_basis'] as const) {
    assert.equal(isAutonomousDraftKind(kind), false, `${kind} must always require confirmation`);
    assert.ok(OWNER_CARVE_OUT_KINDS.has(kind), `${kind} must be marked as the owner's carve-out`);
    const decision = DRAFT_KIND_AUTONOMY[kind];
    assert.equal(decision.autonomy, 'proposal_only');
    assert.ok(
      decision.autonomy === 'proposal_only' && decision.fails.includes('not_owner_number'),
      `${kind} must fail on the principle the carve-out rests on: the AI never overwrites a number the owner set`
    );
  }

  // The carve-out also names category merge, delete and re-parent, which are not draft kinds. If
  // one ever becomes one, the Record forces it to declare, and it must not declare autonomous.
  for (const write of CARVE_OUT_WRITES_WITHOUT_A_DRAFT_KIND) {
    const declared = DRAFT_KIND_AUTONOMY[write as unknown as AdvisorDraftActionKind];
    if (declared !== undefined) {
      assert.equal(declared.autonomy, 'proposal_only', `${write} is in the owner's carve-out`);
    }
  }
});

test('the prompt sentence, the schema and the enforced set are one list', () => {
  const kinds = AI_JOBS.background_review.writes;
  const sentence = describeAutonomyForPrompt(kinds);

  for (const kind of kinds) {
    assert.ok(sentence.includes(`'${kind}'`), `${kind} is a kind this job may emit and the prompt never names it`);
  }
  // Told-it-applies must equal may-apply, in both directions. A model told a kind applies when it
  // queues phrases a suggestion as a done thing; told a kind queues when it applies, it hedges.
  const applyClause = sentence.split('APPLIED IMMEDIATELY')[0];
  for (const kind of kinds) {
    assert.equal(
      applyClause.includes(`'${kind}'`),
      isAutonomousDraftKind(kind),
      `the prompt and the enforced set disagree about ${kind}`
    );
  }
});

// ─── Categorization: provenance, undo, and the widened premise ───────────────

test('an AI categorization stamps provenance and the action id on the row', () => {
  const fx = setup();
  const id = txn(fx, { merchant_name: 'Blue Bottle' });

  const res = confirmAdvisorDraft(
    fx.db,
    draft({ kind: 'categorize_transaction', transaction_id: id, category_id: 'cat_food_coffee' }),
    true,
    'worker_auto'
  );
  assert.equal(res.changed, 1);

  const row = fx.db.prepare('SELECT * FROM transactions WHERE id = ?').get(id) as Record<string, unknown>;
  assert.equal(row.category_id, 'cat_food_coffee');
  assert.equal(row.category_source, 'ai');
  assert.equal(row.category_previous_id, null, 'it was uncategorized before');
  assert.equal(row.category_action_id, onlyAction(fx.db), 'the row points at the action that set it');
  fx.db.close();
});

test('the model may refile a row a rule filed, and undo puts the rule back', () => {
  const fx = setup();
  const id = txn(fx, { merchant_name: 'Blue Bottle', category_id: 'cat_shop', category_source: 'rule' });

  confirmAdvisorDraft(
    fx.db,
    draft({ kind: 'categorize_transaction', transaction_id: id, category_id: 'cat_food_coffee' }),
    true,
    'worker_auto'
  );

  const after = fx.db.prepare('SELECT category_id, category_source FROM transactions WHERE id = ?')
    .get(id) as { category_id: string; category_source: string };
  assert.equal(after.category_id, 'cat_food_coffee');
  assert.equal(after.category_source, 'ai');

  undoAdvisorAction(fx.db, onlyAction(fx.db));

  // Both halves. Restoring the category and losing the source hands a rule-authored choice back
  // relabelled, which is what the pre-042 undo did.
  const restored = fx.db.prepare('SELECT category_id, category_source FROM transactions WHERE id = ?')
    .get(id) as { category_id: string; category_source: string };
  assert.equal(restored.category_id, 'cat_shop');
  assert.equal(restored.category_source, 'rule');
  fx.db.close();
});

test('an AI categorization no longer mints a merchant rule as a side effect', () => {
  const fx = setup();
  const id = txn(fx, { merchant_name: 'PURCHASE AUTHORIZED ON 07/10 SQ *SOME CAFE 4471' });

  confirmAdvisorDraft(
    fx.db,
    draft({ kind: 'categorize_transaction', transaction_id: id, category_id: 'cat_food_coffee' }),
    true,
    'worker_auto'
  );

  const rules = fx.db.prepare('SELECT COUNT(*) AS n FROM merchant_rules').get() as { n: number };
  assert.equal(rules.n, 0);
  fx.db.close();
});

test('undo reverts every row a rule application swept in, not just the one proposed', () => {
  const fx = setup();
  txn(fx, { id: 't1', merchant_name: 'Blue Bottle Coffee' });
  txn(fx, { id: 't2', merchant_name: 'Blue Bottle Coffee' });
  txn(fx, { id: 't3', merchant_name: 'Blue Bottle Coffee' });
  txn(fx, { id: 'other', merchant_name: 'Shell Gas' });

  confirmAdvisorDraft(
    fx.db,
    draft({ kind: 'create_merchant_rule', pattern: 'Blue Bottle Coffee', category_id: 'cat_food_coffee', apply_existing: true }),
    true,
    'worker_auto'
  );

  const categorized = fx.db.prepare(
    "SELECT COUNT(*) AS n FROM transactions WHERE category_id = 'cat_food_coffee'"
  ).get() as { n: number };
  assert.equal(categorized.n, 3, 'the rule swept in all three matching rows');

  const undone = undoAdvisorAction(fx.db, onlyAction(fx.db));
  assert.equal(undone.ok, true);
  assert.equal(undone.reverted, 3, 'undo covers the whole blast radius, not one row');

  const after = fx.db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE category_id IS NOT NULL')
    .get() as { n: number };
  assert.equal(after.n, 0);

  // The rule itself survives: deleting it would be a second unasked change, and it is visible and
  // removable in Settings.
  const rules = fx.db.prepare('SELECT COUNT(*) AS n FROM merchant_rules').get() as { n: number };
  assert.equal(rules.n, 1);
  fx.db.close();
});

test('undo does not reach back through a hand edit made after the fact', () => {
  const fx = setup();
  const id = txn(fx, { merchant_name: 'Blue Bottle' });

  confirmAdvisorDraft(
    fx.db,
    draft({ kind: 'categorize_transaction', transaction_id: id, category_id: 'cat_food_coffee' }),
    true,
    'worker_auto'
  );
  assert.equal(updateTransaction(fx.db, id, { category_id: 'cat_shop' }).ok, true);

  const undone = undoAdvisorAction(fx.db, onlyAction(fx.db));
  assert.equal(undone.ok, false);
  assert.equal(undone.reason, 'nothing_to_undo');

  const row = fx.db.prepare('SELECT category_id, category_source FROM transactions WHERE id = ?').get(id) as {
    category_id: string; category_source: string;
  };
  assert.equal(row.category_id, 'cat_shop', 'the human decision stands');
  assert.equal(row.category_source, 'human');
  fx.db.close();
});

test('undoing an unknown action is a 404, not a silent no-op', () => {
  const fx = setup();
  const res = undoAdvisorAction(fx.db, 'nope');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'not_found');
  fx.db.close();
});

// ─── The refile pool: one answer per row, and the owner's reset stands ───────

test("the model's refile does not survive Re-check all transactions, and is not re-proposed", () => {
  const fx = setup();
  // The owner's own rule files Blue Bottle as Shopping. The model disagrees and refiles it.
  upsertMerchantRule(fx.db, 'Blue Bottle', 'cat_shop', TEST_NOW, { source: 'human' });
  const id = txn(fx, { merchant_name: 'Blue Bottle', category_id: 'cat_shop', category_source: 'rule' });

  assert.deepEqual(
    refilableTransactions(fx.db).map((r) => r.id),
    [id],
    'a machine-filed row the model has never touched is in the pool'
  );

  confirmAdvisorDraft(
    fx.db,
    draft({ kind: 'categorize_transaction', transaction_id: id, category_id: 'cat_food_coffee' }),
    true,
    'worker_auto'
  );
  assert.deepEqual(refilableTransactions(fx.db).map((r) => r.id), [], 'its own answer is not re-proposed');

  // The owner presses "Re-check all transactions". It skips hand-categorized rows only, so it
  // overwrites the model's answer with the rule's category and stamps it 'rule' again.
  recategorizeAll(fx.db);
  const after = fx.db.prepare('SELECT category_id, category_source FROM transactions WHERE id = ?')
    .get(id) as { category_id: string; category_source: string };
  assert.equal(after.category_id, 'cat_shop', 'the owner\'s re-check wins the row back');
  assert.equal(after.category_source, 'rule', 'and it is labelled as the rule\'s, which is what makes this a loop');

  // THE DECISION. Pressing re-check is the owner deliberately handing the whole ledger back to
  // their own rules, so the model's answer does not survive it and does not come back an hour
  // later either. Reading category_source alone would have returned this row to the pool, and the
  // next hourly pass would have reversed an action the owner had just taken, unattended.
  assert.deepEqual(
    refilableTransactions(fx.db).map((r) => r.id),
    [],
    'a row the model has already answered never re-enters the refile pool'
  );
  fx.db.close();
});

test('undoing the model\'s refile does not hand the row back for the next pass to refile', () => {
  const fx = setup();
  const id = txn(fx, { merchant_name: 'Blue Bottle', category_id: 'cat_shop', category_source: 'rule' });
  confirmAdvisorDraft(
    fx.db,
    draft({ kind: 'categorize_transaction', transaction_id: id, category_id: 'cat_food_coffee' }),
    true,
    'worker_auto'
  );

  assert.equal(undoAdvisorAction(fx.db, onlyAction(fx.db)).ok, true);
  const restored = fx.db.prepare('SELECT category_id, category_source FROM transactions WHERE id = ?')
    .get(id) as { category_id: string; category_source: string };
  assert.equal(restored.category_source, 'rule', 'undo restores the prior source, not just the category');

  // Same shape as the re-check: the row wears a machine label again. An owner rejecting the
  // model's answer and getting it re-applied within the hour is the worst reading of "autonomous".
  assert.deepEqual(refilableTransactions(fx.db).map((r) => r.id), []);
  fx.db.close();
});

test('HEALTHY: the exclusion is about this model, not about every machine write', () => {
  const fx = setup();
  const ruleFiled = txn(fx, { id: 'r1', merchant_name: 'Rei Coop', category_id: 'cat_shop', category_source: 'rule' });
  const heuristicFiled = txn(fx, { id: 'h1', merchant_name: 'Sightglass', category_id: 'cat_shop', category_source: 'heuristic' });
  txn(fx, { id: 'n1', merchant_name: 'Unknown Co', category_id: 'cat_shop', category_source: null });
  txn(fx, { id: 'm1', merchant_name: 'Chosen Co', category_id: 'cat_shop', category_source: 'human', manually_categorized: 1 });

  assert.deepEqual(
    refilableTransactions(fx.db).map((r) => r.id).sort(),
    [heuristicFiled, ruleFiled].sort(),
    'excluding the model\'s own history must not narrow the pool to nothing'
  );
  fx.db.close();
});

// ─── Rule retirement ─────────────────────────────────────────────────────────

function aiRule(fx: Fixture, pattern: string, categoryId: string): string {
  const result = upsertMerchantRule(fx.db, pattern, categoryId, TEST_NOW, { source: 'ai' });
  assert.equal(result.status, 'created');
  assert.ok(result.ruleId);
  return result.ruleId as string;
}

test('the model may retire its own inert rule, and undo brings it back', () => {
  const fx = setup();
  // The live shape this exists for: the owner's rule outranks the model's everywhere, so the
  // model's rule sits live and files nothing.
  upsertMerchantRule(fx.db, 'BLUE BOTTLE COFFEE CO', 'cat_food_coffee', TEST_NOW, { source: 'human' });
  const ruleId = aiRule(fx, 'Blue Bottle', 'cat_shop');
  txn(fx, { merchant_name: 'BLUE BOTTLE COFFEE CO', category_id: 'cat_food_coffee', category_source: 'rule' });

  const res = confirmAdvisorDraft(
    fx.db,
    draft({ kind: 'retire_merchant_rule', rule_id: ruleId }),
    true,
    'worker_auto'
  );
  assert.equal(res.changed, 1);

  const retired = fx.db.prepare('SELECT retired_at FROM merchant_rules WHERE id = ?').get(ruleId) as
    { retired_at: string | null };
  assert.ok(retired.retired_at, 'the rule is retired, not deleted');

  const revision = fx.db.prepare(
    "SELECT operation, action_id FROM merchant_rule_revisions WHERE rule_id = ? AND operation = 'retire'"
  ).get(ruleId) as { operation: string; action_id: string };
  assert.equal(revision.action_id, onlyAction(fx.db), 'the retirement carries the action id undo reads');

  const undone = undoAdvisorAction(fx.db, onlyAction(fx.db));
  assert.equal(undone.ok, true);
  assert.equal(undone.reverted, 0, 'a retirement changes no transaction row');
  assert.equal(undone.reverted_rules, 1);

  const back = fx.db.prepare('SELECT retired_at FROM merchant_rules WHERE id = ?').get(ruleId) as
    { retired_at: string | null };
  assert.equal(back.retired_at, null);
  const unretire = fx.db.prepare(
    "SELECT COUNT(*) AS n FROM merchant_rule_revisions WHERE rule_id = ? AND operation = 'unretire'"
  ).get(ruleId) as { n: number };
  assert.equal(unretire.n, 1, 'the restore is recorded as itself, not as a second creation');
  fx.db.close();
});

test('the model may not retire a rule the owner wrote', () => {
  const fx = setup();
  const result = upsertMerchantRule(fx.db, 'Blue Bottle', 'cat_food_coffee', TEST_NOW, { source: 'human' });

  assert.throws(
    () => confirmAdvisorDraft(fx.db, draft({ kind: 'retire_merchant_rule', rule_id: result.ruleId as string }), true, 'worker_auto'),
    /your own rule/
  );

  const rule = fx.db.prepare('SELECT retired_at FROM merchant_rules WHERE id = ?').get(result.ruleId) as
    { retired_at: string | null };
  assert.equal(rule.retired_at, null);
  assert.equal((fx.db.prepare('SELECT COUNT(*) AS n FROM advisor_actions').get() as { n: number }).n, 0);
  fx.db.close();
});

test('the model may not retire a rule that currently files transactions', () => {
  const fx = setup();
  const ruleId = aiRule(fx, 'Blue Bottle', 'cat_food_coffee');
  txn(fx, { merchant_name: 'Blue Bottle', category_id: 'cat_food_coffee', category_source: 'rule' });

  // The radius of this retirement lands LATER, on the next whole-ledger re-check, outside anything
  // one undo can reach. That is a deferred radius, not a bounded one.
  assert.throws(
    () => confirmAdvisorDraft(fx.db, draft({ kind: 'retire_merchant_rule', rule_id: ruleId }), true, 'worker_auto'),
    /currently files 1 transaction/
  );

  const rule = fx.db.prepare('SELECT retired_at FROM merchant_rules WHERE id = ?').get(ruleId) as
    { retired_at: string | null };
  assert.equal(rule.retired_at, null);
  fx.db.close();
});

// ─── A human-authored row is untouched, kind by kind ─────────────────────────

test('a hand-categorized row survives every autonomous kind, individually', () => {
  for (const kind of AUTONOMOUS_DRAFT_KINDS) {
    const fx = setup();
    const id = txn(fx, {
      merchant_name: 'Blue Bottle Coffee',
      category_id: 'cat_shop',
      category_source: 'human',
      manually_categorized: 1,
    });

    let payload: AdvisorDraftPayload;
    if (kind === 'categorize_transaction') {
      payload = { kind, transaction_id: id, category_id: 'cat_food_coffee' };
    } else if (kind === 'create_merchant_rule') {
      payload = { kind, pattern: 'Blue Bottle Coffee', category_id: 'cat_food_coffee', apply_existing: true };
    } else if (kind === 'retire_merchant_rule') {
      // The rule the retirement would take back is the only thing standing between this row and a
      // re-check that refiles it. The row must be untouched either way.
      payload = { kind, rule_id: aiRule(fx, 'Blue Bottle Coffee', 'cat_food_coffee') };
    } else {
      throw new Error(`No human-row case written for the autonomous kind '${kind}'.`);
    }

    try {
      confirmAdvisorDraft(fx.db, draft(payload), true, 'worker_auto');
    } catch {
      // A refusal is one of the two acceptable outcomes. The row is what is being asserted.
    }

    const row = fx.db.prepare(
      'SELECT category_id, category_source, manually_categorized FROM transactions WHERE id = ?'
    ).get(id) as { category_id: string; category_source: string; manually_categorized: number };
    assert.equal(row.category_id, 'cat_shop', `${kind} moved a hand-categorized row`);
    assert.equal(row.category_source, 'human', `${kind} relabelled a hand-made choice`);
    assert.equal(row.manually_categorized, 1);

    const revisions = fx.db.prepare(
      "SELECT COUNT(*) AS n FROM transaction_category_revisions WHERE transaction_id = ? AND from_source = 'human'"
    ).get(id) as { n: number };
    assert.equal(revisions.n, 0, `${kind} wrote over a human category`);
    fx.db.close();
  }
});

// ─── A whole guarded pass ────────────────────────────────────────────────────

test('a healthy pass exercising every autonomous kind applies, breaches nothing, and reverts whole', async () => {
  const restoreEnv = withCredentials();
  const fx = setup();
  try {
    const inert = aiRule(fx, 'Blue Bottle', 'cat_shop');
    upsertMerchantRule(fx.db, 'BLUE BOTTLE COFFEE CO', 'cat_food_coffee', TEST_NOW, { source: 'human' });

    const uncategorized = txn(fx, { id: 'p_new', merchant_name: 'Trupanion' });
    const filedByRule = txn(fx, {
      id: 'p_rule',
      merchant_name: 'Rei Coop',
      category_id: 'cat_shop',
      category_source: 'rule',
    });
    txn(fx, { id: 'p_sweep1', merchant_name: 'Sightglass Coffee' });
    txn(fx, { id: 'p_sweep2', merchant_name: 'Sightglass Coffee' });

    const outcome = await runAiJob(
      AI_JOBS.background_review,
      collecting([
        proposal({ kind: 'categorize_transaction', transaction_id: uncategorized, category_id: 'cat_food_coffee' }),
        proposal({ kind: 'categorize_transaction', transaction_id: filedByRule, category_id: 'cat_food' }),
        proposal({ kind: 'create_merchant_rule', pattern: 'Sightglass Coffee', category_id: 'cat_food_coffee', apply_existing: true }),
        proposal({ kind: 'retire_merchant_rule', rule_id: inert }),
      ]),
      { db: fx.db, trigger: 'after_sync' }
    );

    assert.equal(outcome.status, 'completed');
    if (outcome.status !== 'completed') return;
    assert.equal(outcome.applied, 4, 'every proposal is an autonomous kind and every one landed');
    assert.equal(outcome.queued, 0);
    assert.deepEqual(outcome.breaches, [], 'a healthy pass breaches nothing');

    // The whole point of the harness is that the healthy case is SILENT. A guard that only proves
    // it detects a defect is the guard this codebase has shipped and deleted twice.
    assert.equal(listAiIncidents(fx.db).length, 0, 'no incident row on a healthy pass');
    const run = fx.db.prepare('SELECT invariant_breach FROM ai_runs').get() as { invariant_breach: string | null };
    assert.equal(run.invariant_breach, null);

    // ── The digest: row-level before and after, not a count.
    const digest = buildAiDigest(fx.db);
    assert.equal(digest.action_count, 4);
    const categorization = digest.actions.find((a) => a.rows.some((r) => r.transaction_id === filedByRule));
    assert.ok(categorization, 'the refiled row is in the digest');
    const refiled = categorization.rows.find((r) => r.transaction_id === filedByRule);
    assert.equal(refiled?.before_category_id, 'cat_shop');
    assert.equal(refiled?.after_category_id, 'cat_food');
    assert.equal(refiled?.revertable, true);

    const retirement = digest.actions.find((a) => a.kind === 'retire_merchant_rule');
    assert.ok(retirement, 'the retirement is in the digest');
    assert.equal(retirement.rows.length, 0, 'it changed no transaction, by design');
    assert.equal(retirement.revertable_rules, 1);
    assert.equal(retirement.revert_scope, 'full', 'changing no row is not the same as nothing to put back');
    assert.equal(retirement.rule?.pattern, 'Blue Bottle');

    assert.equal(digest.revertable_rows, 4, 'two categorizations plus two rows the rule swept in');
    assert.equal(digest.revertable_rules, 1);

    // ── Revert since the beginning of time, in one gesture.
    const reverted = revertAiDigestSince(fx.db, '2000-01-01T00:00:00.000Z');
    assert.equal(reverted.ok, true);
    if (!reverted.ok) return;
    assert.equal(reverted.result.reverted_rows, 4);
    assert.equal(reverted.result.reverted_rules, 1);
    assert.deepEqual(reverted.result.discrepancies, []);

    const standing = fx.db.prepare(
      "SELECT COUNT(*) AS n FROM transactions WHERE category_source = 'ai'"
    ).get() as { n: number };
    assert.equal(standing.n, 0, 'nothing the pass wrote is still standing');
    assert.equal(
      (fx.db.prepare('SELECT category_id FROM transactions WHERE id = ?').get(filedByRule) as { category_id: string }).category_id,
      'cat_shop',
      'the rule-filed row is back where the rule put it'
    );
    assert.equal(
      (fx.db.prepare('SELECT retired_at FROM merchant_rules WHERE id = ?').get(inert) as { retired_at: string | null }).retired_at,
      null,
      'the retired rule is live again'
    );
  } finally {
    fx.db.close();
    restoreEnv();
  }
});

test('a pass whose categorization pairs a transfer moves the month and still breaches nothing', async () => {
  const restoreEnv = withCredentials();
  const fx = setup();
  try {
    const savings = insertAccount(fx.db, { current_balance: 100_000, type: 'savings' });

    // `confirmCategorizeTransaction` re-runs `refreshTransactionIntegrity`, so an ordinary
    // categorization can pair a transfer as a side effect. That legitimately moves the month's
    // income: `excludedFromTotalsSql` drops a transfer candidate from every total. This is the
    // healthy case the whole harness has to stay silent on, and it is the one worth proving,
    // because it is the shape that got two earlier detectors in this repo deleted.
    insertTransaction(fx.db, {
      id: 'leg_out', account_id: fx.accountId, date: '2026-07-12', amount: -50_000,
      merchant_name: 'AUTOPAY 1234', original_name: 'AUTOMATIC PAYMENT 1234',
      category_id: 'cat_xfer_cc', category_source: 'heuristic',
    });
    insertTransaction(fx.db, {
      id: 'leg_in', account_id: savings, date: '2026-07-13', amount: 50_000,
      merchant_name: 'Transfer from checking', original_name: 'ONLINE TRANSFER FROM CHK',
    });
    const unrelated = txn(fx, { id: 'p_cafe', merchant_name: 'Trupanion' });

    const outcome = await runAiJob(
      AI_JOBS.background_review,
      collecting([
        proposal({ kind: 'categorize_transaction', transaction_id: unrelated, category_id: 'cat_food_coffee' }),
      ]),
      { db: fx.db, trigger: 'after_sync' }
    );

    assert.equal(outcome.status, 'completed');
    if (outcome.status !== 'completed') return;
    assert.equal(outcome.applied, 1);
    assert.deepEqual(outcome.breaches, [], 'a pass that legitimately moved the month must be silent');
    assert.equal(listAiIncidents(fx.db).length, 0);

    // The pairing really did happen, so the silence above is silence about a real movement rather
    // than about nothing.
    const paired = fx.db.prepare(
      "SELECT COUNT(*) AS n FROM transactions WHERE transfer_status = 'candidate'"
    ).get() as { n: number };
    assert.equal(paired.n, 2, 'the two legs were paired by the categorization pass');

    const draftStatus = fx.db.prepare('SELECT status FROM advisor_drafts').get() as { status: string };
    assert.equal(draftStatus.status, 'confirmed', 'nothing was requeued');
  } finally {
    fx.db.close();
    restoreEnv();
  }
});

test('a pass that un-pairs a transfer the owner touched is silent, and keeps its own work', async () => {
  const restoreEnv = withCredentials();
  const fx = setup();
  try {
    const savings = insertAccount(fx.db, { current_balance: 100_000, type: 'savings' });
    insertTransaction(fx.db, {
      id: 'leg_out', account_id: fx.accountId, date: '2026-07-12', amount: -50_000,
      merchant_name: 'AUTOPAY 1234', original_name: 'AUTOMATIC PAYMENT 1234',
      category_id: 'cat_xfer_cc', category_source: 'heuristic',
    });
    insertTransaction(fx.db, {
      id: 'leg_in', account_id: savings, date: '2026-07-13', amount: 50_000,
      merchant_name: 'Transfer from checking', original_name: 'ONLINE TRANSFER FROM CHK',
    });
    refreshTransactionIntegrity(fx.db);
    assert.equal(
      (fx.db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE transfer_status = 'candidate'").get() as { n: number }).n,
      2,
      'the pair exists before the owner touches it'
    );

    // Two ordinary owner actions, both of which the app supports today: hand-categorize one leg,
    // and let a rule file the other somewhere real. The pair is no longer eligible, so the NEXT
    // categorization pass breaks it as a side effect of `refreshTransactionIntegrity` and $500
    // re-enters the month with no row the pass refiled.
    assert.equal(updateTransaction(fx.db, 'leg_out', { category_id: 'cat_shop' }).ok, true);
    writeTransactionCategories(fx.db, [
      { transactionId: 'leg_in', categoryId: 'cat_food_coffee', source: 'rule' },
    ]);

    const unrelated = txn(fx, { id: 'p_cafe', merchant_name: 'Trupanion' });
    const outcome = await runAiJob(
      AI_JOBS.background_review,
      collecting([
        proposal({ kind: 'categorize_transaction', transaction_id: unrelated, category_id: 'cat_food_coffee' }),
      ]),
      { db: fx.db, trigger: 'after_sync' }
    );

    assert.equal(outcome.status, 'completed');
    if (outcome.status !== 'completed') return;
    assert.deepEqual(outcome.breaches, [], 'an owner action upstream must not auto-revert the AI pass');
    assert.equal(listAiIncidents(fx.db).length, 0);
    assert.equal(outcome.applied, 1);

    // The pass keeps its own work. Reverting it here would have thrown away a correct
    // categorization for something the owner did before the pass started.
    const row = fx.db.prepare('SELECT category_id, category_source FROM transactions WHERE id = ?')
      .get(unrelated) as { category_id: string | null; category_source: string | null };
    assert.equal(row.category_id, 'cat_food_coffee');
    assert.equal(row.category_source, 'ai');
    assert.equal(
      (fx.db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE transfer_status = 'candidate'").get() as { n: number }).n,
      0,
      'the pair really did break, so the silence is about a real movement'
    );
  } finally {
    fx.db.close();
    restoreEnv();
  }
});

test("a pass that proposes a carve-out kind queues it and does not apply it", async () => {
  const restoreEnv = withCredentials();
  const fx = setup();
  try {
    const id = txn(fx, { merchant_name: 'Trupanion' });
    fx.db.prepare(
      `INSERT INTO goals (id, name, type, target_amount, current_amount, created_at, updated_at)
       VALUES ('goal_1', 'Emergency fund', 'savings', 500000, 0, ?, ?)`
    ).run(TEST_NOW, TEST_NOW);

    const outcome = await runAiJob(
      AI_JOBS.background_review,
      collecting([
        proposal({ kind: 'categorize_transaction', transaction_id: id, category_id: 'cat_food_coffee' }),
        proposal({ kind: 'update_budget', category_id: 'cat_food', amount: 500, period: 'monthly', rollover: false }),
        proposal({ kind: 'update_goal_target', goal_id: 'goal_1', target_amount: 10_000 }),
      ]),
      { db: fx.db, trigger: 'after_sync' }
    );

    assert.equal(outcome.status, 'completed');
    if (outcome.status !== 'completed') return;
    assert.equal(outcome.applied, 1, 'only the categorization landed');
    assert.equal(outcome.queued, 2);
    assert.deepEqual(outcome.breaches, []);

    const drafts = fx.db.prepare('SELECT kind, status FROM advisor_drafts ORDER BY kind')
      .all() as Array<{ kind: string; status: string }>;
    assert.deepEqual(drafts, [
      { kind: 'categorize_transaction', status: 'confirmed' },
      { kind: 'update_budget', status: 'open' },
      { kind: 'update_goal_target', status: 'open' },
    ]);

    // Nothing was written to either target, and no action claims otherwise.
    assert.equal((fx.db.prepare('SELECT COUNT(*) AS n FROM budgets').get() as { n: number }).n, 0);
    assert.equal(
      (fx.db.prepare('SELECT target_amount FROM goals WHERE id = ?').get('goal_1') as { target_amount: number }).target_amount,
      500_000,
      'the goal target is still the owner\'s, in cents'
    );
    const kinds = fx.db.prepare('SELECT kind FROM advisor_actions').all() as Array<{ kind: string }>;
    assert.deepEqual(kinds, [{ kind: 'categorize_transaction' }]);
  } finally {
    fx.db.close();
    restoreEnv();
  }
});


// ─── The arguments say only what was checked ─────────────────────────────────

test('confirming a recurring pattern moves the confidence bucket and no total the guard reads', () => {
  // Every half of the confirm_recurring argument, because the claim used to be "confirming moves no
  // forecast total" and buildRecurringForecast returns six bucketed totals as well as three
  // headline ones. Confirming moves a bucket; it does not move net, income or bills.
  const fx = setup();
  const soon = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
  fx.db.prepare(
    `INSERT INTO recurring_patterns
       (id, merchant_name, category_id, average_amount, frequency, last_seen, next_expected,
        is_active, is_confirmed, transaction_count, created_at, updated_at)
     VALUES ('rec_1', 'Backblaze', 'cat_shop', 900, 'monthly', '2026-07-01', ?, 1, 0, 4, ?, ?)`
  ).run(soon, TEST_NOW, TEST_NOW);

  const before = buildRecurringForecast(fx.db, 60);
  fx.db.prepare("UPDATE recurring_patterns SET is_confirmed = 1 WHERE id = 'rec_1'").run();
  const after = buildRecurringForecast(fx.db, 60);

  assert.ok(before.occurrences.length > 0, 'four occurrences puts the pattern in the forecast unconfirmed');
  assert.ok(before.bills > 0, 'and it is a bill, so the totals below are about something');

  // What the guard reads.
  assert.equal(after.net, before.net);
  assert.equal(after.bills, before.bills);
  assert.equal(after.income, before.income);

  // What moves, and is not claimed to be invariant.
  assert.equal(before.confirmed_bills, 0);
  assert.equal(before.likely_bills, before.bills);
  assert.equal(after.confirmed_bills, before.bills, 'the same money, counted in a different bucket');
  assert.equal(after.likely_bills, 0);

  // And what does not move, for the narrow reason the argument gives rather than by luck.
  assert.equal(after.review_count, before.review_count);
  assert.equal(before.uncertain_bills, 0, "an unconfirmed pattern in the forecast is 'likely', never 'uncertain'");
  assert.equal(after.uncertain_bills, 0);

  assert.equal(DRAFT_KIND_AUTONOMY.confirm_recurring.autonomy, 'proposal_only', 'nothing acts on any of it');
  fx.db.close();
});

/**
 * The undo has to survive the next sync.
 *
 * `undoAdvisorAction` reverted the transactions and left the rule the action created live, on the
 * argument that deleting it would be a second unasked change. But `revertRevisions` restores a
 * previously-uncategorized row to NULL, and `autoCategorizeTransactions` runs on every sync
 * calling `applyMerchantRulesToExistingTransactions(db, { onlyUncategorized: true })`. The
 * surviving rule matched the same rows again within the hour, so the strongest signal the owner
 * can give lasted until the next sync. Retiring is the reversible middle, and it is the exact
 * inverse of the creation being undone.
 */
test('undoing a rule creation holds through the next auto-categorization pass', () => {
  const fx = setup();
  // A merchant the text heuristic has no keyword for, so the RULE is the only thing under test.
  // `autoCategorizeTransactions` applies merchant rules first and then falls back to
  // `textCategorization.ts`, and that fallback legitimately re-files a recognisable name like
  // "Blue Bottle Coffee" whatever the rules say. That is a different mechanism and a different
  // question; using it here would test the heuristic instead of the undo.
  txn(fx, { id: 'r1', merchant_name: 'Qvist Nordheim' });
  txn(fx, { id: 'r2', merchant_name: 'Qvist Nordheim' });

  confirmAdvisorDraft(
    fx.db,
    draft({ kind: 'create_merchant_rule', pattern: 'Qvist Nordheim', category_id: 'cat_food_coffee', apply_existing: true }),
    true,
    'worker_auto'
  );

  const undone = undoAdvisorAction(fx.db, onlyAction(fx.db));
  assert.equal(undone.ok, true);
  assert.equal(undone.retired_rules, 1, 'the rule the action created was left live');

  // The pass that used to put everything back.
  autoCategorizeTransactions(fx.db);

  const stillReverted = fx.db.prepare(
    "SELECT COUNT(*) AS n FROM transactions WHERE category_id = 'cat_food_coffee'"
  ).get() as { n: number };
  assert.equal(stillReverted.n, 0, 'the next sync re-filed the rows the undo had restored');

  // Retired, not deleted: it is still visible and restorable in Settings.
  const rule = fx.db.prepare('SELECT retired_at FROM merchant_rules').get() as { retired_at: string | null };
  assert.ok(rule.retired_at, 'the rule was deleted rather than retired');
  fx.db.close();
});

test('HEALTHY: an owner rule untouched by the action is not retired by the undo', () => {
  const fx = setup();
  txn(fx, { id: 'o1', merchant_name: 'Shell Gas' });
  // A rule the owner made, which this action has nothing to do with.
  upsertMerchantRule(fx.db, 'Shell Gas', 'cat_transport', '2026-07-01T00:00:00.000Z', { source: 'human' });
  txn(fx, { id: 'r1', merchant_name: 'Qvist Nordheim' });

  confirmAdvisorDraft(
    fx.db,
    draft({ kind: 'create_merchant_rule', pattern: 'Qvist Nordheim', category_id: 'cat_food_coffee', apply_existing: true }),
    true,
    'worker_auto'
  );
  undoAdvisorAction(fx.db, onlyAction(fx.db));

  const owner = fx.db.prepare("SELECT retired_at FROM merchant_rules WHERE pattern = 'Shell Gas'")
    .get() as { retired_at: string | null };
  assert.equal(owner.retired_at, null, 'the undo reached a rule the action never created');
  fx.db.close();
});
