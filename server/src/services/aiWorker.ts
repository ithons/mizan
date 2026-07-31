import type Anthropic from '@anthropic-ai/sdk';
import type Database from 'better-sqlite3';
import { getDb } from '../db/index';
import { getAnthropicClient, readModelText } from './anthropicClient';
import { buildModelRequestShape } from './advisorSettings';
import { buildFinancialContext } from './aiContext';
import { getTransactionReviewSummary } from './transactionReview';
import type { AdvisorCitation, AdvisorDraftChange, AdvisorDraftPayload } from '../../../shared/types';
import { buildRecurringForecast } from './recurringForecast';
import { toDollars } from './money';
import { AiWorkerDraftSchema } from '../../../shared/schemas';
import { describeAutonomyForPrompt } from './draftAutonomy';
import {
  AI_JOBS,
  runAiJob,
  type AiJobCollect,
  type AiJobProposal,
  type AiJobRunOptions,
  type AiJobUsage,
} from './aiJobs';

// This file is now one job's body: gather the delta, ask the model, hand back proposals. What
// happens to those proposals belongs to the framework in aiJobs.ts and is the same for every job:
// the scope check against the job's declared `writes`, supersession, which kinds may apply
// unattended, the conservation guard around the whole batch, the run row, the client event.
//
// Which drafts apply unattended is decided by DRAFT_KIND_AUTONOMY (draftAutonomy.ts): a per-kind
// declaration with the argument attached, from which the autonomous set is derived. The sentence
// this prompt tells the model about that boundary is GENERATED from the same table, so the prompt,
// the structured-output schema and the enforced set cannot say three different things.

const JOB = AI_JOBS.background_review;

// ─── Output contract ─────────────────────────────────────────────────────────
// The worker used to ask for raw JSON in prose, strip a markdown fence defensively, and
// JSON.parse whatever came back. Structured outputs make the shape a request parameter the
// API enforces, so the fence never appears and the parse cannot fail on a malformed reply.
// The Zod schema behind it (AiWorkerDraftSchema) stays as defence in depth: this schema
// cannot express the cross-field rule that a draft's `kind` equals its `payload.kind`, and
// it is the payload that reaches a write path.
//
// Structured outputs restrict the schema: every object needs `additionalProperties: false`,
// no recursion, and no length/range keywords. `tests/aiRequestShape.test.ts` walks this
// object and asserts those constraints, because getting them wrong is a 400 on every run.

const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] } as const;

function draftPayloadVariant(
  kind: string,
  properties: Record<string, unknown>
): Record<string, unknown> {
  const withKind = { kind: { const: kind }, ...properties };
  return {
    type: 'object',
    properties: withKind,
    required: Object.keys(withKind),
    additionalProperties: false,
  };
}

// The kinds this job may emit, read from its declaration rather than restated. A kind added to
// the declaration also needs a payload variant below, or the model can name it and never produce
// a usable payload; `tests/aiJobs.test.ts` asserts the two lists agree.
const DRAFT_KINDS = JOB.writes;

