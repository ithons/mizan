// Retires the model's Transfer In / Transfer Out rules for merchants that move money both ways.
// Such a rule wrote rows backwards before the direction guard existed, and now skips every
// opposite-sign row it matches. Retired as the owner, the same write DELETE /api/rules/:id makes:
// a retire_merchant_rule draft refuses any rule that still holds rows.
//
//   npx tsx scripts/retire-backwards-transfer-rules.ts            # list, no writes
//   npx tsx scripts/retire-backwards-transfer-rules.ts --commit   # retire them
import { getDb, closeDb } from '../server/src/db/index';
import { countTransactionsHeldByRule, merchantMatchesRulePattern, retireMerchantRule } from '../server/src/services/rules';

interface Rule { id: string; pattern: string; category_id: string }
interface Row { name: string; amount: number }

function main(): void {
  const commit = process.argv.includes('--commit');
  const db = getDb();
  const rules = db.prepare(`
    SELECT id, pattern, category_id FROM merchant_rules
    WHERE retired_at IS NULL AND source = 'ai' AND category_id IN ('cat_xfer_in', 'cat_xfer_out')
    ORDER BY created_at, id
  `).all() as Rule[];
  const rows = db.prepare(
    "SELECT COALESCE(NULLIF(merchant_name, ''), original_name) AS name, amount FROM transactions"
  ).all() as Row[];

  const backwards = rules.filter((rule) => rows.some((row) =>
    merchantMatchesRulePattern(row.name, rule.pattern)
    && (rule.category_id === 'cat_xfer_in' ? row.amount < 0 : row.amount > 0)));

  for (const rule of backwards) {
    console.log(`${rule.id}  "${rule.pattern}" -> ${rule.category_id}  holds ${countTransactionsHeldByRule(db, rule.id)}`);
  }
  if (backwards.length === 0) console.log('No AI transfer rule matches money moving the other way.');
  if (!commit) {
    if (backwards.length > 0) console.log('Dry run. Re-run with --commit to retire them.');
    return;
  }
  const retire = db.transaction(() => backwards.filter((rule) => retireMerchantRule(db, rule.id, { source: 'human' })).length);
  console.log(`Retired ${retire()}.`);
}

try {
  main();
} finally {
  closeDb();
}
