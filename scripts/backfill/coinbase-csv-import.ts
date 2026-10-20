// Add the Coinbase transaction-history CSV rows the ledger lacks, from the reviewed
// data/backfill/raw/coinbase-csv/proposed_rows.json (each row already in the sync's conventions).
// Only rows below the account's provider floor are accepted, and a row whose CSV id is already in
// a note is skipped, so a second run adds nothing.
//
//   tsx scripts/backfill/coinbase-csv-import.ts            # dry run, rolled back
//   tsx scripts/backfill/coinbase-csv-import.ts --commit
import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { getDb, closeDb } from '../../server/src/db/index';
import { recordDataImportRun } from '../../server/src/services/importRuns';
import { isBelowBackfillFloor } from '../../server/src/services/backfillFloor';
import { resolveCryptoSecurityId } from '../../server/src/services/coinbase';

const INPUT = path.join(process.cwd(), 'data', 'backfill', 'raw', 'coinbase-csv', 'proposed_rows.json');

interface Proposed {
  row: {
    date: string; amount: number; merchant_name: string; original_name: string; category_id: string;
    quantity: number | null; security_id: string | null; notes: string;
  };
}

class DryRun extends Error {}

function main(): void {
  const commit = process.argv.includes('--commit');
  const { proposed } = JSON.parse(fs.readFileSync(INPUT, 'utf8')) as { proposed: Proposed[] };
  const db = getDb();
  const account = db.prepare("SELECT id, backfill_floor_date AS floor FROM accounts WHERE connection_type = 'coinbase'").all() as Array<{ id: string; floor: string | null }>;
  if (account.length !== 1) throw new Error(`${account.length} Coinbase accounts, expected 1`);
  const { id: accountId, floor } = account[0];
  const run = () => {
    const known = db.prepare('SELECT 1 FROM transactions WHERE account_id = ? AND notes = ?');
    const insert = db.prepare(`
      INSERT INTO transactions
        (id, account_id, date, amount, merchant_name, original_name, category_id, review_status, pending, notes,
         is_manual, source_type, source_detail, is_internal_trade, quantity, security_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'reviewed', 0, ?, 0, 'import', 'coinbase-csv', 0, ?, ?, ?, ?)
    `);
    const now = new Date().toISOString();
    let added = 0;
    for (const { row } of proposed) {
      if (floor && !isBelowBackfillFloor(row.date, floor)) throw new Error(`${row.date} ${row.original_name} is at or above the floor ${floor}`);
      if (known.get(accountId, row.notes)) continue;
      const ticker = /^NEW:(\w+)/.exec(row.security_id ?? '')?.[1];
      const securityId = ticker ? resolveCryptoSecurityId(db, ticker) : row.security_id;
      insert.run(uuidv4(), accountId, row.date, row.amount, row.merchant_name, row.original_name, row.category_id,
        row.notes, row.quantity, securityId, now, now);
      added++;
    }
    console.log(`Coinbase: ${added} of ${proposed.length} CSV rows added`);
    if (added) {
      recordDataImportRun(db, { source: 'csv', status: 'succeeded', rows_seen: proposed.length, rows_imported: added, errors_count: 0,
        summary: `Coinbase transaction history CSV: added ${added} rows below the floor` });
    }
    if (!commit) throw new DryRun();
  };
  try {
    db.transaction(run)();
    console.log('Committed. Next: tsx scripts/backfill/rebuild.ts');
  } catch (err) {
    if (!(err instanceof DryRun)) throw err;
    console.log('Dry run: rolled back. Re-run with --commit.');
  }
}

try { main(); } finally { closeDb(); }
