// Gives the historical import rows the merchant name the importer now stores
// (merchantFromImportedDescriptor), and rewrites the owner's rules typed as one of those raw
// descriptors the same way, in one transaction. Rules that land on one pattern and one category collapse to the
// oldest; rules that land on one pattern with different categories are listed and left alone.
//
// Nothing is written that would change what a rule re-check leaves any row holding. A rewrite or
// a rename that would is held back and named, and the rest is tried again without it.
//
//   npx tsx scripts/normalize-imported-merchants.ts            # plan and verify, no writes
//   npx tsx scripts/normalize-imported-merchants.ts --commit   # apply
import type Database from 'better-sqlite3';
import { getDb, closeDb } from '../server/src/db/index';
import { recordFieldRevision } from '../server/src/services/categoryWrites';
import { merchantFromImportedDescriptor } from '../server/src/services/merchantNames';
import { editMerchantRule, resolveRulesByTransaction, retireMerchantRule } from '../server/src/services/rules';

interface Rule { id: string; pattern: string; category_id: string; source: string }
// `descriptors` is every raw import descriptor, lower-cased. The normalizer reads raw descriptors only,
// and a rule already rewritten is no longer one, which is what makes a second run write nothing.
interface Held { groups: Set<string>; rows: Set<string>; descriptors: ReadonlySet<string> }
interface Outcome { ruleId: string | null; categoryId: string | null }

class DryRun extends Error {}
class Moved extends Error {
  constructor(readonly rows: Array<{ id: string; before: Outcome; after: Outcome }>) { super('moved'); }
}

const rewritten = (rule: Rule, held: Held) =>
  (rule.source === 'human' && held.descriptors.has(rule.pattern.toLowerCase()) ? merchantFromImportedDescriptor(rule.pattern) : rule.pattern);
const groupKey = (rule: Rule, held: Held) => rewritten(rule, held).toLowerCase();

function renameRows(db: Database.Database, held: Held, now: string): number {
  const rows = db.prepare(`
    SELECT id, merchant_name, merchant_name_source FROM transactions
    WHERE source_type = 'import' AND merchant_name = original_name
      AND COALESCE(merchant_name_source, 'provider') = 'provider'
  `).all() as Array<{ id: string; merchant_name: string; merchant_name_source: string | null }>;
  const update = db.prepare('UPDATE transactions SET merchant_name = ?, updated_at = ? WHERE id = ?');
  let renamed = 0;
  for (const row of rows) {
    const next = merchantFromImportedDescriptor(row.merchant_name);
    if (next === row.merchant_name || held.rows.has(row.id)) continue;
    recordFieldRevision(db, {
      transactionId: row.id, field: 'merchant_name', fromValue: row.merchant_name, toValue: next,
      fromSource: row.merchant_name_source, toSource: row.merchant_name_source, origin: 'import_rule',
    }, now);
    update.run(next, now, row.id);
    renamed += 1;
  }
  return renamed;
}

function rewriteRules(db: Database.Database, held: Held, now: string): { renamed: number; retired: number; conflicts: string[] } {
  const rules = db.prepare(`
    SELECT id, pattern, category_id, source FROM merchant_rules WHERE retired_at IS NULL ORDER BY created_at, id
  `).all() as Rule[];
  const groups = new Map<string, Rule[]>();
  for (const rule of rules) groups.set(groupKey(rule, held), [...(groups.get(groupKey(rule, held)) ?? []), rule]);

  const result = { renamed: 0, retired: 0, conflicts: [] as string[] };
  for (const [key, group] of groups) {
    if (held.groups.has(key)) continue;
    if (group.length > 1 && group.some((rule) => rule.source !== 'human' || rule.category_id !== group[0].category_id)) {
      result.conflicts.push(`"${key}": ${group.map((rule) => `"${rule.pattern}" -> ${rule.category_id} (${rule.source})`).join(', ')}`);
      continue;
    }
    const [keeper, ...duplicates] = group;
    for (const duplicate of duplicates) {
      if (retireMerchantRule(db, duplicate.id, { source: 'human', now })) result.retired += 1;
    }
    const pattern = rewritten(keeper, held);
    if (pattern !== keeper.pattern) {
      editMerchantRule(db, keeper.id, { pattern }, now);
      result.renamed += 1;
    }
  }
  return result;
}