export const WORKER_DRAFTS_FORMAT: Anthropic.JSONOutputFormat = {
  type: 'json_schema',
  schema: {
    type: 'object',
    properties: {
      drafts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: [...DRAFT_KINDS] },
            label: { type: 'string' },
            summary: { type: 'string' },
            route: { type: 'string' },
            payload: {
              anyOf: [
                draftPayloadVariant('categorize_transaction', {
                  transaction_id: { type: 'string' },
                  category_id: { type: 'string' },
                }),
                draftPayloadVariant('create_merchant_rule', {
                  pattern: { type: 'string' },
                  category_id: { type: 'string' },
                  apply_existing: { type: 'boolean' },
                }),
                draftPayloadVariant('retire_merchant_rule', {
                  rule_id: { type: 'string' },
                }),
                draftPayloadVariant('create_recurring_adjustment', {
                  recurring_id: { type: 'string' },
                  original_date: { type: 'string' },
                  action: { type: 'string', enum: ['skip', 'snooze', 'adjust'] },
                  adjusted_date: nullableString,
                  adjusted_amount: { anyOf: [{ type: 'number' }, { type: 'null' }] },
                  note: nullableString,
                }),
                draftPayloadVariant('update_budget', {
                  category_id: { type: 'string' },
                  amount: { type: 'number' },
                  period: { const: 'monthly' },
                  rollover: { type: 'boolean' },
                }),
                draftPayloadVariant('update_goal_target', {
                  goal_id: { type: 'string' },
                  target_amount: { type: 'number' },
                }),
              ],
            },
            changes: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  field: { type: 'string' },
                  before: {
                    anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }],
                  },
                  after: {
                    anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }],
                  },
                },
                required: ['field', 'before', 'after'],
                additionalProperties: false,
              },
            },
          },
          required: ['kind', 'label', 'summary', 'route', 'payload', 'changes'],
          additionalProperties: false,
        },
      },
    },
    required: ['drafts'],
    additionalProperties: false,
  },
};

// ─── What counts as this pass's delta ────────────────────────────────────────

/**
 * How far back a pass looks when `ai_runs` holds no earlier pass to measure against.
 *
 * A bound, not a measurement. It exists so the first pass after this ships reviews a day of a
 * database that may carry months, instead of all of it.
 */
const FIRST_PASS_LOOKBACK_HOURS = 24;

export interface DetectedChange {
  entity_type: string;
  description: string;
}

/**
 * When this job last looked, or `null` if it never has.
 *
 * 'failed' passes are excluded on purpose: a pass that read the delta and then lost the model call
 * did not review it, and treating it as a watermark would drop that delta permanently.
 * 'already_running' is excluded for the same reason, having never called the collector at all.
 */
function lastPassStartedAt(db: Database.Database, runId: string): string | null {
  const row = db
    .prepare(
      `SELECT MAX(started_at) AS at FROM ai_runs
        WHERE job = ? AND id <> ?
          AND (status = 'completed' OR skipped_reason = 'nothing_to_do')`
    )
    .get(JOB.name, runId) as { at: string | null };
  return row.at;
}

/**
 * The detections this pass has not already seen.
 *
 * `sync_changes` where `change_type = 'detected'` is not a delta. Every such row on the owner's
 * database is an integrity LEVEL report ("2 transfer pair(s) need review"), rewritten by every sync
 * for as long as that queue stays unreviewed, so an unwindowed `ORDER BY created_at DESC LIMIT 20`
 * returns the same standing backlog forever. Measured on a copy of .mizan/mizan.db, 2026-07-31:
 *   SELECT COUNT(*), MIN(created_at), MAX(created_at) FROM sync_changes
 *    WHERE change_type = 'detected';
 *     -> 135 rows, 2026-06-30T15:37Z to 2026-07-30T02:04Z, every one entity_type 'integrity'.
 * Nothing prunes them, so once the first detection existed the unwindowed query answered non-empty
 * for every later run: 105 of the 108 succeeded-or-partial runs in that copy started after
 * 2026-06-30T15:37Z. That is a paid model call an hour about a month-old delta.
 *
 * Two conditions make it a delta, and both are needed. Recency alone is not, because the integrity
 * stage rewrites the standing backlog on every run. Replaying the rule below over the same copy,
 * using each run's predecessor's `completed_at` as the watermark (a pass fires ~100ms after its
 * sync finalizes, so that is where its `started_at` lands):
 *   -> 11 of the 107 runs with a predecessor carried a detection whose exact text was not already
 *      on record. The other 96 restated a backlog a previous pass had already been shown.
 * This is about the detections leg only. The gate is an OR, and the recurring legs are left alone
 * deliberately: an overdue or adjusted recurring item is something this job's declared `writes` can
 * actually act on, where no draft kind it may emit addresses a transfer pair or a duplicate group.
 * On this database today that leg alone holds the gate open (one overdue pattern, 'mass inst
 * payroll ppd'), so a quiet pass is not yet the common case and nothing here should claim it is.
 */
