import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { summarizeQueryFailures } from '../client/src/components/QueryErrorBanner';

const ROOT = join(__dirname, '..');

/**
 * A screen that failed to load must not answer the question it failed to answer.
 *
 * `Accounts.tsx` destructured only `data`, so `assets`, `owed` and `netWorth` reduced over an
 * empty array to exactly 0 and the screen rendered "$0" as its 44px subject numeral, "$0" assets,
 * and a liabilities Figure whose label and state sentence are computed from the value, so
 * `owed === 0` selected "Liabilities" and "nothing outstanding". Then "No accounts yet" underneath.
 * Four claims about a ledger the screen had not seen. QueryErrorBanner's own docstring records
 * this defect class as fixed; two screens had never adopted it.
 */
function source(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}

test('the accounts screen renders its error state, not zeros', () => {
  const src = source('client/src/views/accounts/Accounts.tsx');

  assert.match(src, /QueryErrorBanner/, 'the screen has no error banner');
  assert.match(
    src,
    /accountsQ\.isError/,
    'the screen never reads isError, so a failed request renders as an empty ledger'
  );
  // The headline block and the empty state are both withheld on failure.
  assert.match(src, /\{!accountsQ\.isError && \(\n\s*<div className="mb-8/, 'the money numerals are not withheld on failure');
  assert.match(src, /!accountsQ\.isError && liveVisible\.length === 0/, '"No accounts yet" is not withheld on failure');
});

test('every money screen reads isError, so none of them can render a confident zero', () => {
  const screens = [
    'client/src/views/Instrument.tsx',
    'client/src/views/Ledger.tsx',
    'client/src/views/Plan.tsx',
    'client/src/views/Investments.tsx',
    'client/src/views/accounts/Accounts.tsx',
  ];
  for (const screen of screens) {
    assert.match(source(screen), /QueryErrorBanner/, `${screen} cannot say that it failed to load`);
  }
});

test('summarizeQueryFailures is silent when nothing failed', () => {
  const ok = { isError: false, error: null, refetch: () => undefined };
  assert.equal(summarizeQueryFailures([{ query: ok, label: 'your accounts' }]), null);
});

test('summarizeQueryFailures names what is missing when something failed', () => {
  const bad = { isError: true, error: new Error('Failed to fetch'), refetch: () => undefined };
  const summary = summarizeQueryFailures([{ query: bad, label: 'your accounts' }]);
  assert.deepEqual(summary, { labels: ['your accounts'], detail: 'Failed to fetch' });
});

test('AccountDetail does not say "no transactions" before it knows', () => {
  const src = source('client/src/views/accounts/AccountDetail.tsx');

  // The only loading guard on this screen read `isLoading` from the ACCOUNTS query, which resolves
  // first, so the sentence rendered while the transactions query was still in flight and
  // permanently if it failed. The file had no error surface at all.
  assert.match(src, /txQ\.isPending \?/, 'the empty sentence is not gated on the query resolving');
  assert.match(src, /txQ\.isError \?/, 'a failed transactions query still renders the empty sentence');
  assert.match(src, /QueryErrorBanner/, 'the screen has no way to say it failed');

  // Order matters: pending and error must both be checked BEFORE length === 0.
  const pendingAt = src.indexOf('txQ.isPending ?');
  const emptyAt = src.indexOf('No transactions for this account yet.');
  assert.ok(pendingAt > 0 && pendingAt < emptyAt, 'the empty branch is reached before the pending check');
});
