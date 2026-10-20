// Lists every live merchant rule that files no transaction, and retires the ones that are exact
// duplicates: another live rule with the same category reduces to the same value under the matcher,
// so both match exactly the same names and retiring the one holding nothing changes no category.
// Every other rule that holds nothing is listed and left alone, because it may be meant for rows
// that have not arrived yet. Run after normalize-imported-merchants.ts.
//
//   npx tsx scripts/retire-duplicate-rules.ts            # list, no writes
//   npx tsx scripts/retire-duplicate-rules.ts --commit   # retire the duplicates
import { getDb, closeDb } from '../server/src/db/index';
import {
  countTransactionsHeldByAllRules,
  normalizeMerchantMatchValue,
  resolveRulesByTransaction,
  retireMerchantRule,
} from '../server/src/services/rules';

interface Rule { id: string; pattern: string; category_id: string; source: string }

function main(): void {
  const commit = process.argv.includes('--commit');
  const db = getDb();
  const rules = db.prepare(`
    SELECT id, pattern, category_id, source FROM merchant_rules WHERE retired_at IS NULL ORDER BY pattern, id
  `).all() as Rule[];
  const held = countTransactionsHeldByAllRules(db);
  const idle = rules.filter((rule) => (held.get(rule.id) ?? 0) === 0);
  const twinOf = (rule: Rule) => rules.find((other) =>
    other.id !== rule.id
    && other.category_id === rule.category_id
    && normalizeMerchantMatchValue(other.pattern) === normalizeMerchantMatchValue(rule.pattern)
    && !(idle.includes(other) && other.id > rule.id));
  const duplicates = idle.filter((rule) => twinOf(rule) !== undefined);

  console.log(`${rules.length} live rules, ${idle.length} file no transaction.`);
  for (const rule of duplicates) console.log(`  duplicate  "${rule.pattern}" -> ${rule.category_id} (${rule.source}), same as "${twinOf(rule)?.pattern}"`);
  for (const rule of idle.filter((r) => !duplicates.includes(r))) console.log(`  kept       "${rule.pattern}" -> ${rule.category_id} (${rule.source})`);
  if (!commit) {
    console.log('Dry run. Re-run with --commit to retire the duplicates.');
    return;
  }

  const retire = db.transaction(() => {
    const before = resolveRulesByTransaction(db);
    const retired = duplicates.filter((rule) => retireMerchantRule(db, rule.id, { source: 'human' })).length;
    const after = resolveRulesByTransaction(db);
    const moved = [...before].filter(([id, resolved]) => after.get(id)?.categoryId !== resolved?.categoryId).length;
    if (moved > 0) throw new Error(`${moved} transaction(s) would resolve to a different rule category. Nothing was written.`);
    return retired;
  });
  console.log(`Retired ${retire()}.`);
}

try {
  main();
} finally {
  closeDb();
}