export function newDetections(
  db: Database.Database,
  runId: string,
  startedAt: string
): DetectedChange[] {
  const since =
    lastPassStartedAt(db, runId) ??
    new Date(Date.parse(startedAt) - FIRST_PASS_LOOKBACK_HOURS * 3600_000).toISOString();

  return db
    .prepare(
      `SELECT entity_type, description, MAX(created_at) AS last_seen
         FROM sync_changes AS s
        WHERE s.change_type = 'detected'
          AND s.created_at > ?
          AND NOT EXISTS (
            SELECT 1 FROM sync_changes AS earlier
             WHERE earlier.change_type = 'detected'
               AND earlier.entity_type = s.entity_type
               AND earlier.description = s.description
               AND earlier.created_at <= ?
          )
        GROUP BY s.entity_type, s.description
        ORDER BY last_seen DESC
        LIMIT 20`
    )
    .all(since, since) as DetectedChange[];
}

/**
 * A prompt list, or an explicit statement that it is empty.
 *
 * An empty section renders as a heading followed by a blank line, which reads as an omission rather
 * than an absence. The ids in these sections are the ones the model must copy exactly, so a section
 * that looks truncated is an invitation to invent one.
 */
function listOrNone(lines: readonly string[]): string {
  return lines.length > 0 ? lines.join('\n') : '(none)';
}

// ─── The prompt ──────────────────────────────────────────────────────────────
//
// Section headings are constants because the id rule NAMES them. Written twice, the rule and the
// section it points at drift, and the failure mode of that drift is the one this whole file guards
// against: the rule said transaction ids come from "Uncategorized transactions", the section under
// that heading was empty on the owner's ledger (`SELECT COUNT(*) FROM transactions WHERE
// category_id IS NULL` is 0, measured on a copy of .mizan/mizan.db at migration 052 on 2026-07-31),
// and a second list of refilable rows sat below it that the rule did not admit. A model obeying the
// stated MUST could never refile; a model using the second list broke a MUST in the same prompt.

const SECTION = {
  categories: 'Valid categories',
  uncategorized: 'Uncategorized transactions',
  refilable: 'Already filed by a machine, and open to being refiled',
  ownRules: 'Merchant rules you wrote yourself',
  detections: 'System detections new since the last review pass',
} as const;

/**
 * The only statement in the prompt about where a transaction id may come from.
 *
 * Both lists, named together, in one sentence. Any second sentence that narrows this is a
 * contradiction rather than an emphasis, because the model cannot obey both.
 */
const ID_RULE =
  `THE ONE RULE ABOUT IDS. A 'categorize_transaction' payload's "transaction_id" MUST be copied exactly from the "id" field of a row listed under "${SECTION.uncategorized}" or under "${SECTION.refilable}" below. Those two lists together are every transaction you may name, and no other sentence here narrows that. Either list can be empty; an empty one reads "(none)", which means there are none, not that some were left out. "payload.category_id" MUST likewise be copied exactly from the "id" field of a row under "${SECTION.categories}", and a 'retire_merchant_rule' payload's "rule_id" from a row under "${SECTION.ownRules}". Never invent an id, and never put a display name where an id belongs: an id that does not match exactly will silently fail to apply.`;

/** A heading and its list, never a heading and a blank line. `note` carries its own leading space. */
function section(heading: string, note: string, lines: readonly string[]): string {
  return `${heading}${note}\n${listOrNone(lines)}`;
}

export interface PromptCategory {
  id: string;
  name: string;
}

export interface PromptTransaction {
  id: string;
  merchant_name: string | null;
  original_name: string;
  amount: number;
  date: string;
}

export interface PromptRefilableTransaction extends PromptTransaction {
  category_name: string;
  category_source: string;
}

export interface PromptRule {
  id: string;
  pattern: string;
  category_name: string | null;
}

