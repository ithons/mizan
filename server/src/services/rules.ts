import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';

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
