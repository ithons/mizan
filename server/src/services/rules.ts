import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import type { MerchantRuleSuggestion } from '../../../shared/types';

export interface RuleApplicationResult {
  updated: number;
}

interface MerchantRule {
  pattern: string;
  category_id: string;
}

function transactionMerchantName(row: {
  merchant_name: string | null;
  original_name: string;
}): string {
  return row.merchant_name || row.original_name;
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

export function applyMerchantRulesToTransaction(
  db: Database.Database,
  transactionId: string,
  merchantName: string
): boolean {
  const rules = db.prepare(
    'SELECT pattern, category_id FROM merchant_rules ORDER BY created_at DESC'
  ).all() as MerchantRule[];

  const lowerMerchant = merchantName.toLowerCase();

  for (const rule of rules) {
    if (lowerMerchant.includes(rule.pattern.toLowerCase())) {
      db.prepare(
        'UPDATE transactions SET category_id = ?, updated_at = ? WHERE id = ?'
      ).run(rule.category_id, new Date().toISOString(), transactionId);
      return true;
    }
  }

  return false;
}

export function applyMerchantRulesToExistingTransactions(
  db: Database.Database,
  options: { onlyUncategorized?: boolean } = {}
): RuleApplicationResult {
  const onlyUncategorized = options.onlyUncategorized ?? true;
  const rules = db.prepare(
    'SELECT pattern, category_id FROM merchant_rules ORDER BY created_at DESC'
  ).all() as MerchantRule[];

  if (rules.length === 0) return { updated: 0 };

  const conditions = onlyUncategorized ? 'WHERE category_id IS NULL' : '';
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
    'UPDATE transactions SET category_id = ?, updated_at = ? WHERE id = ?'
  );

  for (const transaction of transactions) {
    const merchantName = transactionMerchantName(transaction).toLowerCase();
    const rule = rules.find((candidate) =>
      merchantName.includes(candidate.pattern.toLowerCase())
    );

    if (!rule || rule.category_id === transaction.category_id) continue;
    update.run(rule.category_id, now, transaction.id);
    updated++;
  }

  return { updated };
}

export function suggestMerchantRules(db: Database.Database): MerchantRuleSuggestion[] {
  return db.prepare(`
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
      r.pattern,
      r.category_id,
      c.name AS category_name,
      c.color AS category_color,
      c.icon AS category_icon,
      r.categorized_count,
      r.uncategorized_count,
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
  `).all() as MerchantRuleSuggestion[];
}
