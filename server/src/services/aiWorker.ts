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

// categorize_transaction / create_merchant_rule drafts at or above this confidence
// auto-apply without a manual review step; anything lower stays in the normal
// 'open' review queue. Gated by the Settings toggle (preference below); defaults
// on because that was the behavior before the toggle existed.
const AUTO_APPLY_CONFIDENCE_THRESHOLD = 0.9;
const AUTO_APPLIABLE_KINDS = new Set(['categorize_transaction', 'create_merchant_rule']);
export const AUTO_APPLY_PREFERENCE_KEY = 'advisor_auto_apply_high_confidence';

function getClient(): Anthropic | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  return new Anthropic({ apiKey });
}

export async function runBackgroundAiReview(): Promise<void> {
  const anthropic = getClient();
  if (!anthropic) {
    console.log('[ai-worker] Skipped: ANTHROPIC_API_KEY is not configured');
    return;
  }

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
      WHERE category_id IS NULL AND pending = 0 AND review_status = 'open'
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

    // 3. Taxable income that hasn't been handled yet
    // For simplicity, find recent positive transactions in taxable categories
    const estimatedTaxRatePref = getPreference(db, 'estimated_tax_rate');
    const estimatedTaxRate = typeof estimatedTaxRatePref?.value === 'number' ? estimatedTaxRatePref.value : 0;
    const taxGoal = db.prepare(`SELECT id, name FROM goals WHERE type = 'savings' AND name LIKE '%tax%' AND is_archived = 0 LIMIT 1`).get() as { id: string, name: string } | undefined;

    const recentTaxableIncome = db.prepare(`
      SELECT t.id, t.merchant_name, t.original_name, t.amount, t.date, c.name as category_name
      FROM transactions t
      JOIN categories c ON c.id = t.category_id
      WHERE c.taxable = 1 AND t.amount > 0 AND t.created_at >= datetime('now', '-7 days')
      ORDER BY t.date DESC
      LIMIT 10
    `).all() as Array<{ id: string, merchant_name: string, original_name: string, amount: number, date: string, category_name: string }>;

    // 4. Any sync changes marked as 'detected'
    const recentDetects = db.prepare(`
      SELECT entity_type, description 
      FROM sync_changes 
      WHERE change_type = 'detected'
      ORDER BY created_at DESC 
      LIMIT 20
    `).all() as Array<{ entity_type: string, description: string }>;

    if (uncategorizedTransactions.length === 0 && adjustedRecurring.length === 0 && overdueRecurring.length === 0 && recentDetects.length === 0 && recentTaxableIncome.length === 0) {
      console.log('[ai-worker] Nothing urgent to review. Exiting.');
      return;
    }

    const systemPrompt = `You are Mizān's background AI co-pilot. Your job is to review the user's latest sync delta and generate proactive, actionable 1-click drafts.
You must output a JSON array of draft objects. Return ONLY valid JSON, with no markdown code fences and no conversational text before or after it.
If there are no meaningful drafts to generate, return an empty array [].

Allowed 'kind' values: 'categorize_transaction', 'create_merchant_rule', 'create_recurring_adjustment', 'update_budget', 'update_goal_target', 'allocate_goal_funds', 'create_goal', 'create_budget_group'.

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

Taxable Income detected (past 7 days):
Estimated tax rate: ${estimatedTaxRate}%
Tax Liability Goal ID: ${taxGoal?.id || 'none'} (${taxGoal?.name || 'none'})
${recentTaxableIncome.map(t => `- $${t.amount.toFixed(2)} on ${t.date} from ${t.merchant_name || t.original_name} (${t.category_name})`).join('\n')}

Rules for Tax Withholding:
* If you see taxable income and there is a Tax Liability goal, generate an "allocate_goal_funds" draft to set aside ${estimatedTaxRate}% of the new income.
* If there is no Tax Liability goal, generate a "create_goal" draft to create a savings goal named "Tax Liability" with an initial target amount equal to the estimated tax for this income.

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
  },
  {
    "kind": "allocate_goal_funds",
    "label": "Withhold taxes for freelance income",
    "summary": "You received $5,000 from Upwork. Move $1,500 (30%) to your Tax Liability envelope to keep it out of Safe to Spend.",
    "route": "/goals",
    "payload": { "kind": "allocate_goal_funds", "goal_id": "goal_123", "amount_to_add": 1500 },
    "changes": [{ "field": "tax envelope", "before": 0, "after": 1500 }],
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

    const rawText = response.content[0].type === 'text' ? response.content[0].text : '';
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

    const insertDraft = db.prepare(`
      INSERT INTO advisor_drafts (id, kind, label, summary, route, payload, changes, citations, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const autoApplyPref = getPreference(db, AUTO_APPLY_PREFERENCE_KEY);
    const autoApplyEnabled = autoApplyPref ? autoApplyPref.value === true : true;

    db.transaction(() => {
      // Clear out any stale 'open' drafts that the AI is effectively replacing
      db.prepare(`DELETE FROM advisor_drafts WHERE status = 'open'`).run();

      for (const draft of drafts) {
        if (!draft.kind || !draft.label || !draft.summary || !draft.payload) continue;

        const id = uuidv4();
        const changes: AdvisorDraftChange[] = draft.changes || [];
        const citations: AdvisorCitation[] = draft.citations || [];
        let status: 'open' | 'confirmed' = 'open';

        const canAutoApply =
          autoApplyEnabled &&
          AUTO_APPLIABLE_KINDS.has(draft.kind) &&
          draft.payload.kind === draft.kind &&
          typeof draft.confidence === 'number' &&
          draft.confidence >= AUTO_APPLY_CONFIDENCE_THRESHOLD;

        if (canAutoApply) {
          const action: AdvisorDraftAction = {
            id,
            kind: draft.kind,
            label: draft.label,
            summary: draft.summary,
            route: draft.route || '/review',
            payload: draft.payload as AdvisorDraftPayload,
            changes,
            citations,
            confirmation_required: true,
          };
          try {
            confirmAdvisorDraft(db, action, true);
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
          draft.route || '/review',
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

    console.log(`[ai-worker] Generated and saved ${inserted} proactive drafts (${autoApplied} auto-applied).`);

  } catch (err) {
    console.error('[ai-worker] Error running background AI review:', err);
  }
}