// What a rule re-check leaves each row holding: the winning rule's category, or the row's own when no
// rule matches. A rule newly matching a row is no change when it agrees with what the row holds.
function outcomes(db: Database.Database): Map<string, Outcome> {
  const stored = new Map((db.prepare('SELECT id, category_id FROM transactions').all() as Array<{ id: string; category_id: string | null }>)
    .map((row) => [row.id, row.category_id]));
  return new Map([...resolveRulesByTransaction(db)].map(([id, resolved]) => [
    id,
    { ruleId: resolved?.ruleId ?? null, categoryId: resolved?.categoryId ?? stored.get(id) ?? null },
  ]));
}

function attempt(db: Database.Database, held: Held, before: Map<string, Outcome>, now: string) {
  return db.transaction(() => {
    const rows = renameRows(db, held, now);
    const rules = rewriteRules(db, held, now);
    const after = outcomes(db);
    const moved = [...before]
      .filter(([id, outcome]) => after.get(id)?.categoryId !== outcome.categoryId)
      .map(([id, outcome]) => ({ id, before: outcome, after: after.get(id) as Outcome }));
    if (moved.length > 0) throw new Moved(moved);
    return { rows, rules };
  })();
}

// A moved row is charged to the rule group that wins it now or won it before, when that group was
// rewritten or collapsed; when neither was, the row's own rename moved it.
function hold(db: Database.Database, held: Held, moved: Moved['rows']): void {
  const rules = db.prepare('SELECT id, pattern, category_id, source FROM merchant_rules WHERE retired_at IS NULL').all() as Rule[];
  const members = new Map<string, number>();
  for (const rule of rules) members.set(groupKey(rule, held), (members.get(groupKey(rule, held)) ?? 0) + 1);
  const changed = new Map(rules
    .filter((rule) => (members.get(groupKey(rule, held)) ?? 0) > 1 || groupKey(rule, held) !== rule.pattern.toLowerCase())
    .map((rule) => [rule.id, groupKey(rule, held)]));
  for (const { id, before, after } of moved) {
    const keys = [before.ruleId, after.ruleId].flatMap((ruleId) => (ruleId && changed.has(ruleId) ? [changed.get(ruleId) as string] : []));
    if (keys.length === 0) held.rows.add(id);
    for (const key of keys) held.groups.add(key);
  }
}

function main(): void {
  const commit = process.argv.includes('--commit');
  const db = getDb();
  const now = new Date().toISOString();
  const descriptors = new Set((db.prepare("SELECT DISTINCT lower(original_name) AS d FROM transactions WHERE source_type = 'import'")
    .all() as Array<{ d: string }>).map((row) => row.d));
  const held: Held = { groups: new Set(), rows: new Set(), descriptors };
  try {
    db.transaction(() => {
      const before = outcomes(db);
      for (;;) {
        try {
          const { rows, rules } = attempt(db, held, before, now);
          console.log(`Rows renamed: ${rows}. Owner rules renamed: ${rules.renamed}, retired as duplicates: ${rules.retired}.`);
          for (const conflict of rules.conflicts) console.log(`Left alone, rules disagree: ${conflict}`);
          for (const key of held.groups) console.log(`Left alone, rewriting would change what it files: "${key}"`);
          if (held.rows.size > 0) console.log(`Rows left with their descriptor, because renaming them would change what a rule files: ${held.rows.size}`);
          console.log(`A rule re-check leaves all ${before.size} transactions where it would have before.`);
          break;
        } catch (err) {
          if (!(err instanceof Moved)) throw err;
          const size = held.groups.size + held.rows.size;
          hold(db, held, err.rows);
          if (held.groups.size + held.rows.size === size) throw new Error('Could not converge. Nothing was written.');
        }
      }
      if (!commit) throw new DryRun();
    })();
    console.log('Committed.');
  } catch (err) {
    if (!(err instanceof DryRun)) throw err;
    console.log('Dry run: rolled back. Re-run with --commit.');
  }
}

try {
  main();
} finally {
  closeDb();
}
