// Import the reviewed canonical CSVs into the DB, reusing the tested import service
// (commitCsvImport) so amount/date parsing and per-account balance handling match the
// app exactly. Rows land as source_type='import'.
//
//   tsx scripts/backfill/import.ts               # dry run: validate + report, no writes
//   tsx scripts/backfill/import.ts --commit      # actually import
//
// Refuses any file whose account_name doesn't resolve to exactly one account (no
// silent "first manual account" fallback), and re-checks the floor as defense in depth.
import fs from 'node:fs';
import path from 'node:path';
import { getDb, closeDb } from '../../server/src/db/index';
import { commitCsvImport } from '../../server/src/services/csvImport';
import { recordDataImportRun } from '../../server/src/services/importRuns';
import {
  NORMALIZED_DIR, loadFloors, readCanonicalCsv, resolveAccount, type FloorEntry,
} from './lib';
import { isBelowBackfillFloor } from '../../server/src/services/backfillFloor';

function main(): void {
  const commit = process.argv.includes('--commit');
  const db = getDb();

  if (!fs.existsSync(NORMALIZED_DIR)) {
    console.log(`No normalized CSVs at ${NORMALIZED_DIR}. Run normalize.ts first.`);
    return;
  }
  const files = fs.readdirSync(NORMALIZED_DIR).filter((f) => f.endsWith('.csv'));
  if (files.length === 0) { console.log('No normalized CSVs to import.'); return; }

  const floors = loadFloors();
  const floorByName = new Map<string, FloorEntry>(floors.map((f) => [f.account_name, f]));

  let totalImported = 0;
  let refused = false;

  for (const file of files) {
    const rows = readCanonicalCsv(path.join(NORMALIZED_DIR, file));
    if (rows.length === 0) { console.log(`${file}: empty, skipped`); continue; }

    // Every row in a normalized file targets one account by construction.
    const accountNames = new Set(rows.map((r) => r.account_name));
    if (accountNames.size !== 1) {
      console.error(`✗ ${file}: mixes multiple account names ${[...accountNames].join(', ')} — refusing`);
      refused = true; continue;
    }
    const accountName = [...accountNames][0];
    const account = resolveAccount(db, accountName);
    if (!account) {
      console.error(`✗ ${file}: account "${accountName}" matches zero or multiple accounts — refusing`);
      refused = true; continue;
    }

    const floor = floorByName.get(accountName)?.floor ?? null;
    // No floor means no provider owns any range of this account (manual/closed), so every
    // row is importable. isBelowBackfillFloor() answers false for a null floor, which would
    // otherwise read as "at/above the floor" and refuse the whole file.
    const aboveFloor = floor ? rows.filter((r) => !isBelowBackfillFloor(r.date, floor)) : [];
    if (aboveFloor.length > 0) {
      console.error(`✗ ${file}: ${aboveFloor.length} row(s) at/above floor ${floor} — re-run normalize.ts; refusing`);
      refused = true; continue;
    }

    console.log(`${file}: ${rows.length} rows → "${accountName}"${commit ? '' : '  (dry run)'}`);
    if (!commit) { totalImported += rows.length; continue; }

    // The service reads columns by the names given in `mapping`; canonical columns
    // already carry the target sign (negative = outflow), so amountNegate stays false.
    const result = commitCsvImport(db, {
      rows: rows as unknown as Array<Record<string, string>>,
      mapping: {
        date: 'date', amount: 'amount', merchant: 'merchant', account: 'account_name',
        category: 'category', notes: 'notes', dateFormat: 'yyyy-MM-dd', amountNegate: false,
      },
    });
    totalImported += result.imported;
    console.log(`   imported ${result.imported}${result.errors.length ? `, ${result.errors.length} error(s)` : ''}`);
    for (const err of result.errors.slice(0, 10)) console.log(`   ${err}`);

    recordDataImportRun(db, {
      source: 'csv',
      status: result.errors.length ? 'partial' : 'succeeded',
      rows_seen: rows.length,
      rows_imported: result.imported,
      errors_count: result.errors.length,
      summary: `Historical backfill: ${file} → ${accountName}`,
    });
  }

  console.log(
    `\n${commit ? 'Imported' : 'Would import'} ${totalImported} transaction(s)` +
    (refused ? ' — SOME FILES REFUSED, resolve above before --commit.' : '.')
  );
  if (commit && !refused) {
    console.log('Next: tsx scripts/backfill/dedup.ts --commit  then  tsx scripts/backfill/rebuild.ts');
  }
}

try { main(); } finally { closeDb(); }
