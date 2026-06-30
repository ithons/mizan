import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import Anthropic from '@anthropic-ai/sdk';
import { getDb } from '../db/index';
import { buildFinancialContext } from './aiContext';
import { getTransactionReviewSummary } from './transactionReview';
import type { AdvisorDraftAction, AdvisorDraftPayload, AdvisorCitation, AdvisorDraftChange } from '../../../shared/types';
import { buildRecurringForecast } from './recurringForecast';

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

    // 3. Any sync changes marked as 'detected'
    const recentDetects = db.prepare(`
      SELECT entity_type, description 
      FROM sync_changes 
      WHERE change_type = 'detected'
      ORDER BY created_at DESC 
      LIMIT 20
    `).all() as Array<{ entity_type: string, description: string }>;

    if (uncategorizedCount === 0 && adjustedRecurring.length === 0 && overdueRecurring.length === 0 && recentDetects.length === 0) {
      console.log('[ai-worker] Nothing urgent to review. Exiting.');
      return;
    }

    const systemPrompt = `You are Mizān's background AI co-pilot. Your job is to review the user's latest sync delta and generate proactive, actionable 1-click drafts.
You must output a JSON array of draft objects. Return ONLY valid JSON, with no markdown code blocks or conversational text.
If there are no meaningful drafts to generate, return an empty array [].

Allowed 'kind' values: 'categorize_transaction', 'create_merchant_rule', 'recurring_occurrence_adjustment', 'update_budget', 'update_goal', 'create_budget_group'.

Your context is:
${context}

Review Summary:
${uncategorizedCount} uncategorized transactions.
${adjustedRecurring.length} adjusted recurring items.
${overdueRecurring.length} overdue recurring items.

Recent System Detections:
${recentDetects.map(d => `- [${d.entity_type}] ${d.description}`).join('\n')}

Example JSON format for a draft:
[
  {
    "kind": "create_merchant_rule",
    "label": "Auto-categorize Uber",
    "summary": "You have several uncategorized Uber rides. Route them to Transport?",
    "route": "/review",
    "payload": { "kind": "create_merchant_rule", "pattern": "uber", "category_id": "cat_123", "apply_existing": true },
    "changes": [{ "field": "rule", "before": null, "after": "uber" }],
    "citations": []
  }
]
`;

    // Let's ask the LLM for suggestions
    const response = await anthropic.messages.create({
      model: 'claude-3-haiku-20240307',
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
