import type Anthropic from '@anthropic-ai/sdk';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/index';
import { getAnthropicClient, readModelText } from './anthropicClient';
import { JOB_MODELS, buildModelRequestShape } from './advisorSettings';
import { buildFinancialContext } from './aiContext';
import { getTransactionReviewSummary } from './transactionReview';
import type { AdvisorDraftAction, AdvisorDraftPayload, AdvisorCitation, AdvisorDraftChange } from '../../../shared/types';
import { buildRecurringForecast } from './recurringForecast';
import { confirmAdvisorDraft, isAutonomousDraftKind } from './advisorDrafts';
import { DraftRefusedError } from './aiWriteGuards';
import { toDollars } from './money';
import { AiWorkerDraftSchema } from '../../../shared/schemas';

// Which drafts apply unattended is decided by AUTONOMOUS_DRAFT_KINDS (advisorDrafts.ts): a
// domain boundary the owner set, not a confidence score the model reported about itself.
// Categorization and merchant rules apply on arrival; everything that changes a target the
// owner set waits in the review queue.

// Stable identity for the entity a draft acts on. Two drafts with the same key are
// two suggestions about the same thing, so a fresh pass supersedes the old one; a
// draft whose key the fresh pass does not regenerate is left in place (still pending
// the user's review) rather than blanket-deleted.
function draftTargetKey(payload: AdvisorDraftPayload): string {
  switch (payload.kind) {
    case 'create_merchant_rule': return `create_merchant_rule:${payload.pattern}`;
    case 'categorize_transaction': return `categorize_transaction:${payload.transaction_id}`;
    case 'update_budget': return `update_budget:${payload.category_id}`;
    case 'update_goal_target': return `update_goal_target:${payload.goal_id}`;
    case 'confirm_recurring': return `confirm_recurring:${payload.recurring_id}`;
    case 'create_budget_group': return `create_budget_group:${payload.name}`;
    case 'rename_budget_group': return `rename_budget_group:${payload.group_id}`;
    case 'assign_category_to_budget_group': return `assign_category_to_budget_group:${payload.group_id}:${payload.category_id}`;
    case 'create_recurring_adjustment': return `create_recurring_adjustment:${payload.recurring_id}:${payload.original_date}`;
    case 'set_manual_cost_basis': return `set_manual_cost_basis:${payload.holding_id}`;
    case 'set_sector_metadata': return `set_sector_metadata:${payload.security_id}`;
    default: return (payload as { kind: string }).kind;
  }
}

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

