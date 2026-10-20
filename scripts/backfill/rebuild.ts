// Regenerate everything derived from raw transactions after a backfill: duplicate/
// transfer integrity, recurring-pattern detection, and today's balance sheet. Net worth history
// needs no rebuild: the timeline is derived from the ledger on every read.
// Run once after import + dedup.
//
//   tsx scripts/backfill/rebuild.ts
import { getDb, closeDb } from '../../server/src/db/index';
import { refreshTransactionIntegrity } from '../../server/src/services/transactionIntegrity';
import { detectRecurring } from '../../server/src/services/recurring';
import { takeSnapshot } from '../../server/src/services/snapshot';

function main(): void {
  const db = getDb();

  const integrity = refreshTransactionIntegrity(db);
  console.log(
    `Integrity: ${integrity.duplicates.groupCount} duplicate group(s), ` +
    `${integrity.transfers.pairCount} transfer pair(s) flagged for review.`
  );

  detectRecurring();
  console.log('Recurring detection refreshed.');

  takeSnapshot();

  console.log('\nDone. Now capture the durability snapshot: tsx scripts/backfill/backup.ts');
}

try { main(); } finally { closeDb(); }