export interface BackgroundReviewPromptInput {
  context: string;
  categories: readonly PromptCategory[];
  uncategorized: readonly PromptTransaction[];
  refilable: readonly PromptRefilableTransaction[];
  ownRules: readonly PromptRule[];
  /** Every uncategorized row, not just the ones listed. */
  uncategorizedTotal: number;
  adjustedRecurringCount: number;
  overdueRecurringCount: number;
  detections: readonly DetectedChange[];
}

function transactionLine(t: PromptTransaction): string {
  return `- id: "${t.id}", date: ${t.date}, amount: ${toDollars(t.amount)}, merchant: "${t.merchant_name || t.original_name}"`;
}

/**
 * The system prompt for one background review pass.
 *
 * Separated from the pass so it can be asserted on. The prompt is the interface to the model and
 * every rule in it is enforced by the model reading it rather than by any code here, which makes it
 * the one surface where two sentences can disagree and nothing fails.
 */
export function buildBackgroundReviewPrompt(input: BackgroundReviewPromptInput): string {
  return `You are Mizān's background AI co-pilot. Your job is to review the user's latest sync delta and generate proactive, actionable 1-click drafts.
Respond with an object of the form {"drafts": [ ... ]}, one entry per draft.
If there are no meaningful drafts to generate, return {"drafts": []}.

Allowed 'kind' values: ${DRAFT_KINDS.map((k) => `'${k}'`).join(', ')}.

${ID_RULE}

${describeAutonomyForPrompt(DRAFT_KINDS)} Categorization is reversible in one click and every row records that you set it, so prefer acting to hedging: a wrong category is cheap and visible. If a merchant is genuinely ambiguous, leave it uncategorized rather than guessing, because a wrong rule keeps applying itself to future transactions. 'create_merchant_rule' payloads must include "apply_existing": true.

A 'retire_merchant_rule' draft takes back one of YOUR OWN rules. It is refused unless the rule is yours and currently files zero transactions, so use it for a rule that sits live and inert because one of the user's own rules outranks it everywhere. Never propose retiring a rule to make room for a different one: create the replacement and let precedence decide.

Your context is:
${input.context}

${section(SECTION.categories, ' (use the "id" value for any category_id field, never the name):', input.categories.map((c) => `- id: "${c.id}", name: "${c.name}"`))}

${section(SECTION.uncategorized, ' (nothing has filed these yet):', input.uncategorized.map(transactionLine))}

${section(
  SECTION.refilable,
  ' if the category is plainly wrong. These are NOT uncategorized and most of them are fine: propose a \'categorize_transaction\' only where the merchant clearly contradicts the category it sits in. Rows the user categorized by hand, and rows you have already filed once, are not listed and are not yours to revisit.',
  input.refilable.map(
    (t) => `${transactionLine(t)}, currently: "${t.category_name}" (set by ${t.category_source})`
  )
)}

${section(SECTION.ownRules, ' (the only ones you may retire; the user\'s own rules are not listed and are refused):', input.ownRules.map((r) => `- id: "${r.id}", pattern: "${r.pattern}", category: "${r.category_name ?? 'a category that no longer exists'}"`))}

Review Summary:
${input.uncategorizedTotal} total uncategorized transactions (${input.uncategorized.length} shown above).
${input.adjustedRecurringCount} adjusted recurring items.
${input.overdueRecurringCount} overdue recurring items.

${section(SECTION.detections, ':', input.detections.map((d) => `- [${d.entity_type}] ${d.description}`))}

Every payload object MUST repeat "kind" inside it, identical to the draft's own top-level "kind". A draft whose payload.kind doesn't match its own kind is silently rejected.

Example format for each kind you're likely to use:
{
  "drafts": [
    {
      "kind": "categorize_transaction",
      "label": "Categorize Trupanion",
      "summary": "Trupanion (-$39.02) is pet insurance.",
      "route": "/transactions",
      "payload": { "kind": "categorize_transaction", "transaction_id": "<id copied from the lists above>", "category_id": "<id copied from the lists above>" },
      "changes": [{ "field": "category", "before": "Uncategorized", "after": "Health" }]
    },
    {
      "kind": "create_merchant_rule",
      "label": "Always categorize Trupanion as Health",
      "summary": "Auto-categorize future Trupanion charges as Health.",
      "route": "/transactions",
      "payload": { "kind": "create_merchant_rule", "pattern": "Trupanion", "category_id": "<id copied from the lists above>", "apply_existing": true },
      "changes": []
    }
  ]
}`;
}

