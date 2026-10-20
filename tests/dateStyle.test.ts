/**
 * One date style on screen, month first, through lib/formatters. The Balance header read
 * "19 October" while the Ledger read "Oct 19", and two panels printed raw ISO dates in prose.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { formatDate, formatDateLong, formatDateShort } from '../client/src/lib/formatters';

const CLIENT = join(__dirname, '..', 'client/src');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : /\.tsx?$/.test(name) ? [path] : [];
  });
}

test('no client file formats a day before its month', () => {
  for (const file of sources(CLIENT)) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), /'(?:EEEE )?d MMM/, file);
  }
});

test('HEALTHY: the three helpers agree on month first', () => {
  assert.equal(formatDateShort('2026-10-19'), 'Oct 19');
  assert.equal(formatDate('2026-10-19'), 'Oct 19, 2026');
  assert.equal(formatDateLong(new Date(2026, 9, 19)), 'Monday, Oct 19');
});
