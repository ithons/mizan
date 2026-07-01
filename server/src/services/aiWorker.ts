import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import Anthropic from '@anthropic-ai/sdk';
import { getDb } from '../db/index';
import { buildFinancialContext } from './aiContext';
import { getTransactionReviewSummary } from './transactionReview';
import type { AdvisorDraftAction, AdvisorDraftPayload, AdvisorCitation, AdvisorDraftChange } from '../../../shared/types';
import { buildRecurringForecast } from './recurringForecast';
import { getPreference } from './preferences';

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
    // 1. Uncategorized transactions
    const uncategorizedCount = reviewSummary.queues.find(q => q.id === 'uncategorized')?.count ?? 0;
    
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

    if (uncategorizedCount === 0 && adjustedRecurring.length === 0 && overdueRecurring.length === 0 && recentDetects.length === 0 && recentTaxableIncome.length === 0) {
      console.log('[ai-worker] Nothing urgent to review. Exiting.');
      return;
    }

    const systemPrompt = `You are Mizān's background AI co-pilot. Your job is to review the user's latest sync delta and generate proactive, actionable 1-click drafts.
You must output a JSON array of draft objects. Return ONLY valid JSON, with no markdown code blocks or conversational text.
If there are no meaningful drafts to generate, return an empty array [].

Allowed 'kind' values: 'categorize_transaction', 'create_merchant_rule', 'recurring_occurrence_adjustment', 'update_budget', 'update_goal_target', 'allocate_goal_funds', 'create_goal', 'create_budget_group'.

Your context is:
${context}

Review Summary:
${uncategorizedCount} uncategorized transactions.
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

Example JSON format for a draft:
[
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
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: 'Generate proactive drafts based on the latest sync state.' }],
      temperature: 0.1,
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    let drafts: any[] = [];
    try {
      drafts = JSON.parse(text);
    } catch (parseError) {
      console.error('[ai-worker] Failed to parse AI JSON response:', text);
      return;
    }

    if (!Array.isArray(drafts) || drafts.length === 0) {
      console.log('[ai-worker] No drafts generated.');
      return;
    }

    const now = new Date().toISOString();
    let inserted = 0;

    const insertDraft = db.prepare(`
      INSERT INTO advisor_drafts (id, kind, label, summary, route, payload, changes, citations, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
    `);

    db.transaction(() => {
      // Clear out any stale 'open' drafts that the AI is effectively replacing
      db.prepare(`DELETE FROM advisor_drafts WHERE status = 'open'`).run();

      for (const draft of drafts) {
        if (!draft.kind || !draft.label || !draft.summary || !draft.payload) continue;
        
        insertDraft.run(
          uuidv4(),
          draft.kind,
          draft.label,
          draft.summary,
          draft.route || '/review',
          JSON.stringify(draft.payload),
          JSON.stringify(draft.changes || []),
          JSON.stringify(draft.citations || []),
          now,
          now
        );
        inserted++;
      }
    })();

    console.log(`[ai-worker] Generated and saved ${inserted} proactive drafts.`);

  } catch (err) {
    console.error('[ai-worker] Error running background AI review:', err);
  }
}