function readUsage(response: Anthropic.Message): AiJobUsage {
  return {
    input_tokens: response.usage?.input_tokens ?? null,
    output_tokens: response.usage?.output_tokens ?? null,
    cache_read_tokens: response.usage?.cache_read_input_tokens ?? null,
    cache_write_tokens: response.usage?.cache_creation_input_tokens ?? null,
  };
}

/**
 * Rows a MACHINE filed that the model may refile.
 *
 * This is the widening, and its whole safety is in the WHERE clause, so read it before
 * changing it. Separated from the pass so the exclusions can be asserted without a model call.
 */
export function refilableTransactions(db: Database.Database): PromptRefilableTransaction[] {
  //   category_source IN ('rule','heuristic')  the two machine authors that are not this model.
  //     NULL is excluded and that is the load-bearing exclusion: migration 041 says NULL means the
  //     author was never recorded, not that a machine wrote it. On a copy of .mizan/mizan.db,
  //     2026-07-31, `SELECT COALESCE(category_source,'(null)'), COUNT(*) FROM transactions GROUP BY 1`
  //     returns (null) 2412, ai 86, human 62, heuristic 12, rule 7 of 2579 rows. Admitting NULL
  //     would hand the model 2,412 rows it has no evidence about; excluding it leaves 19.
  //     `SELECT COUNT(*) FROM transactions WHERE category_id IS NULL` is 0 on that same copy, which
  //     is why this widening exists at all: the uncategorized pool above is empty today.
  //   'ai' is excluded            the model's own settled answer. Re-proposing it every hour is how
  //     the rule path moved Spotify twice in two hours before `allowRecategorize: false`.
  //   'human' and manually_categorized  never, on either marker, since either can be cleared alone.
  //
  // ONE ANSWER PER ROW, EVER, which is what the NOT EXISTS below buys. Reading category_source
  // alone is not enough, because two ordinary owner actions put the model's own answer back into
  // this pool wearing a machine's label:
  //   "Re-check all transactions" (recategorizeAll in rules.ts) skips only hand-categorized rows,
  //     so it rewrites the model's row to the rule's category with category_source = 'rule'.
  //   Undo (undoAdvisorAction) restores the prior category AND its prior source, which for a
  //     refiled row is 'rule'.
  // Under category_source alone both hand the row straight back and the next pass refiles it, so
  // the owner's deliberate action is reversed within the hour by a write they did not ask for. The
  // revision log is the durable record that the model has had its say here: once a row carries a
  // category revision the model wrote, it never re-enters this pool, whatever later moved it. The
  // owner's re-check wins and keeps winning; the row stays reachable by hand and through chat.
  // On the owner's ledger today the clause removes nothing: the unlimited pool is 19 rows with it
  // and 19 without, because no row there carries an AI revision and a machine label at once. It is
  // a bound on a loop that has not run yet, not a repair of one that has.
  return db.prepare(`
    SELECT t.id, t.merchant_name, t.original_name, t.amount, t.date,
           t.category_id, c.name AS category_name, t.category_source
    FROM transactions t
    JOIN categories c ON c.id = t.category_id
    WHERE t.pending = 0
      AND t.manually_categorized = 0
      AND t.category_source IN ('rule', 'heuristic')
      AND NOT EXISTS (
        SELECT 1 FROM transaction_category_revisions r
         WHERE r.transaction_id = t.id AND r.to_source = 'ai'
      )
    ORDER BY t.date DESC
    LIMIT 15
  `).all() as PromptRefilableTransaction[];
}

