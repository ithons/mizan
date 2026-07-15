import test from 'node:test';
import assert from 'node:assert/strict';
import { epochSecondsToUtcDate, isoToUtcDate } from '../server/src/services/dates';

// A transaction posted at 23:30 UTC must land on that UTC calendar day regardless of the
// process timezone. The old local-tz conversion would push it to the next day in any
// timezone east of UTC (e.g. UTC+2 -> 01:30 next day).
test('epochSecondsToUtcDate keeps a near-midnight instant on the UTC day', () => {
  const epoch = Date.parse('2026-03-15T23:30:00Z') / 1000;
  assert.equal(epochSecondsToUtcDate(epoch), '2026-03-15');
});

test('epochSecondsToUtcDate uses UTC, not local time (00:30 UTC stays the same day)', () => {
  const epoch = Date.parse('2026-03-15T00:30:00Z') / 1000;
  assert.equal(epochSecondsToUtcDate(epoch), '2026-03-15');
});

test('isoToUtcDate normalizes a provider ISO timestamp to the UTC day', () => {
  assert.equal(isoToUtcDate('2026-07-13T23:59:59Z'), '2026-07-13');
});

test('SimpleFIN and Coinbase agree on the same instant', () => {
  const iso = '2026-01-01T05:00:00Z';
  const epoch = Date.parse(iso) / 1000;
  assert.equal(epochSecondsToUtcDate(epoch), isoToUtcDate(iso));
});
