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

/**
 * A retried Coinbase sync still records the balance movement the run made.
 *
 * `syncManager` wraps the whole of `syncCoinbase` in `withRetry`, and `syncCoinbase` read the
 * account's `current_balance` at the top of every attempt. A first attempt that wrote the new
 * balance and then threw inside the ledger import (an HTTP call, retryable) was re-run from the
 * top; the second attempt read the balance the first had just written as "previous",
 * `balancesDiffer` said no, and the run recorded no Coinbase movement. The write was right and the
 * record of it was lost. The balance is now read once, before the retry, and passed in.
 *
 * Pinned at the source because `syncCoinbase` performs real signed HTTP calls and the suite has no
 * seam to drive it without them; the two halves below are the whole of the fix.
 */
test('the Coinbase balance is read before the retry and handed to every attempt', () => {
  const sm = code('server/src/services/syncManager.ts');
  const call = sm.slice(sm.indexOf('const coinbaseBefore'), sm.indexOf('const coinbaseBefore') + 500);
  assert.match(call, /SELECT current_balance FROM accounts WHERE connection_type = 'coinbase'/);
  assert.match(
    call,
    /withRetry\(\(\)\s*=>\s*syncCoinbase\(\{ previousBalanceCents: coinbaseBefore\?\.current_balance \}\)/,
    'the retry re-reads the balance on every attempt'
  );
  // Order: the read must come before the retry, not inside it.
  assert.ok(sm.indexOf('const coinbaseBefore') < sm.indexOf('withRetry(() =>\n          syncCoinbase('), 'the pre-read sits inside the retried closure');
});

test('syncCoinbase measures its balance change against the value it was handed', () => {
  const cb = code('server/src/services/coinbase.ts');
  assert.match(cb, /options: \{ previousBalanceCents\?: number \} = \{\}/);
  assert.match(
    cb,
    /const previousCents = options\.previousBalanceCents \?\? existingAcct\?\.current_balance \?\? 0;/,
    'the previous balance is still read fresh on every attempt'
  );
});
