// Name each Coinbase row after its action ('Buy BTC', 'Send ETH'), the way sync now writes them,
// where it still reads the placeholder 'Coinbase'. A name the owner or the AI set is left alone,
// and each rename is recorded in transaction_field_revisions. A second run renames nothing.
//
//   tsx scripts/coinbase-merchant-names.ts            # dry run: count, no writes
//   tsx scripts/coinbase-merchant-names.ts --commit
import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import { getDb, closeDb } from '../server/src/db/index';

const PLACEHOLDER_ROWS = `
  FROM transactions
  WHERE account_id IN (SELECT id FROM accounts WHERE connection_type = 'coinbase')
    AND merchant_name = 'Coinbase'
    AND original_name IS NOT NULL AND trim(original_name) NOT IN ('', 'Coinbase')
    AND COALESCE(merchant_name_source, 'provider') = 'provider'`;

export function renameCoinbasePlaceholders(db: Database.Database, commit: boolean, now: string): number {
  const rows = db.prepare(`SELECT id, original_name, merchant_name_source ${PLACEHOLDER_ROWS}`)
    .all() as Array<{ id: string; original_name: string; merchant_name_source: string | null }>;
  if (!commit) return rows.length;

  const revision = db.prepare(`
    INSERT INTO transaction_field_revisions
      (id, transaction_id, field, from_value, to_value, from_source, to_source, origin, created_at)
    VALUES (?, ?, 'merchant_name', 'Coinbase', ?, ?, ?, 'import_rule', ?)
  `);
  const rename = db.prepare('UPDATE transactions SET merchant_name = ?, updated_at = ? WHERE id = ?');
  db.transaction(() => {
    for (const row of rows) {
      revision.run(uuidv4(), row.id, row.original_name, row.merchant_name_source, row.merchant_name_source, now);
      rename.run(row.original_name, now, row.id);
    }
  })();
  return rows.length;
}

function main(): void {
  const commit = process.argv.includes('--commit');
  const count = renameCoinbasePlaceholders(getDb(), commit, new Date().toISOString());
  console.log(commit
    ? `Renamed ${count} Coinbase row(s) after their action.`
    : `${count} Coinbase row(s) would be renamed. Re-run with --commit to write.`);
}

if (process.argv[1]?.endsWith('coinbase-merchant-names.ts')) {
  try { main(); } finally { closeDb(); }
}
