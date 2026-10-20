/**
 * Cmd+K "Add transaction" opened the modal by firing a window event 120 ms after navigating, and a
 * Ledger chunk that had not mounted by then never heard it. The request now travels in the URL.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ADD_ENTRY_ROUTE, takeAddEntryRequest } from '../client/src/views/ledgerLinks';

const CLIENT = join(__dirname, '..', 'client/src');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : /\.tsx?$/.test(name) ? [path] : [];
  });
}

test('the add request survives in the URL and leaves the other params alone', () => {
  const remaining = takeAddEntryRequest(new URLSearchParams('accountId=acct_1&add=1&range=all'));
  assert.equal(remaining?.toString(), 'accountId=acct_1&range=all');
  assert.equal(takeAddEntryRequest(new URLSearchParams(ADD_ENTRY_ROUTE.split('?')[1]))?.toString(), '');
});

test('HEALTHY: an ordinary Ledger URL asks for nothing', () => {
  assert.equal(takeAddEntryRequest(new URLSearchParams('accountId=acct_1&range=all')), null);
  assert.equal(takeAddEntryRequest(new URLSearchParams('')), null);
});

test('nothing opens the add modal through a window event any more', () => {
  for (const file of sources(CLIENT)) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), /mizan:add-transaction/, file);
  }
  const palette = readFileSync(join(CLIENT, 'components/CommandPalette.tsx'), 'utf8');
  assert.match(palette, /navigate\(ADD_ENTRY_ROUTE\)/);
});
