import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { SyncEvent } from '../shared/types';
import { JOB_MODELS } from '../server/src/services/advisorSettings';
import {
  AI_JOBS,
  evaluateAiJobInvariants,
  runAiJob,
  type AiJobCollect,
  type AiJobDeclaration,
  type AiJobProposal,
} from '../server/src/services/aiJobs';
import { collectorFor, jobsForTrigger } from '../server/src/services/aiScheduler';
import {
  WORKER_DRAFTS_SCHEMA,
  buildBackgroundReviewPrompt,
  collectBackgroundReview,
  newDetections,
  retirableOwnRules,
  type BackgroundReviewPromptInput,
  type DetectedChange,
} from '../server/src/services/aiWorker';
import { _setDbForTesting } from '../server/src/db/index';
import { upsertMerchantRule } from '../server/src/services/rules';
import { providerForModel } from '../server/src/services/aiProviders';
import { checkRuleIsRetirableByAi } from '../server/src/services/aiWriteGuards';
import { migratedTestDb, insertTransaction } from './helpers/schema';

// The framework's job is to make a job's declarations true rather than descriptive. Two of them
// are enforceable and are enforced here: `writes` (a kind the job did not declare never reaches a
// write path, whatever the model returned) and `invariants` (evaluated against the rows the pass
// actually produced). Everything else in this file is about silence: what a pass does when it has
// nothing to do, and what it does when there is no key to call anything with.

// ─── Credentials, deterministically ──────────────────────────────────────────
// The gate is now per provider, checked against the model the job actually runs. Anthropic's
// resolution also reads an `ant auth login` profile off disk, so a developer machine with one
// would make the no-credentials case pass for the wrong reason, and one without would make
// every other case skip. Both are pinned per test.

interface EnvGuard {
  restore: () => void;
}

const CREDENTIAL_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_PROFILE',
  'ANTHROPIC_CONFIG_DIR',
] as const;

