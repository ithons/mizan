// Regenerate everything derived from raw transactions after a backfill: duplicate/
// transfer integrity, recurring-pattern detection, and the deep net-worth history.
// Run once after import + dedup.
//
//   tsx scripts/backfill/rebuild.ts
import { getDb, closeDb } from '../../server/src/db/index';
import { refreshTransactionIntegrity } from '../../server/src/services/transactionIntegrity';
import { detectRecurring } from '../../server/src/services/recurring';
import { backfillSnapshots, takeSnapshot } from '../../server/src/services/snapshot';

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
  // backfillSnapshots() skips any month that already has a snapshot, so freshly imported
  // history would never reach the estimates computed before it existed, which is the whole point of
  // the backfill. Estimates are pure reverse-replay of the ledger, so dropping them costs
  // nothing; measured snapshots (is_estimated = 0) are real captures and must survive.
  const cleared = db.prepare('DELETE FROM net_worth_snapshots WHERE is_estimated = 1').run().changes;
  if (cleared) console.log(`Cleared ${cleared} stale estimated snapshot(s) for recomputation.`);
  backfillSnapshots();
  const [{ count }] = db.prepare('SELECT COUNT(*) AS count FROM net_worth_snapshots').all() as { count: number }[];
  const [{ oldest }] = db.prepare('SELECT MIN(date) AS oldest FROM net_worth_snapshots').all() as { oldest: string }[];
  console.log(`Net-worth history rebuilt: ${count} snapshot(s), oldest ${oldest}.`);

  console.log('\nDone. Now capture the durability snapshot: tsx scripts/backfill/backup.ts');
}

try { main(); } finally { closeDb(); }
