// Strict dedup of imported history. Cross-source duplicates can't exist (the floor
// guard prevents providers from ever touching the imported zone), so this only cleans
// duplicates WITHIN the imports themselves, e.g. two statement periods that overlap.
//
//   tsx scripts/backfill/dedup.ts                # report duplicate groups, no writes
//   tsx scripts/backfill/dedup.ts --commit       # delete extras (keep one per group)
//
// Key: account + date + exact cents + normalized merchant, collapsed ACROSS import runs
// only, never within one. For a manual account the original import moved its balance per
// row, so deleting a duplicate reverses that.
import type Database from 'better-sqlite3';
import { getDb, closeDb } from '../../server/src/db/index';
import { adjustManualAccountBalance } from '../../server/src/services/manualAccountBalance';

interface ImportRow {
  id: string;
  account_id: string;
  is_manual: number;
  date: string;
  amount: number; // integer cents
  merchant_name: string | null;
  original_name: string;
  created_at: string;
}

// Same minimal normalization the integrity pass uses: keeps genuinely distinct
// charges distinct ("store 1234" vs "store 5678") rather than over-merging.
function normalizeMerchant(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function groupKey(row: ImportRow): string {
  const merchant = normalizeMerchant(row.merchant_name || row.original_name);
  return [row.account_id, row.date, row.amount, merchant].join('|');
}

// Pure core: given import rows, return the ids to DELETE.
//
// A repeated key is NOT proof of duplication: four $2.40 transit taps on one day are four
// real charges. The only thing that duplicates a row is two source files whose statement
// periods overlap, and those always arrive in different import runs: commitCsvImport stamps
// one created_at across a whole call, and import.ts calls it once per file. So multiplicity
// WITHIN a run is authoritative (the file reported N, so N is right), and only runs are
// collapsed against each other: the survivor count is the largest any single run reported.
export function duplicateIdsToDelete(rows: ImportRow[]): string[] {
  const groups = new Map<string, ImportRow[]>();
  for (const row of rows) {
    const key = groupKey(row);
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(row);
  }
  const toDelete: string[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;

    const byRun = new Map<string, ImportRow[]>();
    for (const row of group) {
      (byRun.get(row.created_at) ?? byRun.set(row.created_at, []).get(row.created_at)!).push(row);
    }
    if (byRun.size < 2) continue; // one run: the source file's own multiplicity, keep it all

    // Survivor is the run that contributed the most rows; ties go to the earliest run.
    const runs = [...byRun.entries()]
      .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
    for (const [, rowsInRun] of runs.slice(1)) {
      toDelete.push(...rowsInRun.map((r) => r.id).sort());
    }
  }
  return toDelete;
}

function loadImportRows(db: Database.Database): ImportRow[] {
  return db.prepare(`
    SELECT t.id, t.account_id, a.is_manual, t.date, t.amount,
           t.merchant_name, t.original_name, t.created_at
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    WHERE t.source_type = 'import'
    ORDER BY t.created_at, t.id
  `).all() as ImportRow[];
}

function main(): void {
  const commit = process.argv.includes('--commit');
  const db = getDb();

  const rows = loadImportRows(db);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const toDelete = duplicateIdsToDelete(rows);

  console.log(`Imported rows: ${rows.length}. Exact duplicates to remove: ${toDelete.length}.`);
  if (toDelete.length === 0) { console.log('Nothing to dedup.'); return; }

  if (!commit) {
    console.log('Dry run. Re-run with --commit to delete. Sample:');
    for (const id of toDelete.slice(0, 10)) {
      const r = byId.get(id)!;
      console.log(`   ${r.date}  ${(r.merchant_name || r.original_name).slice(0, 30).padEnd(30)}  ${(r.amount / 100).toFixed(2)}`);
    }
    return;
  }

  const now = new Date().toISOString();
  const del = db.prepare('DELETE FROM transactions WHERE id = ?');
  const run = db.transaction(() => {
    let removed = 0;
    for (const id of toDelete) {
      const r = byId.get(id)!;
      // Manual accounts had their balance moved per imported row; reverse the deleted one.
      if (r.is_manual) adjustManualAccountBalance(db, r.account_id, -r.amount, now);
      del.run(id);
      removed++;
    }
    return removed;
  });

  const removed = run();
  console.log(`Removed ${removed} duplicate row(s). Next: tsx scripts/backfill/rebuild.ts`);
}

// Guarded like normalize.ts: tests import duplicateIdsToDelete for its own sake, and an
// unguarded main() would open the real DB (and honour a stray --commit) on mere import.
if (process.argv[1] && process.argv[1].endsWith('dedup.ts')) {
  try { main(); } finally { closeDb(); }
}