function pinEnv(values: Partial<Record<(typeof CREDENTIAL_VARS)[number], string>>): EnvGuard {
  const previous = new Map<string, string | undefined>();
  for (const key of CREDENTIAL_VARS) {
    previous.set(key, process.env[key]);
    const next = values[key];
    if (next === undefined) delete process.env[key];
    else process.env[key] = next;
  }
  return {
    restore: () => {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

function withCredentials(): EnvGuard {
  return pinEnv({ ANTHROPIC_API_KEY: 'test-key-never-used' });
}

function withoutCredentials(): EnvGuard {
  const emptyConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'mizan-no-anthropic-'));
  const guard = pinEnv({ ANTHROPIC_CONFIG_DIR: emptyConfig });
  return {
    restore: () => {
      guard.restore();
      fs.rmSync(emptyConfig, { recursive: true, force: true });
    },
  };
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

function job(overrides: Partial<AiJobDeclaration> = {}): AiJobDeclaration {
  return {
    name: 'background_review',
    trigger: 'after_sync',
    model: 'claude-sonnet-5',
    effort: 'medium',
    writes: ['categorize_transaction'],
    invariants: ['autonomy_boundary', 'human_categories_preserved'],
    digestSection: 'review',
    execution: 'scheduler',
    ...overrides,
  };
}

function categorizeProposal(transactionId: string, categoryId = 'cat_health'): AiJobProposal {
  return {
    kind: 'categorize_transaction',
    label: 'Categorize Trupanion',
    summary: 'Trupanion is pet insurance.',
    route: '/transactions',
    payload: { kind: 'categorize_transaction', transaction_id: transactionId, category_id: categoryId },
    changes: [],
    citations: [],
  };
}

const budgetProposal: AiJobProposal = {
  kind: 'update_budget',
  label: 'Raise the groceries budget',
  summary: 'Spending has run over for three months.',
  route: '/budget',
  payload: { kind: 'update_budget', category_id: 'cat_health', amount: 500, period: 'monthly', rollover: false },
  changes: [],
  citations: [],
};

const goalProposal: AiJobProposal = {
  kind: 'update_goal_target',
  label: 'Raise the emergency fund target',
  summary: 'Six months of expenses is now higher.',
  route: '/goals',
  payload: { kind: 'update_goal_target', goal_id: 'goal_1', target_amount: 10000 },
  changes: [],
  citations: [],
};

function collecting(proposals: AiJobProposal[], malformed = 0): AiJobCollect {
  return async () => ({ status: 'collected', proposals, malformed, usage: null });
}

const nothingToDo: AiJobCollect = async () => ({
  status: 'nothing_to_do',
  detail: 'no uncategorized transactions',
});

interface RunRow {
  job: string;
  trigger_source: string;
  sync_run_id: string | null;
  model: string;
  effort: string | null;
  digest_section: string;
  status: string;
  skipped_reason: string | null;
  proposed: number;
  applied: number;
  queued: number;
  refused_by_guards: number;
  refused_out_of_scope: number;
  malformed: number;
  input_tokens: number | null;
  output_tokens: number | null;
  invariant_breach: string | null;
  error_message: string | null;
  completed_at: string | null;
}

function runRows(db: Database.Database): RunRow[] {
  return db.prepare('SELECT * FROM ai_runs ORDER BY started_at, rowid').all() as RunRow[];
}

function draftRows(db: Database.Database): Array<{ kind: string; status: string }> {
  return db.prepare('SELECT kind, status FROM advisor_drafts').all() as Array<{ kind: string; status: string }>;
}

function collectEvents(): { emit: (event: SyncEvent) => void; events: SyncEvent[] } {
  const events: SyncEvent[] = [];
  return { emit: (event) => { events.push(event); }, events };
}

/**
 * One 'detected' sync change, with the run rows its foreign keys require.
 *
 * Real shape on purpose: `sync_changes.run_item_id` is a NOT NULL reference and the gate reads
 * through it, so a hand-rolled table would let a broken join pass.
 */
let syncSeq = 0;
function insertDetection(db: Database.Database, description: string, createdAt: string): void {
  syncSeq += 1;
  const runId = `sr_${syncSeq}`;
  const itemId = `si_${syncSeq}`;
  db.prepare(
    `INSERT INTO sync_runs (id, scope, status, started_at) VALUES (?, 'full', 'succeeded', ?)`
  ).run(runId, createdAt);
  db.prepare(
    `INSERT INTO sync_run_items (id, run_id, provider, status, started_at)
     VALUES (?, ?, 'system', 'succeeded', ?)`
  ).run(itemId, runId, createdAt);
  db.prepare(
    `INSERT INTO sync_changes (id, run_item_id, entity_type, change_type, description, created_at)
     VALUES (?, ?, 'integrity', 'detected', ?, ?)`
  ).run(`sc_${syncSeq}`, itemId, description, createdAt);
}

/** A fixed clock, so "what the previous pass saw" is an ordering and not a race. */
function at(iso: string): () => Date {
  return () => new Date(iso);
}

/** Runs a pass whose only job is to report what the gate handed it. */
function watchingDetections(seen: DetectedChange[][]): AiJobCollect {
  return async ({ db, runId, startedAt }) => {
    seen.push(newDetections(db, runId, startedAt));
    return { status: 'collected', proposals: [], malformed: 0, usage: null };
  };
}

/** Captures a channel so a "logs nothing" claim is checked rather than asserted. */
async function captureConsole(
  channel: 'error' | 'warn' | 'log',
  run: () => Promise<void>
): Promise<string[]> {
  const lines: string[] = [];
  const original = console[channel];
  console[channel] = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    await run();
  } finally {
    console[channel] = original;
  }
  return lines;
}

// ─── The registry describes what exists, and only what exists ────────────────

test('the registry covers exactly the jobs with a model assignment', () => {
  assert.deepEqual(Object.keys(AI_JOBS).sort(), Object.keys(JOB_MODELS).sort());
});

test('a job does not restate its model: it reads the one assignment table', () => {
  for (const [name, declaration] of Object.entries(AI_JOBS)) {
    const assigned = JOB_MODELS[name as keyof typeof JOB_MODELS];
    assert.equal(declaration.model, assigned.model, `${name} model`);
    assert.equal(declaration.effort, assigned.effort, `${name} effort`);
  }
});

test('the run row records the model the pass will actually call, not the declared default', async (t) => {
  const db = migratedTestDb();
  const env = withCredentials();
  t.after(() => { db.close(); env.restore(); });

  // The owner retiers background_review. `runAiJob` gates credentials on the retiered model and
  // hands it to the collector, so a row written from `job.model` would name a model this pass
  // never called: the exact divergence migration 051 added this column to make visible.
  db.prepare(
    `INSERT INTO app_preferences (key, value, created_at, updated_at) VALUES (?, ?, '2026-07-31', '2026-07-31')
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run('ai_job_model_background_review', JSON.stringify('claude-opus-5'));

  const seen: string[] = [];
  await runAiJob(
    job({ model: 'claude-sonnet-5' }),
    async ({ assignment }) => {
      seen.push(assignment.model);
      return { status: 'collected', proposals: [], malformed: 0, usage: null };
    },
    { db, trigger: 'after_sync' }
  );

  const [row] = runRows(db);
  assert.equal(row.model, 'claude-opus-5', 'the row names the declaration, not the pass');
  assert.equal(row.effort, 'medium', 'and the effort the retiered model was clamped to');
  assert.deepEqual(seen, ['claude-opus-5'], 'the collector was handed the same resolution');
});

test('a job invoked from its own call site may not declare writes', () => {
  // The rule with teeth. `writes` is only enforced by runAiJob, so a draft-writing job that does
  // not go through the framework would carry a declaration nothing checks.
  for (const declaration of Object.values(AI_JOBS)) {
    if (declaration.execution === 'callsite') {
      assert.deepEqual(declaration.writes, [], `${declaration.name} runs outside the framework`);
      assert.deepEqual(declaration.invariants, [], `${declaration.name} runs outside the framework`);
    }
  }
});

test('every after-sync job has something the scheduler can actually run', () => {
  const triggered = jobsForTrigger('after_sync');
  assert.ok(triggered.length > 0, 'a sync with no AI job at all would make this file pointless');
  for (const declaration of triggered) {
    assert.ok(collectorFor(declaration.name), `${declaration.name} would never run`);
  }
  for (const declaration of Object.values(AI_JOBS)) {
    if (declaration.execution === 'callsite') {
      assert.equal(collectorFor(declaration.name), null, `${declaration.name} must not be fired here`);
    }
  }
});

test("the worker's output schema offers a payload for every kind its job declares", () => {
  // A kind declared but absent from the schema is one the model can name and never fill in.
  // `kind` inside each payload variant is a single-member `enum`, not `const`: `const` is
  // undocumented on OpenAI and silently ignored by Gemini, which would delete the
  // discriminator with no error anywhere.
  const schema = WORKER_DRAFTS_SCHEMA as unknown as {
    properties: {
      drafts: { items: { properties: { kind: { enum: string[] }; payload: { anyOf: Array<{ properties: { kind: { enum: string[] } } }> } } } };
    };
  };
  const items = schema.properties.drafts.items.properties;
  const declared = [...AI_JOBS.background_review.writes].sort();
  assert.deepEqual([...items.kind.enum].sort(), declared);
  assert.deepEqual(items.payload.anyOf.map((v) => v.properties.kind.enum[0]).sort(), declared);
});

// ─── The prompt body ─────────────────────────────────────────────────────────
//
// The prompt is the interface to the model: every rule in it is enforced by the model reading it
// and by nothing else, which makes it the one surface where two sentences can contradict each
// other and no test fails. Until these, none did.
//
// The contradiction that got here: the id rule said transaction_id came from "Uncategorized
// transactions", and twelve lines below that a second list of machine-filed rows invited
// categorize_transaction proposals it did not admit. On the owner's ledger the first list is empty
// (`SELECT COUNT(*) FROM transactions WHERE category_id IS NULL` is 0 on a copy at migration 052,
// 2026-07-31), so a model obeying the stated MUST could not have refiled anything at all.

const UNCATEGORIZED_HEADING = 'Uncategorized transactions';
const REFILABLE_HEADING = 'Already filed by a machine, and open to being refiled';
const CATEGORIES_HEADING = 'Valid categories';
const OWN_RULES_HEADING = 'Merchant rules you wrote yourself';
const DETECTIONS_HEADING = 'System detections new since the last review pass';

/** Every heading whose body the model is told to copy ids out of. */
const ID_LIST_HEADINGS = [CATEGORIES_HEADING, UNCATEGORIZED_HEADING, REFILABLE_HEADING, OWN_RULES_HEADING];

function promptInput(
  overrides: Partial<BackgroundReviewPromptInput> = {}
): BackgroundReviewPromptInput {
  return {
    context: 'Net worth: $1.00',
    categories: [{ id: 'cat_health', name: 'Health' }],
    uncategorized: [
      {
        id: 'txn_new', merchant_name: 'Trupanion', original_name: 'TRUPANION', amount: -3902,
        date: '2026-07-29', declined_categories: null,
      },
    ],
    refilable: [
      {
        id: 'txn_refile', merchant_name: 'Trupanion', original_name: 'TRUPANION', amount: -3902,
        date: '2026-07-28', category_name: 'Shopping', category_source: 'rule',
        declined_categories: null,
      },
    ],
    ownRules: [{ id: 'rule_1', pattern: 'Trupanion', category_name: 'Health' }],
    uncategorizedTotal: 1,
    recurring: [
      {
        recurring_id: 'rp_1', original_date: '2026-07-23', merchant_name: 'Mass Inst Payroll',
        expected_date: '2026-07-23', amount: 250000, status: 'overdue', adjustment_action: null,
      },
    ],
    goals: [
      { id: 'goal_1', name: 'Emergency fund', type: 'savings', target_amount: 500000, current_amount: 120000 },
    ],
    detections: [{ entity_type: 'integrity', description: '2 transfer pair(s) need review' }],
    ...overrides,
  };
}

/** Sentences, split on the terminators the prompt actually uses. */
function sentences(prompt: string): string[] {
  return prompt.split(/(?<=[.:])\s+/).map((s) => s.trim()).filter((s) => s.length > 0);
}

/** The line under a heading, which is where that section's first list entry has to be. */
function lineUnderHeading(prompt: string, heading: string): string {
  const lines = prompt.split('\n');
  const at = lines.findIndex((line) => line.startsWith(heading));
  assert.notEqual(at, -1, `the prompt has no "${heading}" section`);
  return lines[at + 1];
}

test('the prompt states exactly one rule about which transaction ids may be used', () => {
  const prompt = buildBackgroundReviewPrompt(promptInput());

  // Exactly one, because two rules about the same field is how the prompt came to forbid in one
  // sentence what it invited in another. A model cannot obey both and nothing here can tell it
  // which one won.
  const rules = sentences(prompt).filter((s) => s.includes('transaction_id') && s.includes('MUST'));
  assert.equal(
    rules.length,
    1,
    `expected one rule about transaction_id, found ${rules.length}:\n${rules.join('\n---\n')}`
  );

  // And that one rule admits BOTH lists the prompt goes on to print ids in. Naming only one of
  // them is the same contradiction with a different sentence deleted.
  assert.ok(rules[0].includes(`"${UNCATEGORIZED_HEADING}"`), 'the rule does not name the uncategorized list');
  assert.ok(rules[0].includes(`"${REFILABLE_HEADING}"`), 'the rule does not name the refilable list');
});

test('no other sentence narrows which rows the model may name', () => {
  const prompt = buildBackgroundReviewPrompt(promptInput());
  const idRule = sentences(prompt).find((s) => s.includes('transaction_id') && s.includes('MUST'));
  assert.ok(idRule);

  // The refile section says which rows are WORTH proposing, which is judgement, and it must not
  // restate where ids come from. Any sentence outside the rule that pairs a MUST with one of the
  // two list headings is a second rule wearing different words.
  const rivals = sentences(prompt).filter(
    (s) => s !== idRule && s.includes('MUST') && (s.includes(UNCATEGORIZED_HEADING) || s.includes(REFILABLE_HEADING))
  );
  assert.deepEqual(rivals, []);
});

test('HEALTHY: on the owner\'s real shape, an empty id list says it is empty', () => {
  // The owner's ledger today: nothing uncategorized, rows to refile, no AI rules of its own yet.
  // The empty section is the one the id rule points at first, so a heading followed by a blank
  // line reads as a truncated list of ids rather than an absence of them.
  const prompt = buildBackgroundReviewPrompt(
    promptInput({ uncategorized: [], uncategorizedTotal: 0, ownRules: [], detections: [] })
  );

  for (const heading of ID_LIST_HEADINGS) {
    const line = lineUnderHeading(prompt, heading);
    assert.notEqual(line, '', `"${heading}" renders as a heading followed by a blank line`);
  }
  assert.equal(lineUnderHeading(prompt, UNCATEGORIZED_HEADING), '(none)');
  assert.equal(lineUnderHeading(prompt, OWN_RULES_HEADING), '(none)');
  assert.equal(lineUnderHeading(prompt, DETECTIONS_HEADING), '(none)');

  // The refilable row is still named and still nameable, which is the whole point of the widening.
  assert.ok(prompt.includes('id: "txn_refile"'));
});

test('HEALTHY: every id the prompt offers is one the pass actually read', () => {
  const input = promptInput();
  const prompt = buildBackgroundReviewPrompt(input);
  for (const id of ['txn_new', 'txn_refile', 'cat_health', 'rule_1']) {
    assert.ok(prompt.includes(`id: "${id}"`), `${id} was collected and never reached the prompt`);
  }
});

/** The id rule's own paragraph, which is the only place the prompt says where an id may come from. */
function idRuleParagraph(prompt: string): string {
  const paragraph = prompt.split('\n\n').find((p) => p.startsWith('THE ONE RULE ABOUT IDS.'));
  assert.ok(paragraph, 'the prompt has no id rule');
  return paragraph;
}

test('every id a declared write kind needs is one the id rule says where to copy from', () => {
  // `writes` declared update_goal_target and create_recurring_adjustment while the prompt carried
  // a goal's name and a count of overdue items, never a goal_id or a recurring_id. The one
  // update_goal_target draft that pass ever produced named goal "emergency_fund", which exists
  // nowhere, so a declared kind could only be filled in by inventing its id. Derived from the
  // output schema rather than listed, so a kind added to `writes` is covered without editing this.
  const schema = WORKER_DRAFTS_SCHEMA as unknown as {
    properties: { drafts: { items: { properties: { payload: { anyOf: Array<{ properties: Record<string, { enum?: string[] }> }> } } } } };
  };
  const declared = new Set<string>(AI_JOBS.background_review.writes);
  const needed = schema.properties.drafts.items.properties.payload.anyOf
    .filter((variant) => declared.has(variant.properties.kind.enum?.[0] ?? ''))
    .flatMap((variant) => Object.keys(variant.properties))
    .filter((field) => field.endsWith('_id') || field === 'original_date');

  const prompt = buildBackgroundReviewPrompt(promptInput());
  const rule = idRuleParagraph(prompt);
  for (const field of new Set(needed)) {
    assert.ok(rule.includes(`"${field}"`), `the id rule never says where "${field}" comes from`);
  }

  // And every list the rule points at is a heading the prompt actually prints.
  const pointedAt = [...rule.matchAll(/under "([^"]+)"/g)].map((m) => m[1]);
  assert.ok(pointedAt.length > 0);
  const lines = prompt.split('\n');
  for (const heading of pointedAt) {
    assert.ok(lines.some((line) => line.startsWith(heading)), `the id rule points at "${heading}", which the prompt never prints`);
  }
});

test('HEALTHY: a goal and a recurring occurrence reach the prompt by their real ids', () => {
  const prompt = buildBackgroundReviewPrompt(promptInput());
  assert.ok(prompt.includes('id: "goal_1"'), 'the goal id was collected and never reached the prompt');
  assert.ok(prompt.includes('recurring_id: "rp_1"'));
  assert.ok(prompt.includes('original_date: "2026-07-23"'));
});

test('HEALTHY: with no goals and nothing overdue or adjusted, both lists say they are empty', () => {
  const prompt = buildBackgroundReviewPrompt(promptInput({ recurring: [], goals: [] }));
  const rule = idRuleParagraph(prompt);
  for (const heading of [...rule.matchAll(/under "([^"]+)"/g)].map((m) => m[1])) {
    assert.notEqual(lineUnderHeading(prompt, heading), '', `"${heading}" renders as a heading followed by a blank line`);
  }
});

/** The worked example at the foot of the prompt, which the model imitates more readily than any rule. */
function exampleBlock(prompt: string): string {
  const at = prompt.indexOf('Example format');
  assert.notEqual(at, -1, 'the prompt has no worked example');
  return prompt.slice(at);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('the worked example names no real merchant and no real category', () => {
  // It used to file Trupanion under Health while its own summary called it pet insurance, on a
  // ledger where the owner's live rule files Trupanion under Pets and the context embedded above it
  // says not to propose a rule for a merchant that already has one. Whatever a concrete example
  // asserts is a claim about the owner's ledger that nothing here checks, so it asserts none.
  const db = migratedTestDb();
  const taxonomy = (db.prepare('SELECT name FROM categories').all() as Array<{ name: string }>).map((c) => c.name);
  db.close();

  const example = exampleBlock(buildBackgroundReviewPrompt(promptInput()));
  assert.ok(!example.includes('Trupanion'), 'the example still names a merchant on the owner\'s ledger');
  const named = taxonomy.filter((name) =>
    new RegExp(`(^|[^A-Za-z&])${escapeRegExp(name)}($|[^A-Za-z&])`).test(example)
  );
  assert.deepEqual(named, [], `the example names real categories: ${named.join(', ')}`);
});

test('HEALTHY: the worked example still shows the shape of both kinds it is there to teach', () => {
  const example = exampleBlock(buildBackgroundReviewPrompt(promptInput()));
  assert.ok(example.includes('"kind": "categorize_transaction"'));
  assert.ok(example.includes('"kind": "create_merchant_rule"'));
  assert.ok(example.includes('"apply_existing": true'));
});

// ─── `writes` is enforced, not documented ────────────────────────────────────

test('a proposal outside the job\'s declared writes never reaches a write path', async (t) => {
  const db = migratedTestDb();
  const env = withCredentials();
  t.after(() => { db.close(); env.restore(); });

  const events = collectEvents();
  const outcome = await captureConsole('warn', async () => {
    await runAiJob(job({ writes: ['categorize_transaction'] }), collecting([goalProposal]), {
      db,
      trigger: 'after_sync',
      syncRunId: 'run_1',
      emit: events.emit,
    });
  });

  assert.equal(outcome.length, 1, 'the refusal says which kind and what the job may write');
  assert.match(outcome[0], /update_goal_target/);

  assert.deepEqual(draftRows(db), [], 'nothing was queued for the owner either');
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS n FROM advisor_actions').get() as { n: number }).n,
    0
  );
  const [row] = runRows(db);
  assert.equal(row.status, 'completed');
  assert.equal(row.refused_out_of_scope, 1);
  assert.equal(row.proposed, 0);
  assert.equal(row.applied, 0);
  assert.deepEqual(events.events, [], 'a pass that wrote nothing tells the client nothing');
});

test('a proposal whose payload contradicts its own kind is dropped as malformed', async (t) => {
  const db = migratedTestDb();
  const env = withCredentials();
  t.after(() => { db.close(); env.restore(); });

  const mismatched = { ...goalProposal, kind: 'categorize_transaction' } as AiJobProposal;
  await captureConsole('warn', async () => {
    await runAiJob(job({ writes: ['categorize_transaction', 'update_goal_target'] }), collecting([mismatched]), {
      db,
      trigger: 'after_sync',
    });
  });

  assert.deepEqual(draftRows(db), []);
  const [row] = runRows(db);
  assert.equal(row.malformed, 1);
  assert.equal(row.refused_out_of_scope, 0, 'the kind was declared; the payload was the problem');
});

test('declaring a kind in `writes` does not widen the autonomy carve-out', async (t) => {
  const db = migratedTestDb();
  const env = withCredentials();
  t.after(() => { db.close(); env.restore(); });

  const events = collectEvents();
  await runAiJob(job({ writes: ['update_budget'] }), collecting([budgetProposal]), {
    db,
    trigger: 'after_sync',
    emit: events.emit,
  });

  // `writes` says what a job may put in front of the owner. AUTONOMOUS_DRAFT_KINDS says what may
  // land without the owner, and update_budget changes a number the owner set.
  assert.deepEqual(draftRows(db), [{ kind: 'update_budget', status: 'open' }]);
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS n FROM advisor_actions').get() as { n: number }).n,
    0
  );
  const [row] = runRows(db);
  assert.equal(row.proposed, 1);
  assert.equal(row.applied, 0);
  assert.equal(row.queued, 1);
  assert.deepEqual(events.events, [], 'nothing was applied, so nothing on screen went stale');
});

// ─── Silence ─────────────────────────────────────────────────────────────────

test('HEALTHY: a pass with nothing to do records that it looked, and tells the client nothing', async (t) => {
  const db = migratedTestDb();
  const env = withCredentials();
  t.after(() => { db.close(); env.restore(); });

  const events = collectEvents();
  const errors = await captureConsole('error', async () => {
    await runAiJob(job(), nothingToDo, { db, trigger: 'after_sync', syncRunId: 'run_1', emit: events.emit });
  });

  assert.deepEqual(errors, [], 'having nothing to review is not a failure');
  assert.deepEqual(events.events, []);
  assert.deepEqual(draftRows(db), []);

  const [row] = runRows(db);
  assert.equal(row.status, 'skipped');
  assert.equal(row.skipped_reason, 'nothing_to_do');
  assert.equal(row.sync_run_id, 'run_1');
  assert.equal(row.model, 'claude-sonnet-5');
  assert.equal(row.digest_section, 'review');
  assert.ok(row.completed_at);
  assert.equal(row.input_tokens, null, 'no call was made; 0 would assert a measurement nobody took');
  assert.equal(row.output_tokens, null);
  assert.equal(row.invariant_breach, null);
  assert.equal(row.error_message, null);
});

test('HEALTHY: with no Anthropic credentials nothing runs, nothing is recorded, nothing errors', async (t) => {
  const db = migratedTestDb();
  const env = withoutCredentials();
  t.after(() => { db.close(); env.restore(); });

  const events = collectEvents();
  let collected = false;
  const errors = await captureConsole('error', async () => {
    const outcome = await runAiJob(
      job(),
      async () => { collected = true; return { status: 'collected', proposals: [], malformed: 0, usage: null }; },
      { db, trigger: 'after_sync', syncRunId: 'run_1', emit: events.emit }
    );
    assert.equal(outcome.status, 'skipped');
  });

  assert.equal(collected, false);
  assert.deepEqual(errors, []);
  assert.deepEqual(events.events, []);
  // An install with no key syncs hourly forever. A run row per hour saying "no key" is a standing
  // finding nobody can act on, so the pass leaves no trace at all.
  assert.deepEqual(runRows(db), []);
  assert.deepEqual(draftRows(db), []);
});

test('HEALTHY: an empty proposal list is a completed pass, not a failure or an event', async (t) => {
  const db = migratedTestDb();
  const env = withCredentials();
  t.after(() => { db.close(); env.restore(); });

  const events = collectEvents();
  const errors = await captureConsole('error', async () => {
    await runAiJob(job(), collecting([]), { db, trigger: 'after_sync', emit: events.emit });
  });

  assert.deepEqual(errors, []);
  assert.deepEqual(events.events, []);
  const [row] = runRows(db);
  assert.equal(row.status, 'completed');
  assert.equal(row.proposed, 0);
});

test('an open draft the fresh pass does not regenerate survives it', async (t) => {
  const db = migratedTestDb();
  const env = withCredentials();
  t.after(() => { db.close(); env.restore(); });

  db.prepare(`
    INSERT INTO advisor_drafts (id, kind, label, summary, route, payload, changes, citations, status, created_at, updated_at)
    VALUES ('draft_old', 'update_budget', 'l', 's', '/budget', ?, '[]', '[]', 'open', '2026-07-01', '2026-07-01')
  `).run(JSON.stringify(budgetProposal.payload));

  await runAiJob(job(), collecting([]), { db, trigger: 'after_sync' });

  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS n FROM advisor_drafts WHERE id = 'draft_old'`).get() as { n: number }).n,
    1,
    "a pass that says nothing about a target must not wipe the owner's un-acted-on queue"
  );
});

