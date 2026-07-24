import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import { compareTwoStrings } from 'string-similarity';
import type {
  MerchantRuleSuggestion,
  MerchantRuleSuggestionPreview,
} from '../../../shared/types';
import { guessCategoryFromText } from './textCategorization';
import { getPreference, setPreference } from './preferences';

export interface RuleApplicationResult {
  updated: number;
}

// Skipped rule suggestions, stored as normalized merchant keys. Kept in app_preferences rather
// than a dedicated table: it's a small, purely-advisory list with no relational needs.
export const DISMISSED_RULE_SUGGESTIONS_KEY = 'dismissed_rule_suggestions';

// Writing a category_id that no longer exists raises "FOREIGN KEY constraint failed", which
// aborts the whole auto-categorization sync stage — a single stale mapping taking down the entire
// pass (observed once in a real sync). Callers resolve the valid ids once and skip unknown ones.
function knownCategoryIds(db: Database.Database): Set<string> {
  return new Set(
    (db.prepare('SELECT id FROM categories').all() as Array<{ id: string }>).map((row) => row.id)
  );
}

export function getDismissedRuleSuggestions(db: Database.Database): Set<string> {
  const value = getPreference(db, DISMISSED_RULE_SUGGESTIONS_KEY)?.value;
  if (!Array.isArray(value)) return new Set();
  return new Set(value.filter((entry): entry is string => typeof entry === 'string'));
}

export function dismissRuleSuggestion(db: Database.Database, pattern: string): void {
  const merchantKey = pattern.trim().toLowerCase();
  if (!merchantKey) return;
  const dismissed = getDismissedRuleSuggestions(db);
  if (dismissed.has(merchantKey)) return;
  dismissed.add(merchantKey);
  setPreference(db, DISMISSED_RULE_SUGGESTIONS_KEY, [...dismissed]);
}

interface MerchantRule {
  pattern: string;
  category_id: string;
}

interface TransactionRuleCandidate {
  id: string;
  merchant_name: string | null;
  original_name: string;
  category_id: string | null;
}

interface RawMerchantRuleSuggestion {
  merchant_key: string;
  pattern: string;
  category_id: string;
  category_name: string;
  category_color?: string | null;
  category_icon?: string | null;
  categorized_count: number;
  uncategorized_count: number;
  categorized_total: number;
  confidence: number;
}

interface RuleSuggestionPreviewRow {
  id: string;
  date: string;
  amount: number;
  merchant_name: string | null;
  original_name: string;
  account_name: string | null;
  category_id: string | null;
  category_name: string | null;
}

function transactionMerchantName(row: {
  merchant_name: string | null;
  original_name: string;
}): string {
  return row.merchant_name || row.original_name;
}