// Mirrors the 'Allowed kind values' list in the system prompt below. A kind the prompt
// permits but this schema omits is a kind the model cannot emit at all.
const DRAFT_KINDS = [
  'categorize_transaction',
  'create_merchant_rule',
  'create_recurring_adjustment',
  'update_budget',
  'update_goal_target',
  'create_budget_group',
] as const;

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
                draftPayloadVariant('create_budget_group', {
                  name: { type: 'string' },
                  color: nullableString,
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

// Re-entrancy guard: the worker is fired via setTimeout after every sync, and it awaits a
// slow LLM call, so two passes could otherwise overlap (rapid syncs) and double-apply or
// race each other's draft supersession. Only one pass runs at a time.
let workerRunning = false;

export async function runBackgroundAiReview(): Promise<void> {
  // One retry, not the SDK's two, because `workerRunning` below turns a hung request into
  // every later review pass being skipped for as long as it lasts. Two attempts at five
  // minutes bounds that at ten, well inside the hourly sync cadence that fires this.
  const anthropic = getAnthropicClient({ maxRetries: 1 });
  if (!anthropic) {
    console.log('[ai-worker] Skipped: no Anthropic credentials configured (API key, auth token, or `ant auth login` profile).');
    return;
  }
  if (workerRunning) {
    console.log('[ai-worker] Skipped: a review pass is already running.');
    return;
  }
  workerRunning = true;

  const db = getDb();
  console.log('[ai-worker] Starting background AI review pass...');

  try {
    const reviewSummary = getTransactionReviewSummary(db);
    const forecast = buildRecurringForecast(db, 60);
    const context = buildFinancialContext();

    // Find interesting deltas for the AI to review
    // 1. Uncategorized transactions. The model can only draft a categorize_transaction
    // action for a transaction it's actually been given the real id of — without this it
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
    `).all() as Array<{ id: string; merchant_name: string | null; original_name: string; amount: number; date: string }>;
    const uncategorizedCount = reviewSummary.queues.find(q => q.id === 'uncategorized')?.count ?? 0;

    const categories = db.prepare(`
      SELECT id, name FROM categories ORDER BY sort_order
    `).all() as Array<{ id: string; name: string }>;

    // 2. Adjusted or overdue recurring items
    const adjustedRecurring = forecast.occurrences.filter(o => o.adjustment_action != null);
    const overdueRecurring = forecast.occurrences.filter(o => o.status === 'overdue');

    // 3. Any sync changes marked as 'detected'
    const recentDetects = db.prepare(`
      SELECT entity_type, description 
      FROM sync_changes 
      WHERE change_type = 'detected'
      ORDER BY created_at DESC 
      LIMIT 20
    `).all() as Array<{ entity_type: string, description: string }>;

    if (uncategorizedTransactions.length === 0 && adjustedRecurring.length === 0 && overdueRecurring.length === 0 && recentDetects.length === 0) {
      console.log('[ai-worker] Nothing urgent to review. Exiting.');
      return;
    }

    const systemPrompt = `You are Mizān's background AI co-pilot. Your job is to review the user's latest sync delta and generate proactive, actionable 1-click drafts.
Respond with an object of the form {"drafts": [ ... ]}, one entry per draft.
If there are no meaningful drafts to generate, return {"drafts": []}.

Allowed 'kind' values: ${DRAFT_KINDS.map((k) => `'${k}'`).join(', ')}.

For a 'categorize_transaction' draft, "payload.transaction_id" MUST be copied exactly from the "id" field of one of the transactions listed under "Uncategorized transactions" below, and "payload.category_id" MUST be copied exactly from the "id" field of one of the categories listed under "Valid categories" below. Never invent a transaction id or use a category's display name in place of its id — an id that doesn't match exactly will silently fail to apply.

'categorize_transaction' and 'create_merchant_rule' drafts are APPLIED IMMEDIATELY, with no human review. Every other kind waits for the user to confirm it. Categorization is reversible in one click and every row records that you set it, so prefer acting to hedging: a wrong category is cheap and visible. If a merchant is genuinely ambiguous, leave it uncategorized rather than guessing, because a wrong rule keeps applying itself to future transactions. 'create_merchant_rule' payloads must include "apply_existing": true.

Your context is:
${context}

Valid categories (use the "id" value for any category_id field, never the name):
${categories.map(c => `- id: "${c.id}", name: "${c.name}"`).join('\n')}

Uncategorized transactions (use the "id" value for any transaction_id field):
${uncategorizedTransactions.map(t => `- id: "${t.id}", date: ${t.date}, amount: ${toDollars(t.amount)}, merchant: "${t.merchant_name || t.original_name}"`).join('\n')}

Review Summary:
${uncategorizedCount} total uncategorized transactions (${uncategorizedTransactions.length} shown above).
${adjustedRecurring.length} adjusted recurring items.
${overdueRecurring.length} overdue recurring items.

Recent System Detections:
${recentDetects.map(d => `- [${d.entity_type}] ${d.description}`).join('\n')}

Every payload object MUST repeat "kind" inside it, identical to the draft's own top-level "kind" — a draft whose payload.kind doesn't match its own kind is silently rejected.

Example format for each kind you're likely to use:
{
  "drafts": [
    {
      "kind": "categorize_transaction",
      "label": "Categorize Trupanion",
      "summary": "Trupanion (-$39.02) is pet insurance.",
      "route": "/transactions",
      "payload": { "kind": "categorize_transaction", "transaction_id": "<id copied from the list above>", "category_id": "<id copied from the list above>" },
      "changes": [{ "field": "category", "before": "Uncategorized", "after": "Health" }]
    },
    {
      "kind": "create_merchant_rule",
      "label": "Always categorize Trupanion as Health",
      "summary": "Auto-categorize future Trupanion charges as Health.",
      "route": "/transactions",
      "payload": { "kind": "create_merchant_rule", "pattern": "Trupanion", "category_id": "<id copied from the list above>", "apply_existing": true },
      "changes": []
    }
  ]
}`;

    // Deliberately no cache_control on this prompt. Its prefix is unstable by construction:
    // buildFinancialContext() opens with today's date and interpolates the last successful
    // sync timestamp, rewritten by the very sync that fires this worker, before 15 volatile
    // transactions and 20 sync changes. Every call would write a fresh entry at 1.25× and read
    // none back, and the hourly cadence outruns the 5-minute TTL regardless.
    const job = JOB_MODELS.background_review;
    const response = await anthropic.messages.create({
      model: job.model,
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
      ...buildModelRequestShape(job.model, { effort: job.effort, outputFormat: WORKER_DRAFTS_FORMAT }),
    });

    if (response.stop_reason === 'max_tokens') {
      console.warn('[ai-worker] Model response hit max_tokens; draft JSON is likely truncated and may fail to parse.');
    }

    // readModelText raises on a refusal or a response carrying no text, so neither can pass
    // through here looking like "the model had nothing to suggest". The outer catch logs it.
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

    if (drafts.length === 0) {
      console.log('[ai-worker] No drafts generated.');
      return;
    }

    const now = new Date().toISOString();
    let inserted = 0;
    let autoApplied = 0;
    let rejected = 0;
    let refused = 0;

    const insertDraft = db.prepare(`
      INSERT INTO advisor_drafts (id, kind, label, summary, route, payload, changes, citations, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    db.transaction(() => {
      // Trust boundary: drafts came straight from the model as raw JSON. Validate
      // each against the strict schema up front, so we also know which entities this
      // pass covers before deciding what to supersede.
      const validated: Array<ReturnType<typeof AiWorkerDraftSchema.parse>> = [];
      for (const rawDraft of drafts) {
        const parsed = AiWorkerDraftSchema.safeParse(rawDraft);
        if (!parsed.success) {
          rejected++;
          console.warn('[ai-worker] Rejected malformed draft:', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
          continue;
        }
        validated.push(parsed.data);
      }

      // Supersede only the open drafts this pass regenerates (same target entity).
      // Open drafts for entities the fresh pass no longer surfaces are left in place
      // so the user's un-acted-on review queue isn't silently wiped every sync.
      const freshKeys = new Set(validated.map((d) => draftTargetKey(d.payload as AdvisorDraftPayload)));
      const openRows = db.prepare(`SELECT id, payload FROM advisor_drafts WHERE status = 'open'`).all() as Array<{ id: string; payload: string }>;
      const deleteDraft = db.prepare(`DELETE FROM advisor_drafts WHERE id = ?`);
      for (const row of openRows) {
        try {
          const payload = JSON.parse(row.payload) as AdvisorDraftPayload;
          if (freshKeys.has(draftTargetKey(payload))) deleteDraft.run(row.id);
        } catch {
          // Leave rows with unparseable payloads untouched.
        }
      }

      for (const draft of validated) {
        const id = uuidv4();
        const changes: AdvisorDraftChange[] = draft.changes;
        const citations: AdvisorCitation[] = draft.citations as AdvisorCitation[];
        const route = draft.route || '/review';
        let status: 'open' | 'confirmed' = 'open';

        if (isAutonomousDraftKind(draft.kind)) {
          const action: AdvisorDraftAction = {
            id,
            kind: draft.kind as AdvisorDraftAction['kind'],
            label: draft.label,
            summary: draft.summary,
            route,
            payload: draft.payload as AdvisorDraftPayload,
            changes,
            citations,
            confirmation_required: true,
          };
          try {
            confirmAdvisorDraft(db, action, true, 'worker_auto');
            status = 'confirmed';
            autoApplied++;
          } catch (err) {
            if (err instanceof DraftRefusedError) {
              // Policy, not failure: the guards read the owner's own rules and history and said no.
              // The draft stays open and the review queue still offers it, deliberately. The guards
              // have measured false positives, so hiding a suggestion because they would refuse it
              // buries a legitimate proposal with no reason and no way to see it. Refusing on click,
              // with the reason, is the visible version of the same decision.
              refused++;
              console.log(`[ai-worker] Guards refused draft ${id} (${err.reason}): ${err.detail}`);
            } else {
              console.error(`[ai-worker] Auto-apply failed for draft ${id}, leaving it for manual review:`, err);
            }
          }
        }

        insertDraft.run(
          id,
          draft.kind,
          draft.label,
          draft.summary,
          route,
          JSON.stringify(draft.payload),
          JSON.stringify(changes),
          JSON.stringify(citations),
          status,
          now,
          now
        );
        inserted++;
      }
    })();

    console.log(`[ai-worker] Generated and saved ${inserted} proactive drafts (${autoApplied} auto-applied${refused ? `, ${refused} refused by guards` : ''}${rejected ? `, ${rejected} rejected as malformed` : ''}).`);

  } catch (err) {
    console.error('[ai-worker] Error running background AI review:', err);
  } finally {
    workerRunning = false;
  }
}
