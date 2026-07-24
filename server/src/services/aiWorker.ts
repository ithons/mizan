import { v4 as uuidv4 } from 'uuid';
import Anthropic from '@anthropic-ai/sdk';
import { getDb } from '../db/index';
import { buildFinancialContext } from './aiContext';
import { getTransactionReviewSummary } from './transactionReview';
import type { AdvisorDraftAction, AdvisorDraftPayload, AdvisorCitation, AdvisorDraftChange } from '../../../shared/types';
import { buildRecurringForecast } from './recurringForecast';
import { getPreference } from './preferences';
import { confirmAdvisorDraft } from './advisorDrafts';
import { toDollars } from './money';
import { AiWorkerDraftSchema } from '../../../shared/schemas';

// categorize_transaction / create_merchant_rule drafts at or above this confidence
// auto-apply without a manual review step; anything lower stays in the normal
// 'open' review queue. Gated by the Settings toggle (preference below); defaults
// on because that was the behavior before the toggle existed.
const AUTO_APPLY_CONFIDENCE_THRESHOLD = 0.9;
const AUTO_APPLIABLE_KINDS = new Set(['categorize_transaction', 'create_merchant_rule']);
export const AUTO_APPLY_PREFERENCE_KEY = 'advisor_auto_apply_high_confidence';

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

function getClient(): Anthropic | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  return new Anthropic({ apiKey });
}

// Re-entrancy guard: the worker is fired via setTimeout after every sync, and it awaits a
// slow LLM call, so two passes could otherwise overlap (rapid syncs) and double-apply or
// race each other's draft supersession. Only one pass runs at a time.
let workerRunning = false;

export async function runBackgroundAiReview(): Promise<void> {
  const anthropic = getClient();
  if (!anthropic) {
    console.log('[ai-worker] Skipped: ANTHROPIC_API_KEY is not configured');
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
You must output a JSON array of draft objects. Return ONLY valid JSON, with no markdown code fences and no conversational text before or after it.
If there are no meaningful drafts to generate, return an empty array [].

Allowed 'kind' values: 'categorize_transaction', 'create_merchant_rule', 'create_recurring_adjustment', 'update_budget', 'update_goal_target', 'create_budget_group'.

For a 'categorize_transaction' draft, "payload.transaction_id" MUST be copied exactly from the "id" field of one of the transactions listed under "Uncategorized transactions" below, and "payload.category_id" MUST be copied exactly from the "id" field of one of the categories listed under "Valid categories" below. Never invent a transaction id or use a category's display name in place of its id — an id that doesn't match exactly will silently fail to apply.

For 'categorize_transaction' and 'create_merchant_rule' drafts only, also include a top-level "confidence" field (a number from 0 to 1) reflecting how certain you are the category is correct given the merchant name and transaction history. Only use confidence >= 0.9 when the merchant is unambiguous (e.g. a well-known chain with a single obvious category); use a lower value whenever the merchant name is generic, ambiguous, or you're guessing. High-confidence drafts of these two kinds are applied automatically without human review, so err toward a lower score when unsure. 'create_merchant_rule' payloads must include "apply_existing": true.

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

Example JSON format for each kind you're likely to use:
[
  {
    "kind": "categorize_transaction",
    "label": "Categorize Trupanion",
    "summary": "Trupanion (-$39.02) is pet insurance.",
    "route": "/transactions",
    "payload": { "kind": "categorize_transaction", "transaction_id": "<id copied from the list above>", "category_id": "<id copied from the list above>" },
    "confidence": 0.95,
    "changes": [{ "field": "category", "before": "Uncategorized", "after": "Health" }],
    "citations": []
  },
  {
    "kind": "create_merchant_rule",
    "label": "Always categorize Trupanion as Health",
    "summary": "Auto-categorize future Trupanion charges as Health.",
    "route": "/transactions",
    "payload": { "kind": "create_merchant_rule", "pattern": "Trupanion", "category_id": "<id copied from the list above>", "apply_existing": true },
    "confidence": 0.95,
    "changes": [],
    "citations": []
  }
]`;

    // Let's ask the LLM for suggestions
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      // Up to 15 categorize_transaction drafts plus other draft kinds can exceed 1024
      // tokens and get cut off mid-JSON (observed: a real run truncated mid-object).
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: 'Generate proactive drafts based on the latest sync state.' }],
      temperature: 0.1,
    });

    if (response.stop_reason === 'max_tokens') {
      console.warn('[ai-worker] Model response hit max_tokens; draft JSON is likely truncated and may fail to parse.');
    }
    const firstBlock = response.content[0];
    const rawText = firstBlock && firstBlock.type === 'text' ? firstBlock.text : '';
    if (!rawText) {
      console.warn('[ai-worker] Model returned no usable text content (empty or non-text); skipping this pass.');
      return;
    }
    // The model is instructed to return raw JSON, but strip a ```/```json fence
    // defensively in case it wraps the response anyway.
    const text = rawText.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    let drafts: any[] = [];
    try {
      drafts = JSON.parse(text);
    } catch (parseError) {
      console.error('[ai-worker] Failed to parse AI JSON response:', rawText);
      return;
    }

    if (!Array.isArray(drafts) || drafts.length === 0) {
      console.log('[ai-worker] No drafts generated.');
      return;
    }

    const now = new Date().toISOString();
    let inserted = 0;
    let autoApplied = 0;
    let rejected = 0;

    const insertDraft = db.prepare(`
      INSERT INTO advisor_drafts (id, kind, label, summary, route, payload, changes, citations, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const autoApplyPref = getPreference(db, AUTO_APPLY_PREFERENCE_KEY);
    const autoApplyEnabled = autoApplyPref ? autoApplyPref.value === true : true;

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

        const canAutoApply =
          autoApplyEnabled &&
          AUTO_APPLIABLE_KINDS.has(draft.kind) &&
          typeof draft.confidence === 'number' &&
          draft.confidence >= AUTO_APPLY_CONFIDENCE_THRESHOLD;

        if (canAutoApply) {
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
            console.error(`[ai-worker] Auto-apply failed for draft ${id}, leaving it for manual review:`, err);
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

    console.log(`[ai-worker] Generated and saved ${inserted} proactive drafts (${autoApplied} auto-applied${rejected ? `, ${rejected} rejected as malformed` : ''}).`);

  } catch (err) {
    console.error('[ai-worker] Error running background AI review:', err);
  } finally {
    workerRunning = false;
  }
}