// ─── What a pass that wrote something tells the client ───────────────────────

test('a pass that applies something says so exactly once', async (t) => {
  const db = migratedTestDb();
  const env = withCredentials();
  t.after(() => { db.close(); env.restore(); });

  const txnId = insertTransaction(db, { merchant_name: 'Trupanion', amount: -3902 });
  const events = collectEvents();
  const errors = await captureConsole('error', async () => {
    await runAiJob(job(), collecting([categorizeProposal(txnId)]), {
      db,
      trigger: 'after_sync',
      syncRunId: 'run_1',
      emit: events.emit,
    });
  });

  assert.deepEqual(errors, []);
  const [row] = runRows(db);
  assert.equal(row.applied, 1, 'the categorization landed');
  assert.equal(row.queued, 0);
  assert.equal(row.invariant_breach, null, 'a healthy pass breaks none of its declared invariants');

  assert.equal(events.events.length, 1);
  const event = events.events[0];
  assert.equal(event.type, 'ai_pass_applied');
  assert.equal(event.applied, 1);
  assert.equal(event.job, 'background_review');
  // The client refreshes on this; it must not read as a sync, because none happened.
  assert.equal(event.status, undefined);
  assert.equal(event.completedAt, undefined);

  const txn = db.prepare('SELECT category_id, category_source FROM transactions WHERE id = ?').get(txnId) as
    { category_id: string | null; category_source: string | null };
  assert.equal(txn.category_id, 'cat_health');
  assert.equal(txn.category_source, 'ai');
});

