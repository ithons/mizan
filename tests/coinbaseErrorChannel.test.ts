import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { migratedTestDb } from './helpers/schema';
import { recordSyncRunItem, startSyncRun } from '../server/src/services/syncHistory';

const ROOT = join(__dirname, '..');

/**
 * A Coinbase pass that could not do its job does not record itself as a clean success.
 *
 * `CoinbaseSyncResult` had no `errors` field, so a coin that could not be priced, a v2 ledger
 * import that threw, and a feed that returned no account rows all went to `console.warn` and
 * nowhere else, while `syncManager` recorded `status: 'succeeded'` unconditionally. That keeps
 * `readLastSyncRun().incomplete` false, which is the flag the balance beam reads to decide it is
 * calibrated. SimpleFIN has carried `errors: string[]` since the same defect was found there.
 */
function code(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

test('the Coinbase result carries an error channel, like SimpleFIN does', () => {
  const src = code('server/src/services/coinbase.ts');
  assert.match(src, /errors: string\[\];/, 'CoinbaseSyncResult has nowhere to report a partial failure');
  // Each of the three swallowed failures now reports.
  assert.match(src, /errors\.push\([^)]*could not be priced/);
  assert.match(src, /errors\.push\(\s*$|errors\.push\([\s\S]{0,120}no account rows/m);
  assert.match(src, /errors\.push\([^)]*ledger import failed/);
});

test('the Coinbase stage status is derived from what it reported, not hardcoded', () => {
  const src = code('server/src/services/syncManager.ts');
  assert.doesNotMatch(
    src,
    /institution_name: 'Coinbase',\s*status: 'succeeded'/,
    "the Coinbase stage records 'succeeded' whatever happened"
  );
  assert.match(src, /coinbaseIncomplete \? 'skipped' : 'succeeded'/);
});

test('a zeroed holding is not reported as a modified transaction', () => {
  const src = code('server/src/services/syncManager.ts');
  assert.doesNotMatch(
    src,
    /transactions_modified: coinbaseResult\.staleAccountCount/,
    'holdings zeroed is being written into the transactions_modified column'
  );
  assert.match(src, /holdings_zeroed: coinbaseResult\.staleAccountCount/);
});

test('holdings_zeroed round-trips through the run item, separately from transactions_modified', () => {
  const db = migratedTestDb();
  const run = startSyncRun(db, 'full');
  recordSyncRunItem(db, run.id, {
    provider: 'coinbase',
    connection_id: 'coinbase',
    institution_name: 'Coinbase',
    status: 'succeeded',
    transactions_added: 3,
    holdings_zeroed: 8,
  });

  const row = db
    .prepare('SELECT transactions_added, transactions_modified, holdings_zeroed FROM sync_run_items')
    .get() as { transactions_added: number; transactions_modified: number; holdings_zeroed: number };

  assert.equal(row.transactions_added, 3);
  // The whole point: eight zeroed holdings must not read as eight modified transactions.
  assert.equal(row.transactions_modified, 0);
  assert.equal(row.holdings_zeroed, 8);
  db.close();
});

test('HEALTHY: a clean pass records no error text and zeroes nothing', () => {
  const db = migratedTestDb();
  const run = startSyncRun(db, 'full');
  recordSyncRunItem(db, run.id, {
    provider: 'coinbase',
    connection_id: 'coinbase',
    institution_name: 'Coinbase',
    status: 'succeeded',
    accounts_seen: 1,
    transactions_added: 2,
  });

  const row = db
    .prepare('SELECT status, error_message, holdings_zeroed FROM sync_run_items')
    .get() as { status: string; error_message: string | null; holdings_zeroed: number };
  assert.equal(row.status, 'succeeded');
  assert.equal(row.error_message, null);
  assert.equal(row.holdings_zeroed, 0);
  db.close();
});
