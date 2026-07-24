import Anthropic from '@anthropic-ai/sdk';
import type Database from 'better-sqlite3';

export interface CategorySuggestion {
  merchant: string;
  category_id: string;
  category_name: string;
}

// Bulk merchant classification is a high-volume, low-nuance job, so it uses the same fast/cheap
// model as the background draft worker rather than the (configurable) conversational advisor model.
const SUGGEST_MODEL = 'claude-haiku-4-5';

// Caps the blast radius of one request: the prompt lists every merchant, and the reply lists one
// object per merchant, so an unbounded list would blow past max_tokens and truncate the JSON.
export const MAX_SUGGEST_MERCHANTS = 60;

function getClient(): Anthropic | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  return new Anthropic({ apiKey });
}

/**
 * Proposes a category for each merchant label. Suggestions are advisory only — nothing is written;
 * the user applies them from the review worklist.
 *
 * Any suggestion naming a category id that doesn't exist is dropped rather than returned, so a
 * hallucinated id can never reach a write path (the same guard class that keeps a stale id from
 * failing the auto-categorization stage in rules.ts).
 */
export async function suggestCategoriesForMerchants(
  db: Database.Database,
  merchants: string[]
): Promise<CategorySuggestion[]> {
  const anthropic = getClient();
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
    model: SUGGEST_MODEL,
    max_tokens: 4096,
    system: systemPrompt,
    temperature: 0.1,
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

  const firstBlock = response.content[0];
  const rawText = firstBlock && firstBlock.type === 'text' ? firstBlock.text : '';
  if (!rawText) return [];

  // Instructed to return raw JSON, but strip a fence defensively.
  const text = rawText.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    console.error('[ai-suggest] Could not parse model JSON; returning no suggestions.');
    return [];
  }
  if (!Array.isArray(parsed)) return [];

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