test('token usage is recorded as the cost of the pass', async (t) => {
  const db = migratedTestDb();
  const env = withCredentials();
  t.after(() => { db.close(); env.restore(); });

  const collect: AiJobCollect = async () => ({
    status: 'collected',
    proposals: [],
    malformed: 0,
    usage: { input_tokens: 4211, output_tokens: 318, cache_read_tokens: 0, cache_write_tokens: null },
  });
  await runAiJob(job(), collect, { db, trigger: 'after_sync' });

  const [row] = runRows(db);
  assert.equal(row.input_tokens, 4211);
  assert.equal(row.output_tokens, 318);
});

// ─── Failure is recorded, once ───────────────────────────────────────────────

test('a pass that throws is recorded as failed and said out loud once', async (t) => {
  const db = migratedTestDb();
  const env = withCredentials();
  t.after(() => { db.close(); env.restore(); });

  const events = collectEvents();
  const errors = await captureConsole('error', async () => {
    const outcome = await runAiJob(
      job(),
      async () => { throw new Error('Model returned no content blocks'); },
      { db, trigger: 'after_sync', emit: events.emit }
    );
    assert.equal(outcome.status, 'failed');
  });

  assert.equal(errors.length, 1);
  assert.match(errors[0], /no content blocks/);
  assert.deepEqual(events.events, []);
  const [row] = runRows(db);
  assert.equal(row.status, 'failed');
  assert.match(row.error_message ?? '', /no content blocks/);
});