/**
 * One background review pass, up to the point where something would be written.
 *
 * Returns proposals rather than writing them: `writes` is only enforceable if the job cannot
 * reach a write path itself.
 */
export const collectBackgroundReview: AiJobCollect = async ({ db, runId, startedAt }) => {
  // One retry, not the SDK's two, because the framework's per-job re-entrancy guard turns a hung
  // request into every later review pass being skipped for as long as it lasts. Two attempts at
  // five minutes bounds that at ten, well inside the hourly sync cadence that fires this.
  const anthropic = getAnthropicClient({ maxRetries: 1 });
  if (!anthropic) {
    // runAiJob checks the same credentials before starting a pass, so this is unreachable rather
    // than a fallback. Thrown, not returned quietly: a pass that produced nothing because the
    // client vanished mid-flight must not read like a pass that had nothing to suggest.
    throw new Error('No Anthropic client available after the pass had already started.');
  }

  const reviewSummary = getTransactionReviewSummary(db);
  const forecast = buildRecurringForecast(db, 60);
  const context = buildFinancialContext();

  // Find interesting deltas for the AI to review
  // 1. Uncategorized transactions. The model can only draft a categorize_transaction
  // action for a transaction it's actually been given the real id of. Without this it
  // was hallucinating fake transaction ids and human-readable category names instead
  // of real category_id values, so every such draft failed to apply.
  const uncategorizedTransactions = db.prepare(`
    SELECT id, merchant_name, original_name, amount, date
    FROM transactions
    -- Matches transactionReview.ts getCounts(): 'reviewed' is set as a side effect of
    -- categorization, so gating on 'open' hid the whole imported backlog from the worker.
    WHERE category_id IS NULL AND pending = 0 AND review_status <> 'dismissed'
    ORDER BY date DESC
    LIMIT 15
  `).all() as PromptTransaction[];
  const uncategorizedCount = reviewSummary.queues.find(q => q.id === 'uncategorized')?.count ?? 0;

  // 1b. Rows a MACHINE filed that the model may refile. See refilableTransactions.
  const recategorizable = refilableTransactions(db);

  // 1c. The model's OWN live rules, so it can name one to retire. Owner rules are deliberately
  // absent: `checkRuleIsRetirableByAi` refuses them, and listing what will be refused invites the
  // proposal it refuses.
  const ownRules = db.prepare(`
    SELECT r.id, r.pattern, c.name AS category_name
    FROM merchant_rules r
    LEFT JOIN categories c ON c.id = r.category_id
    WHERE r.retired_at IS NULL AND r.source = 'ai'
    ORDER BY r.created_at DESC
    LIMIT 25
  `).all() as PromptRule[];

  const categories = db.prepare(`
    SELECT id, name FROM categories ORDER BY sort_order
  `).all() as PromptCategory[];

  // 2. Adjusted or overdue recurring items
  const adjustedRecurring = forecast.occurrences.filter(o => o.adjustment_action != null);
  const overdueRecurring = forecast.occurrences.filter(o => o.status === 'overdue');

  // 3. Sync detections this pass has not already seen. See newDetections: the raw table is a
  // standing backlog restated hourly, and gating on it unwindowed bought a model call every hour
  // about a delta a month old.
  const freshDetects = newDetections(db, runId, startedAt);

  if (
    uncategorizedTransactions.length === 0
    && recategorizable.length === 0
    && ownRules.length === 0
    && adjustedRecurring.length === 0
    && overdueRecurring.length === 0
    && freshDetects.length === 0
  ) {
    return {
      status: 'nothing_to_do',
      detail: 'no transactions to file or refile, no rules of its own to review, no adjusted or overdue recurring items, no new detections',
    };
  }

  const systemPrompt = buildBackgroundReviewPrompt({
    context,
    categories,
    uncategorized: uncategorizedTransactions,
    refilable: recategorizable,
    ownRules,
    uncategorizedTotal: uncategorizedCount,
    adjustedRecurringCount: adjustedRecurring.length,
    overdueRecurringCount: overdueRecurring.length,
    detections: freshDetects,
  });

  // Deliberately no cache_control on this prompt. Its prefix is unstable by construction:
  // buildFinancialContext() opens with today's date and interpolates the last successful
  // sync timestamp, rewritten by the very sync that fires this worker, before 15 volatile
  // transactions and 20 sync changes. Every call would write a fresh entry at 1.25× and read
  // none back, and the hourly cadence outruns the 5-minute TTL regardless.
  const response = await anthropic.messages.create({
    model: JOB.model,
    // Thinking counts against this, and adaptive thinking would spend most of the previous
    // 4096 before writing a single draft. 16000 is not a measured figure: no token count was
    // taken for a pass. It is a deliberately generous ceiling, set so that truncation cannot
    // be the failure mode, which is why hitting it is warned about below rather than expected.
    max_tokens: 16000,
    system: systemPrompt,
    messages: [{ role: 'user', content: 'Generate proactive drafts based on the latest sync state.' }],
    // No sampling parameter: a temperature is a 400 on this model. Every optional parameter
    // here is derived from the model rather than assumed, so retiering this job cannot send
    // a shape the new model rejects.
    ...buildModelRequestShape(JOB.model, { effort: JOB.effort, outputFormat: WORKER_DRAFTS_FORMAT }),
  });

  if (response.stop_reason === 'max_tokens') {
    console.warn('[ai-worker] Model response hit max_tokens; draft JSON is likely truncated and may fail to parse.');
  }

  // readModelText raises on a refusal or a response carrying no text, so neither can pass
  // through here looking like "the model had nothing to suggest".
  const text = readModelText(response).trim();
  let drafts: unknown[];
  try {
    const parsed = JSON.parse(text) as { drafts?: unknown };
    if (!Array.isArray(parsed?.drafts)) {
      throw new Error(`expected {"drafts": [...]}, got ${typeof parsed}`);
    }
    drafts = parsed.drafts;
  } catch (parseError) {
    // Unreachable while the structured-output contract holds; kept because the contract is
    // a request parameter and a stripped or rejected one would otherwise fail silently.
    throw new Error(`[ai-worker] Model response did not match the draft output contract: ${(parseError as Error).message}`);
  }

  // Trust boundary: these came straight from the model. Validate each against the strict schema
  // before any of it is treated as a proposal.
  const proposals: AiJobProposal[] = [];
  let malformed = 0;
  for (const rawDraft of drafts) {
    const parsed = AiWorkerDraftSchema.safeParse(rawDraft);
    if (!parsed.success) {
      malformed++;
      console.warn('[ai-worker] Rejected malformed draft:', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      continue;
    }
    const payload = parsed.data.payload as AdvisorDraftPayload;
    proposals.push({
      kind: payload.kind,
      label: parsed.data.label,
      summary: parsed.data.summary,
      route: parsed.data.route || '/review',
      payload,
      changes: parsed.data.changes as AdvisorDraftChange[],
      citations: parsed.data.citations as AdvisorCitation[],
    });
  }

  return { status: 'collected', proposals, malformed, usage: readUsage(response) };
};

/**
 * Run a background review pass directly.
 *
 * The scheduler calls `runAiJob` itself with the sync's run id and event emitter; this is the
 * entry for a pass fired outside a sync, and it returns nothing because there is nowhere for an
 * outcome to go on that path. Failures are recorded on the run row and logged by the framework.
 */
export async function runBackgroundAiReview(
  options: Partial<AiJobRunOptions> = {}
): Promise<void> {
  await runAiJob(JOB, collectBackgroundReview, {
    ...options,
    db: options.db ?? getDb(),
    trigger: options.trigger ?? 'on_demand',
  });
}