function normalizeMerchantMatchValue(value: string | null | undefined): string {
  return (value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(store|pos|purchase|debit|card|online|payment)\b/g, ' ')
    .replace(/\b\d{2,}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function merchantMatchesRulePattern(merchantName: string, pattern: string): boolean {
  const merchant = normalizeMerchantMatchValue(merchantName);
  const rule = normalizeMerchantMatchValue(pattern);
  if (!merchant || !rule) return false;
  if (merchant === rule) return true;
  if (rule.length >= 4 && merchant.includes(rule)) return true;
  if (merchant.length >= 4 && rule.includes(merchant)) return true;

  return compareTwoStrings(merchant, rule) >= 0.86;
}

export function upsertMerchantRule(
  db: Database.Database,
  pattern: string | null | undefined,
  categoryId: string,
  createdAt: string
): string | null {
  const normalizedPattern = pattern?.trim();
  if (!normalizedPattern) return null;

  const existingRule = db.prepare(
    'SELECT id FROM merchant_rules WHERE lower(pattern) = lower(?) LIMIT 1'
  ).get(normalizedPattern) as { id: string } | undefined;

  if (existingRule) {
    db.prepare(
      'UPDATE merchant_rules SET pattern = ?, category_id = ? WHERE id = ?'
    ).run(normalizedPattern, categoryId, existingRule.id);
    return existingRule.id;
  }

  const id = uuidv4();
  db.prepare(
    'INSERT INTO merchant_rules (id, pattern, category_id, created_at) VALUES (?, ?, ?, ?)'
  ).run(id, normalizedPattern, categoryId, createdAt);
  return id;
}

export function applyMerchantRulesToExistingTransactions(
  db: Database.Database,
  options: { onlyUncategorized?: boolean; skipManual?: boolean } = {}
): RuleApplicationResult {
  const onlyUncategorized = options.onlyUncategorized ?? true;
  const rules = db.prepare(
    'SELECT pattern, category_id FROM merchant_rules ORDER BY created_at DESC'
  ).all() as MerchantRule[];

  if (rules.length === 0) return { updated: 0 };

  const clauses: string[] = [];
  if (onlyUncategorized) clauses.push('category_id IS NULL');
  if (options.skipManual) clauses.push('manually_categorized = 0');
  const conditions = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const transactions = db.prepare(`
    SELECT id, merchant_name, original_name, category_id
    FROM transactions
    ${conditions}
  `).all() as Array<{
    id: string;
    merchant_name: string | null;
    original_name: string;
    category_id: string | null;
  }>;

  const now = new Date().toISOString();
  let updated = 0;
  const update = db.prepare(
    "UPDATE transactions SET category_id = ?, review_status = 'reviewed', updated_at = ? WHERE id = ?"
  );

  // A rule can outlive its category (categories have been folded/renamed by migrations), and
  // writing a dangling id fails the FK and aborts the whole stage. Skip those rules instead.
  const known = knownCategoryIds(db);
  const staleRulePatterns = new Set<string>();

  for (const transaction of transactions) {
    const merchantName = transactionMerchantName(transaction);
    const rule = rules.find((candidate) =>
      merchantMatchesRulePattern(merchantName, candidate.pattern)
    );

    if (!rule || rule.category_id === transaction.category_id) continue;
    if (!known.has(rule.category_id)) {
      staleRulePatterns.add(rule.pattern);
      continue;
    }
    update.run(rule.category_id, now, transaction.id);
    updated++;
  }

  if (staleRulePatterns.size > 0) {
    console.warn(
      `[rules] Skipped rule(s) pointing at a deleted category: ${[...staleRulePatterns].join(', ')}`
    );
  }

  return { updated };
}

// Runs after every sync (and once as a startup backlog pass) so providers that don't supply
// their own category (SimpleFIN, Coinbase) don't leave transactions permanently uncategorized.
// User merchant rules take precedence; the text heuristic is only a fallback for whatever
// rules don't cover. Only ever touches category_id IS NULL rows, so manual categorizations
// (and prior rule/heuristic hits) are never overwritten.
export function autoCategorizeTransactions(db: Database.Database): RuleApplicationResult {
  const ruleResult = applyMerchantRulesToExistingTransactions(db, { onlyUncategorized: true });

  const remaining = db.prepare(`
    SELECT id, merchant_name, original_name
    FROM transactions
    WHERE category_id IS NULL
  `).all() as Array<{ id: string; merchant_name: string | null; original_name: string }>;

  const now = new Date().toISOString();
  const update = db.prepare(
    'UPDATE transactions SET category_id = ?, updated_at = ? WHERE id = ?'
  );

  const known = knownCategoryIds(db);
  let heuristicUpdated = 0;
  for (const transaction of remaining) {
    const categoryId = guessCategoryFromText(transaction.merchant_name, transaction.original_name);
    if (!categoryId) continue;
    if (!known.has(categoryId)) continue;
    update.run(categoryId, now, transaction.id);
    heuristicUpdated++;
  }

  return { updated: ruleResult.updated + heuristicUpdated };
}

// Full "re-check all transactions" pass: re-applies every merchant rule and then the
// text heuristic across the whole ledger, but never touches rows the user categorized by
// hand (manually_categorized = 1). Rule/heuristic categorizations can change; deliberate
// manual choices are preserved.
export function recategorizeAll(db: Database.Database): RuleApplicationResult {
  const ruleResult = applyMerchantRulesToExistingTransactions(db, {
    onlyUncategorized: false,
    skipManual: true,
  });

  const remaining = db.prepare(`
    SELECT id, merchant_name, original_name
    FROM transactions
    WHERE category_id IS NULL AND manually_categorized = 0
  `).all() as Array<{ id: string; merchant_name: string | null; original_name: string }>;

  const now = new Date().toISOString();
  const update = db.prepare('UPDATE transactions SET category_id = ?, updated_at = ? WHERE id = ?');

  const known = knownCategoryIds(db);
  let heuristicUpdated = 0;
  for (const transaction of remaining) {
    const categoryId = guessCategoryFromText(transaction.merchant_name, transaction.original_name);
    if (!categoryId) continue;
    if (!known.has(categoryId)) continue;
    update.run(categoryId, now, transaction.id);
    heuristicUpdated++;
  }

  return { updated: ruleResult.updated + heuristicUpdated };
}

export function applyMerchantRuleToMatchingTransactions(
  db: Database.Database,
  pattern: string,
  categoryId: string,
  now = new Date().toISOString(),
  options: { overwrite?: boolean } = {}
): RuleApplicationResult {
  const normalizedPattern = pattern.trim();
  if (!normalizedPattern) return { updated: 0 };

  // Default: fill only uncategorized rows. overwrite: also re-label rows already in a
  // different category, but never ones the user categorized by hand.
  const scanWhere = options.overwrite ? 'WHERE manually_categorized = 0' : 'WHERE category_id IS NULL';
  const guard = options.overwrite ? 'AND manually_categorized = 0' : 'AND category_id IS NULL';

  const transactions = db.prepare(`
    SELECT id, merchant_name, original_name, category_id
    FROM transactions
    ${scanWhere}
  `).all() as TransactionRuleCandidate[];

  const update = db.prepare(`
    UPDATE transactions
    SET category_id = ?,
        review_status = 'reviewed',
        updated_at = ?
    WHERE id = ?
      ${guard}
  `);

  let updated = 0;
  for (const transaction of transactions) {
    if (!merchantMatchesRulePattern(transactionMerchantName(transaction), normalizedPattern)) continue;
    if (options.overwrite && transaction.category_id === categoryId) continue; // already correct
    const result = update.run(categoryId, now, transaction.id);
    updated += result.changes;
  }

  return { updated };
}

function reasonForSuggestion(row: RawMerchantRuleSuggestion): string {
  return `${row.categorized_count} of ${row.categorized_total} categorized ${row.pattern} transaction${row.categorized_total === 1 ? '' : 's'} use ${row.category_name}, so ${row.uncategorized_count} uncategorized match${row.uncategorized_count === 1 ? '' : 'es'} can be reviewed together.`;
}

function getRuleSuggestionPreview(
  db: Database.Database,
  merchantKey: string
): MerchantRuleSuggestionPreview[] {
  const rows = db.prepare(`
    SELECT
      t.id,
      t.date,
      t.amount,
      t.merchant_name,
      t.original_name,
      a.account_name,
      t.category_id,
      c.name AS category_name
    FROM transactions t
    LEFT JOIN accounts a ON a.id = t.account_id
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.pending = 0
      AND lower(trim(COALESCE(NULLIF(t.merchant_name, ''), NULLIF(t.original_name, '')))) = ?
    ORDER BY t.category_id IS NULL DESC, t.date DESC, ABS(t.amount) DESC
    LIMIT 6
  `).all(merchantKey) as RuleSuggestionPreviewRow[];

  return rows.map((row) => ({
    id: row.id,
    date: row.date,
    amount: row.amount,
    merchant_name: transactionMerchantName(row),
    account_name: row.account_name,
    category_name: row.category_name,
    will_apply: row.category_id === null,
  }));
}

export function suggestMerchantRules(db: Database.Database): MerchantRuleSuggestion[] {
  const rows = db.prepare(`
    WITH normalized AS (
      SELECT
        lower(trim(COALESCE(NULLIF(t.merchant_name, ''), NULLIF(t.original_name, '')))) AS merchant_key,
        trim(COALESCE(NULLIF(t.merchant_name, ''), NULLIF(t.original_name, ''))) AS pattern,
        t.category_id
      FROM transactions t
      WHERE t.pending = 0
        AND trim(COALESCE(NULLIF(t.merchant_name, ''), NULLIF(t.original_name, ''))) != ''
    ),
    category_counts AS (
      SELECT
        merchant_key,
        MAX(pattern) AS pattern,
        category_id,
        COUNT(*) AS categorized_count
      FROM normalized
      WHERE category_id IS NOT NULL
      GROUP BY merchant_key, category_id
    ),
    merchant_totals AS (
      SELECT merchant_key, SUM(categorized_count) AS categorized_total
      FROM category_counts
      GROUP BY merchant_key
    ),
    uncategorized_counts AS (
      SELECT merchant_key, COUNT(*) AS uncategorized_count
      FROM normalized
      WHERE category_id IS NULL
      GROUP BY merchant_key
    ),
    ranked AS (
      SELECT
        cc.*,
        mt.categorized_total,
        uc.uncategorized_count,
        ROW_NUMBER() OVER (
          PARTITION BY cc.merchant_key
          ORDER BY cc.categorized_count DESC, cc.category_id ASC
        ) AS category_rank
      FROM category_counts cc
      JOIN merchant_totals mt ON mt.merchant_key = cc.merchant_key
      JOIN uncategorized_counts uc ON uc.merchant_key = cc.merchant_key
    )
    SELECT
      r.merchant_key,
      r.pattern,
      r.category_id,
      c.name AS category_name,
      c.color AS category_color,
      c.icon AS category_icon,
      r.categorized_count,
      r.uncategorized_count,
      r.categorized_total,
      (1.0 * r.categorized_count / r.categorized_total) AS confidence
    FROM ranked r
    JOIN categories c ON c.id = r.category_id
    WHERE r.category_rank = 1
      AND r.categorized_count >= 2
      AND r.uncategorized_count > 0
      AND (1.0 * r.categorized_count / r.categorized_total) >= 0.75
      AND NOT EXISTS (
        SELECT 1
        FROM merchant_rules mr
        WHERE r.merchant_key LIKE '%' || lower(mr.pattern) || '%'
      )
    ORDER BY r.uncategorized_count DESC, r.categorized_count DESC, r.pattern ASC
    LIMIT 10
  `).all() as RawMerchantRuleSuggestion[];

  // Suggestions are recomputed from scratch on every call, so a skipped one would reappear
  // forever. Skips are persisted as a list of merchant keys in app_preferences.
  const dismissed = getDismissedRuleSuggestions(db);
  const visible = rows.filter((row) => !dismissed.has(row.merchant_key));

  return visible.map((row) => {
    const preview = getRuleSuggestionPreview(db, row.merchant_key);

    return {
      pattern: row.pattern,
      category_id: row.category_id,
      category_name: row.category_name,
      category_color: row.category_color,
      category_icon: row.category_icon,
      categorized_count: row.categorized_count,
      uncategorized_count: row.uncategorized_count,
      confidence: row.confidence,
      affected_transaction_ids: preview
        .filter((transaction) => transaction.will_apply)
        .map((transaction) => transaction.id),
      preview_transactions: preview,
      reason: reasonForSuggestion(row),
    };
  });
}
