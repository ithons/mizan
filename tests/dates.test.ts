import test from 'node:test';
import assert from 'node:assert/strict';
import { epochSecondsToLocalDate, isoToLocalDate } from '../server/src/services/dates';

// The ingest normalizes provider instants to the server's LOCAL calendar day, matching the
// local "today"/month boundaries used everywhere else. These tests construct instants in
// local time (new Date(y, m, d, ...)) so they hold regardless of the machine's timezone.

test('epochSecondsToLocalDate returns the local calendar day of the instant', () => {
  const localNoon = new Date(2026, 2, 15, 12, 0, 0); // 2026-03-15 12:00 local
  assert.equal(epochSecondsToLocalDate(localNoon.getTime() / 1000), '2026-03-15');
});

test('a late-evening local instant stays on its local day (does not drift to the next UTC day)', () => {
  // Under the old UTC rule this would roll to 2026-03-16 in any timezone behind UTC.
  const lateLocal = new Date(2026, 2, 15, 23, 30, 0); // 2026-03-15 23:30 local
  assert.equal(epochSecondsToLocalDate(lateLocal.getTime() / 1000), '2026-03-15');
});

test('isoToLocalDate agrees with epochSecondsToLocalDate for the same instant', () => {
  const d = new Date(2026, 6, 13, 9, 15, 0);
  assert.equal(isoToLocalDate(d.toISOString()), epochSecondsToLocalDate(d.getTime() / 1000));
});