test('a second pass fired while one is in flight is recorded rather than lost', async (t) => {
  const db = migratedTestDb();
  const env = withCredentials();
  t.after(() => { db.close(); env.restore(); });

  let collects = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const collect: AiJobCollect = async () => {
    collects++;
    await gate;
    return { status: 'collected', proposals: [], malformed: 0, usage: null };
  };

  const first = runAiJob(job(), collect, { db, trigger: 'after_sync' });
  const second = await runAiJob(job(), collect, { db, trigger: 'after_sync' });
  release();
  await first;

  assert.equal(collects, 1, 'two overlapping passes would double-apply');
  assert.equal(second.status, 'skipped');
  const rows = runRows(db);
  assert.equal(rows.length, 2);
  assert.ok(rows.some((r) => r.skipped_reason === 'already_running'));
});

test('a pass whose run row cannot be written does not disable the job', async (t) => {
  const db = migratedTestDb();
  const env = withCredentials();
  t.after(() => { db.close(); env.restore(); });

  const schema = (
    db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'ai_runs'`).get() as
      { sql: string }
  ).sql;
  db.exec('DROP TABLE ai_runs');

  let collects = 0;
  const collect: AiJobCollect = async () => {
    collects += 1;
    return { status: 'collected', proposals: [], malformed: 0, usage: null };
  };

  await assert.rejects(
    runAiJob(job(), collect, { db, trigger: 'after_sync' }),
    /ai_runs/,
    'recording the pass is what failed, and the caller is told which'
  );
  assert.equal(collects, 0, 'nothing ran, so nothing needs undoing');

  db.exec(schema);

  // The latch is what this test is really about. It used to be taken before the insert and released
  // only by the body's own `finally`, which the failed insert jumped over, so the job's name stayed
  // in `running` and every later trigger answered 'already_running' until the process restarted.
  const outcome = await runAiJob(job(), collect, { db, trigger: 'after_sync' });
  assert.equal(outcome.status, 'completed', 'the next trigger runs a real pass');
  assert.equal(collects, 1);
  const rows = runRows(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].skipped_reason, null, 'and it is not recorded as a collision with a ghost');
});

// ─── The delta a pass reviews is recent, or it is not a delta ────────────────

test('a detection the previous pass already saw is not a reason to call the model again', async (t) => {
  const db = migratedTestDb();
  const env = withCredentials();
  t.after(() => { db.close(); env.restore(); });

  const seen: DetectedChange[][] = [];
  const collect = watchingDetections(seen);

  insertDetection(db, '2 transfer pair(s) need review', '2026-07-30T01:00:00.000Z');
  await runAiJob(job(), collect, { db, trigger: 'after_sync', now: at('2026-07-30T02:00:00.000Z') });

  // The integrity stage rewrites the same standing count on every sync for as long as the queue is
  // unreviewed. That is a level, not a change, and it must not read as one.
  insertDetection(db, '2 transfer pair(s) need review', '2026-07-30T03:00:00.000Z');
  await runAiJob(job(), collect, { db, trigger: 'after_sync', now: at('2026-07-30T04:00:00.000Z') });

  insertDetection(db, '11 transfer pair(s) need review', '2026-07-30T05:00:00.000Z');
  await runAiJob(job(), collect, { db, trigger: 'after_sync', now: at('2026-07-30T06:00:00.000Z') });

  assert.deepEqual(seen[0].map((d) => d.description), ['2 transfer pair(s) need review']);
  assert.deepEqual(seen[1], [], 'the same backlog restated is not news');
  assert.deepEqual(
    seen[2].map((d) => d.description),
    ['11 transfer pair(s) need review'],
    'a count that changed is'
  );
});

test('HEALTHY: the first pass ever is bounded by a lookback, not handed the whole history', async (t) => {
  const db = migratedTestDb();
  const env = withCredentials();
  t.after(() => { db.close(); env.restore(); });

  insertDetection(db, '51 duplicate group(s) need review', '2026-06-30T15:37:00.000Z');
  insertDetection(db, '1 duplicate group(s) need review', '2026-07-30T01:00:00.000Z');

  const seen: DetectedChange[][] = [];
  await runAiJob(job(), watchingDetections(seen), {
    db,
    trigger: 'after_sync',
    now: at('2026-07-30T02:00:00.000Z'),
  });

  assert.deepEqual(seen[0].map((d) => d.description), ['1 duplicate group(s) need review']);
});

test('HEALTHY: a pass that failed does not count as having reviewed the delta', async (t) => {
  const db = migratedTestDb();
  const env = withCredentials();
  t.after(() => { db.close(); env.restore(); });

  insertDetection(db, '6 transfer pair(s) need review', '2026-07-30T01:00:00.000Z');

  await captureConsole('error', async () => {
    await runAiJob(job(), async () => { throw new Error('Model returned no content blocks'); }, {
      db,
      trigger: 'after_sync',
      now: at('2026-07-30T02:00:00.000Z'),
    });
  });

  const seen: DetectedChange[][] = [];
  await runAiJob(job(), watchingDetections(seen), {
    db,
    trigger: 'after_sync',
    now: at('2026-07-30T03:00:00.000Z'),
  });

  assert.deepEqual(
    seen[0].map((d) => d.description),
    ['6 transfer pair(s) need review'],
    'a lost model call must not swallow the delta it was going to review'
  );
});

test('HEALTHY: a sync with nothing new records that it looked and calls no model', async (t) => {
  const db = migratedTestDb();
  const env = withCredentials();
  // buildFinancialContext() reads the module singleton rather than the handle it is passed.
  _setDbForTesting(db);
  t.after(() => { db.close(); env.restore(); });

  // The real collector, on a ledger with no uncategorized rows, no recurring patterns and no
  // detections. No fake API is installed: if the gate let this reach `anthropic.messages.create`
  // the pass would fail rather than skip, which is exactly what the assertion below would catch.
  const events = collectEvents();
  const errors = await captureConsole('error', async () => {
    const outcome = await runAiJob(AI_JOBS.background_review, collectBackgroundReview, {
      db,
      trigger: 'after_sync',
      syncRunId: 'run_1',
      emit: events.emit,
    });
    assert.equal(outcome.status, 'skipped');
    assert.equal(outcome.status === 'skipped' ? outcome.reason : null, 'nothing_to_do');
  });

  assert.deepEqual(errors, []);
  assert.deepEqual(events.events, []);
  assert.deepEqual(draftRows(db), []);
  const [row] = runRows(db);
  assert.equal(row.status, 'skipped');
  assert.equal(row.skipped_reason, 'nothing_to_do');
  assert.equal(row.input_tokens, null, 'no call was made');
});

// ─── The gate opens on a delta, not on a standing state ──────────────────────
//
// The gate used to open whenever the model had ANY live rule, any machine-filed row or any overdue
// item, all of which are standing states; the measurement is beside the gate in aiWorker.ts. These
// run the real collector with the provider's call replaced, so a gate that opens is a recorded
// call, never a network request.

interface StubbedCall {
  calls: string[];
  restore: () => void;
}

/** `replies` are returned in order, one per call; once they run out every call answers no drafts. */
function stubModelCall(replies: readonly unknown[][] = []): StubbedCall {
  const provider = providerForModel(AI_JOBS.background_review.model);
  const original = provider.generateStructured;
  const calls: string[] = [];
  provider.generateStructured = async (request) => {
    const drafts = replies[calls.length] ?? [];
    calls.push(request.systemText);
    return {
      text: JSON.stringify({ drafts }),
      truncated: false,
      usage: { uncachedInputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: null },
    };
  };
  return { calls, restore: () => { provider.generateStructured = original; } };
}

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function localDate(daysFromToday: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysFromToday);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** A completed pass, so the next one has something to measure "new" against. */
function insertCompletedPass(db: Database.Database, startedAt: string): void {
  db.prepare(`
    INSERT INTO ai_runs (id, job, trigger_source, model, digest_section, status, started_at, completed_at, created_at)
    VALUES (?, 'background_review', 'after_sync', 'claude-sonnet-5', 'review', 'completed', ?, ?, ?)
  `).run(`run_prior_${startedAt}`, startedAt, startedAt, startedAt);
}

function insertMonthlyPattern(db: Database.Database, nextExpected: string): string {
  const id = `rp_${nextExpected}`;
  db.prepare(`
    INSERT INTO recurring_patterns
      (id, merchant_name, category_id, average_amount, frequency, last_seen, next_expected,
       is_active, is_confirmed, transaction_count, created_at, updated_at)
    VALUES (?, ?, 'cat_income_paycheck', 250000, 'monthly', ?, ?, 1, 1, 6, ?, ?)
  `).run(id, `Payroll ${nextExpected}`, nextExpected, nextExpected, minutesAgo(60 * 24 * 90), minutesAgo(60 * 24 * 90));
  return id;
}

/**
 * The owner's ledger in its ordinary quiet state, every leg already shown to a previous pass.
 *
 * The model's one rule holds the row it was written for; that row is machine-filed and so stays in
 * the refile pool; a payroll pattern went overdue days ago. All of it predates the last pass.
 */
function quietLedger(db: Database.Database): { aiRuleId: string; lastPass: string } {
  insertTransaction(db, { merchant_name: 'Qvist Nordheim', category_id: 'cat_health', category_source: 'rule' });
  const aiRuleId = upsertMerchantRule(db, 'Qvist Nordheim', 'cat_health', minutesAgo(60 * 24 * 30), { source: 'ai' }).ruleId as string;
  insertMonthlyPattern(db, localDate(-40));
  const lastPass = minutesAgo(5);
  insertCompletedPass(db, lastPass);
  return { aiRuleId, lastPass };
}

async function runRealPass(db: Database.Database): Promise<Awaited<ReturnType<typeof runAiJob>>> {
  return runAiJob(AI_JOBS.background_review, collectBackgroundReview, { db, trigger: 'after_sync' });
}

test('HEALTHY: a ledger whose every item a previous pass already saw calls no model', async (t) => {
  const db = migratedTestDb();
  const env = withCredentials();
  const stub = stubModelCall();
  _setDbForTesting(db);
  t.after(() => { stub.restore(); db.close(); env.restore(); });

  const { aiRuleId } = quietLedger(db);
  assert.equal(checkRuleIsRetirableByAi(db, aiRuleId).ok, false, 'fixture: the rule holds its row');

  const outcome = await runRealPass(db);
  assert.equal(outcome.status === 'skipped' ? outcome.reason : outcome.status, 'nothing_to_do');
  assert.deepEqual(stub.calls, [], 'a standing state bought a model call');
});

test('the model is only offered rules the retire guard would accept', (t) => {
  // Listing a rule that holds rows invites a proposal checkRuleIsRetirableByAi refuses, which is
  // the argument retirableOwnRules already made for leaving out the owner's rules.
  const db = migratedTestDb();
  t.after(() => db.close());
  const { aiRuleId } = quietLedger(db);
  const inert = upsertMerchantRule(db, 'Brandt Okafor', 'cat_health', minutesAgo(60), { source: 'ai' }).ruleId as string;

  assert.deepEqual(retirableOwnRules(db).map((r) => r.id), [inert]);
  assert.equal(checkRuleIsRetirableByAi(db, inert).ok, true);
  assert.equal(checkRuleIsRetirableByAi(db, aiRuleId).ok, false);
});

test('a row machine-filed since the last pass opens the gate, and is listed first', async (t) => {
  const db = migratedTestDb();
  const env = withCredentials();
  const stub = stubModelCall();
  _setDbForTesting(db);
  t.after(() => { stub.restore(); db.close(); env.restore(); });

  quietLedger(db);
  const fresh = insertTransaction(db, {
    merchant_name: 'Lindqvist Hardware', category_id: 'cat_shop', category_source: 'heuristic', date: '2020-01-01',
  });
  db.prepare('UPDATE transactions SET created_at = ? WHERE id = ?').run(minutesAgo(1), fresh);

  const outcome = await runRealPass(db);
  assert.equal(outcome.status, 'completed');
  assert.equal(stub.calls.length, 1);
  // Dated years back on purpose: ordered by date alone it would sort last and could fall off the
  // list, leaving a pass paid for by a row it never shows.
  assert.ok(lineUnderHeading(stub.calls[0], REFILABLE_HEADING).includes(`id: "${fresh}"`));
});

test('an owner rule that leaves the model\'s rule holding nothing opens the gate once', async (t) => {
  const db = migratedTestDb();
  const env = withCredentials();
  const stub = stubModelCall();
  _setDbForTesting(db);
  t.after(() => { stub.restore(); db.close(); env.restore(); });

  const { aiRuleId } = quietLedger(db);
  upsertMerchantRule(db, 'Qvist Nordheim Oy', 'cat_pets', minutesAgo(1), { source: 'human' });
  assert.equal(checkRuleIsRetirableByAi(db, aiRuleId).ok, true, 'fixture: the owner rule outranks it');

  await runRealPass(db);
  assert.equal(stub.calls.length, 1);
  assert.ok(stub.calls[0].includes(`id: "${aiRuleId}"`));

  // The model saw it and left it. That is an answer, and the next sync is quiet.
  const second = await runRealPass(db);
  assert.equal(second.status === 'skipped' ? second.reason : second.status, 'nothing_to_do');
  assert.equal(stub.calls.length, 1);
});

test('HEALTHY: a pass\'s own rule, applied unattended, does not buy the next pass', async (t) => {
  // The ordinary thing a pass does is write. A gate keyed on "the rule set changed" opened again for
  // the pass's own create_merchant_rule while any inert rule of its own existed, which on the
  // owner's ledger is always: an echo pass per pass that wrote a rule.
  const db = migratedTestDb();
  const env = withCredentials();
  quietLedger(db);
  upsertMerchantRule(db, 'Brandt Okafor', 'cat_health', minutesAgo(60 * 24 * 30), { source: 'ai' });
  const row = insertTransaction(db, {
    merchant_name: 'Lindqvist Hardware', category_id: 'cat_shop', category_source: 'heuristic',
  });
  db.prepare('UPDATE transactions SET created_at = ? WHERE id = ?').run(minutesAgo(1), row);
  const stub = stubModelCall([[{
    kind: 'create_merchant_rule',
    label: 'Always categorize Lindqvist Hardware as Shopping',
    summary: 'Auto-categorize future Lindqvist Hardware charges as Shopping.',
    route: '/ledger',
    payload: { kind: 'create_merchant_rule', pattern: 'Lindqvist Hardware', category_id: 'cat_shop', apply_existing: true },
    changes: [],
  }]]);
  _setDbForTesting(db);
  t.after(() => { stub.restore(); db.close(); env.restore(); });

  const first = await runRealPass(db);
  assert.equal(first.status, 'completed');
  const written = db.prepare(`SELECT COUNT(*) AS n FROM merchant_rules WHERE pattern = 'Lindqvist Hardware' AND source = 'ai'`).get() as { n: number };
  assert.equal(written.n, 1, 'fixture: the first pass wrote its rule');

  const second = await runRealPass(db);
  assert.equal(second.status === 'skipped' ? second.reason : second.status, 'nothing_to_do');
  assert.equal(stub.calls.length, 1);
});

test('an occurrence that went overdue since the last pass opens the gate', async (t) => {
  const db = migratedTestDb();
  const env = withCredentials();
  const stub = stubModelCall();
  _setDbForTesting(db);
  t.after(() => { stub.restore(); db.close(); env.restore(); });

  insertMonthlyPattern(db, localDate(-1));
  insertCompletedPass(db, new Date(Date.now() - 3 * 86_400_000).toISOString());

  await runRealPass(db);
  assert.equal(stub.calls.length, 1);
  assert.ok(stub.calls[0].includes(`original_date: "${localDate(-1)}"`));
});

// ─── Invariants, judged on the rows the pass produced ────────────────────────

test('autonomy_boundary: an unattended write outside the carve-out is a breach', () => {
  const db = migratedTestDb();
  const breaches = evaluateAiJobInvariants(
    db,
    [{ id: 'act_1', kind: 'update_budget', source: 'worker_auto' }],
    ['autonomy_boundary']
  );
  db.close();
  assert.equal(breaches.length, 1);
  assert.equal(breaches[0].invariant, 'autonomy_boundary');
  assert.match(breaches[0].detail, /update_budget/);
});

test('HEALTHY: the owner confirming a proposal-only draft mid-pass is not a breach', () => {
  const db = migratedTestDb();
  // The case a before/after diff of budgets would have flagged: the owner acted, not the model.
  const breaches = evaluateAiJobInvariants(
    db,
    [
      { id: 'act_1', kind: 'update_budget', source: 'user_confirm' },
      { id: 'act_2', kind: 'categorize_transaction', source: 'worker_auto' },
      { id: 'act_3', kind: 'create_merchant_rule', source: 'worker_auto' },
    ],
    ['autonomy_boundary']
  );
  db.close();
  assert.deepEqual(breaches, []);
});

test('human_categories_preserved: overwriting a hand-set category is a breach', () => {
  const db = migratedTestDb();
  const txnId = insertTransaction(db, { category_id: 'cat_health', category_source: 'human' });
  db.prepare(`
    INSERT INTO transaction_category_revisions
      (id, transaction_id, from_category_id, to_category_id, from_source, to_source, action_id, created_at)
    VALUES ('rev_1', ?, 'cat_health', 'cat_shopping', 'human', 'ai', 'act_1', '2026-07-30T00:00:00.000Z')
  `).run(txnId);

  const breaches = evaluateAiJobInvariants(
    db,
    [{ id: 'act_1', kind: 'categorize_transaction', source: 'worker_auto' }],
    ['human_categories_preserved']
  );
  db.close();
  assert.equal(breaches.length, 1);
  assert.equal(breaches[0].invariant, 'human_categories_preserved');
});

test('HEALTHY: recategorizing a row the model itself set, or an uncategorized one, is silent', () => {
  const db = migratedTestDb();
  const aiRow = insertTransaction(db, { category_id: 'cat_health', category_source: 'ai' });
  const freshRow = insertTransaction(db);
  db.prepare(`
    INSERT INTO transaction_category_revisions
      (id, transaction_id, from_category_id, to_category_id, from_source, to_source, action_id, created_at)
    VALUES ('rev_1', ?, 'cat_health', 'cat_shopping', 'ai', 'ai', 'act_1', '2026-07-30T00:00:00.000Z')
  `).run(aiRow);
  db.prepare(`
    INSERT INTO transaction_category_revisions
      (id, transaction_id, from_category_id, to_category_id, from_source, to_source, action_id, created_at)
    VALUES ('rev_2', ?, NULL, 'cat_shopping', NULL, 'ai', 'act_1', '2026-07-30T00:00:00.000Z')
  `).run(freshRow);

  const breaches = evaluateAiJobInvariants(
    db,
    [{ id: 'act_1', kind: 'categorize_transaction', source: 'worker_auto' }],
    ['human_categories_preserved']
  );
  db.close();
  assert.deepEqual(breaches, []);
});

test('HEALTHY: another action\'s human overwrite is not attributed to this pass', () => {
  const db = migratedTestDb();
  const txnId = insertTransaction(db, { category_id: 'cat_health', category_source: 'human' });
  db.prepare(`
    INSERT INTO transaction_category_revisions
      (id, transaction_id, from_category_id, to_category_id, from_source, to_source, action_id, created_at)
    VALUES ('rev_1', ?, 'cat_health', 'cat_shopping', 'human', 'ai', 'act_other', '2026-07-30T00:00:00.000Z')
  `).run(txnId);

  const breaches = evaluateAiJobInvariants(
    db,
    [{ id: 'act_1', kind: 'categorize_transaction', source: 'worker_auto' }],
    ['human_categories_preserved']
  );
  db.close();
  assert.deepEqual(breaches, []);
});

test('a job declaring no invariants has none evaluated, and says none held', () => {
  const db = migratedTestDb();
  const breaches = evaluateAiJobInvariants(
    db,
    [{ id: 'act_1', kind: 'update_budget', source: 'worker_auto' }],
    []
  );
  db.close();
  assert.deepEqual(breaches, [], 'declaring nothing must not silently assert everything');
});

// ─── A no-op is not an applied change ────────────────────────────────────────

/**
 * Re-proposing a rule the ledger already holds resolves the draft and applies nothing.
 *
 * `confirmAdvisorDraft` already declined to write an `advisor_actions` row for this case, on the
 * argument that an action with no blast radius and an Undo that reverts nothing is exactly what the
 * refusal path was fixed to stop producing. But it still returned success, `runAiJob` counted every
 * success as `applied++`, and the client toasted "AI review applied N changes". The worker
 * re-proposes such rules on every pass, so every hourly run announced a change it had itself
 * decided not to record.
 */
function ruleProposal(pattern: string, categoryId: string): AiJobProposal {
  return {
    kind: 'create_merchant_rule',
    label: `Rule for ${pattern}`,
    summary: `${pattern} is always ${categoryId}.`,
    route: '/settings',
    payload: { kind: 'create_merchant_rule', pattern, category_id: categoryId, apply_existing: true },
    changes: [],
    citations: [],
  };
}

test('a rule the ledger already holds is resolved, not counted as applied, and not toasted', async (t) => {
  const db = migratedTestDb();
  const env = withCredentials();
  t.after(() => { db.close(); env.restore(); });

  // The rule exists before the pass, authored by the model on an earlier pass, and every matching
  // row is already filed under it: the state the draft proposes already holds.
  const txnId = insertTransaction(db, { merchant_name: 'Trupanion', amount: -3902 });
  upsertMerchantRule(db, 'Trupanion', 'cat_health', '2026-07-01T00:00:00.000Z', { source: 'ai' });
  db.prepare("UPDATE transactions SET category_id = 'cat_health', category_source = 'rule' WHERE id = ?").run(txnId);

  const events = collectEvents();
  await runAiJob(job({ writes: ['categorize_transaction', 'create_merchant_rule'] }), collecting([ruleProposal('Trupanion', 'cat_health')]), {
    db,
    trigger: 'after_sync',
    syncRunId: 'run_1',
    emit: events.emit,
  });

  const [row] = runRows(db);
  assert.equal(row.applied, 0, 'a no-op was counted as an applied change');
  assert.equal(row.queued, 0, 'a no-op was queued for review');
  assert.equal(row.refused_by_guards, 0, 'a no-op was reported as a refusal');

  // Resolved, so it stops being re-proposed; but no action row, so nothing pretends to be undoable.
  const draft = db.prepare("SELECT status FROM advisor_drafts WHERE kind = 'create_merchant_rule'").get() as { status: string };
  assert.equal(draft.status, 'confirmed');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM advisor_actions').get() as { n: number }).n, 0);

  // And nothing toasts. `ai_pass_applied` is the event the client turns into "applied N changes".
  assert.deepEqual(events.events.filter((e) => e.type === 'ai_pass_applied'), []);
});

test('HEALTHY: a rule that is genuinely new is still applied and still announced', async (t) => {
  const db = migratedTestDb();
  const env = withCredentials();
  t.after(() => { db.close(); env.restore(); });
  insertTransaction(db, { merchant_name: 'Qvist Nordheim', amount: -2500 });

  const events = collectEvents();
  await runAiJob(job({ writes: ['categorize_transaction', 'create_merchant_rule'] }), collecting([ruleProposal('Qvist Nordheim', 'cat_health')]), {
    db, trigger: 'after_sync', syncRunId: 'run_1', emit: events.emit,
  });

  const [row] = runRows(db);
  assert.equal(row.applied, 1);
  assert.equal(events.events.filter((e) => e.type === 'ai_pass_applied').length, 1);
});
