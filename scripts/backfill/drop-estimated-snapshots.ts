// Delete the monthly net worth estimates (net_worth_snapshots.is_estimated = 1) and the mark
// that scheduled their rebuild. Nothing writes or reads either any more: net worth history is
// the timeline, derived from the ledger on every read. Measured sheets are never touched.
//
//   tsx scripts/backfill/drop-estimated-snapshots.ts            # report, no writes
//   tsx scripts/backfill/drop-estimated-snapshots.ts --commit   # delete
//
// Safe to run twice: the second run finds nothing.
import { getDb, closeDb } from '../../server/src/db/index';

const MARK_KEY = 'net_worth_reconstruction_mark';

function main(): void {
  const commit = process.argv.includes('--commit');
  const db = getDb();
  const estimates = db.prepare('SELECT COUNT(*) AS n, MIN(date) AS oldest, MAX(date) AS newest FROM net_worth_snapshots WHERE is_estimated = 1')
    .get() as { n: number; oldest: string | null; newest: string | null };
  const measured = (db.prepare('SELECT COUNT(*) AS n FROM net_worth_snapshots WHERE is_estimated = 0').get() as { n: number }).n;
  const mark = (db.prepare('SELECT COUNT(*) AS n FROM app_preferences WHERE key = ?').get(MARK_KEY) as { n: number }).n;

  console.log(`${estimates.n} estimated row(s)${estimates.n ? `, ${estimates.oldest} to ${estimates.newest}` : ''}; ${measured} measured row(s) kept; ${mark} rebuild mark(s).`);
  if (!commit) {
    console.log('Dry run. Re-run with --commit to delete.');
    return;
  }
  const removed = db.transaction(() => ({
    rows: db.prepare('DELETE FROM net_worth_snapshots WHERE is_estimated = 1').run().changes,
    marks: db.prepare('DELETE FROM app_preferences WHERE key = ?').run(MARK_KEY).changes,
  }))();
  const left = (db.prepare('SELECT COUNT(*) AS n FROM net_worth_snapshots WHERE is_estimated = 0').get() as { n: number }).n;
  if (left !== measured) throw new Error(`measured rows changed from ${measured} to ${left}; the transaction should have prevented this`);
  console.log(`Deleted ${removed.rows} estimated row(s) and ${removed.marks} mark(s). ${left} measured row(s) remain.`);
}

try { main(); } finally { closeDb(); }
