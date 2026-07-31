import { getAnthropicClient, readModelText } from './anthropicClient';
import { JOB_MODELS, buildModelRequestShape } from './advisorSettings';
import type Database from 'better-sqlite3';

export interface CategorySuggestion {
  merchant: string;
  category_id: string;
  category_name: string;
}

// Bulk merchant classification is high-volume and near-lookup, so it takes the cheapest
// capable model rather than the (configurable) conversational advisor model. The assignment
// lives in JOB_MODELS so every job's model choice reads from one table.
const SUGGEST_JOB = JOB_MODELS.bulk_categorization;

// Caps the blast radius of one request: the prompt lists every merchant, and the reply lists one
// object per merchant, so an unbounded list would blow past max_tokens and truncate the JSON.
export const MAX_SUGGEST_MERCHANTS = 60;

/**
 * Proposes a category for each merchant label. Suggestions are advisory only. Nothing is written;
 * the user applies them from the review worklist.
 *
 * Any suggestion naming a category id that doesn't exist is dropped rather than returned, so a
 * hallucinated id can never reach a write path (the same guard class that keeps a stale id from
 * failing the auto-categorization stage in rules.ts).
 *
 * Throws when the model declines or returns something unreadable. An empty array means the model
 * was asked and recognised nothing; a failure has to look different from that, or a broken call
 * reads on screen as "no merchant here could be identified".
 */
export async function suggestCategoriesForMerchants(
  db: Database.Database,
  merchants: string[]
): Promise<CategorySuggestion[]> {
  const anthropic = getAnthropicClient();
  if (!anthropic) return [];

  const unique = [...new Set(merchants.map((m) => m.trim()).filter(Boolean))].slice(0, MAX_SUGGEST_MERCHANTS);
  if (unique.length === 0) return [];

  // Only leaf categories are assignable; a parent like "Food & Drink" is a grouping.
  const categories = db.prepare(`
    SELECT c.id, c.name, p.name AS parent_name
    FROM categories c
    LEFT JOIN categories p ON p.id = c.parent_id
    WHERE c.is_income = 0 OR c.is_income IS NULL
    ORDER BY c.sort_order
  `).all() as Array<{ id: string; name: string; parent_name: string | null }>;
  const validIds = new Map(categories.map((c) => [c.id, c.name]));

  const systemPrompt = `You categorize bank/credit-card merchant descriptors for a personal finance app.

For each merchant string, choose the single best category. The strings are raw statement descriptors, so they may contain store numbers, city/state codes, and processor prefixes (TST*, SQ *, PAR*, PP*, CTLP*). Infer the underlying business.

Rules:
- "category_id" MUST be copied exactly from the "id" values listed below. Never invent an id and never use a display name.
- If you cannot tell what the business is with reasonable confidence, OMIT that merchant from your response entirely. A missing suggestion is much better than a wrong one.
- Respond with RAW JSON only (no markdown fence, no prose): an array of {"merchant": "<exact input string>", "category_id": "<id>"}.

Valid categories:
${categories.map((c) => `- id: "${c.id}", name: "${c.parent_name ? `${c.parent_name} / ` : ''}${c.name}"`).join('\n')}`;

  const response = await anthropic.messages.create({
    model: SUGGEST_JOB.model,
    max_tokens: 4096,
    system: systemPrompt,
    // No sampling parameter: temperature/top_p/top_k are a 400 on every 4.7+ model, and this
    // call site only survived one because it happened to name a model that still accepts them.
    // Derived rather than hardcoded so the request can never carry a parameter this model rejects.
    ...buildModelRequestShape(SUGGEST_JOB.model, { effort: SUGGEST_JOB.effort }),
    messages: [
      {
        role: 'user',
        content: `Categorize these merchants:\n${unique.map((m) => `- ${m}`).join('\n')}`,
      },
    ],
  });

  if (response.stop_reason === 'max_tokens') {
    console.warn('[ai-suggest] Response hit max_tokens; some suggestions may be missing.');
  }

  // Instructed to return raw JSON, but strip a fence defensively.
  const text = readModelText(response).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('[ai-suggest] Model returned text that is not JSON; no suggestions can be read from it.');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('[ai-suggest] Model returned JSON that is not an array of suggestions.');
  }

  const requested = new Set(unique);
  const out: CategorySuggestion[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue;
    const { merchant, category_id: categoryId } = item as { merchant?: unknown; category_id?: unknown };
    if (typeof merchant !== 'string' || typeof categoryId !== 'string') continue;
    // Drop anything we didn't ask about or that names a category that doesn't exist.
    if (!requested.has(merchant)) continue;
    const name = validIds.get(categoryId);
    if (!name) continue;
    out.push({ merchant, category_id: categoryId, category_name: name });
  }
  return out;
}
