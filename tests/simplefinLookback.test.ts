import test from 'node:test';
import assert from 'node:assert/strict';
import {
  simplefinLookback,
  triageSimplefinErrors,
  unreachableGapNotice,
  SIMPLEFIN_MAX_LOOKBACK_DAYS,
} from '../server/src/services/simplefin';

/**
 * How far back a SimpleFIN sync asks, and what it says about a gap it cannot reach.
 *
 * The incremental window was a fixed 30 days whatever the gap, so an app left closed for six weeks
 * asked only for the last 30 and never fetched the 12 days before them, silently. And the first
 * sync asked for 730 days from a bridge that serves 90, so every resync carried a cap notice.
 */

const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const daysBefore = (n: number): string => new Date(NOW - n * 86_400_000).toISOString();

test('HEALTHY: an hourly sync asks for the ordinary 30-day window and reports no gap', () => {
  const last = daysBefore(1 / 24);
  const lookback = simplefinLookback(last, NOW);
  assert.deepEqual(lookback, { days: 30, unreachableDays: 0 });
  assert.equal(unreachableGapNotice(last, lookback, NOW), null);
});

test('HEALTHY: a gap inside the window does not widen it', () => {
  assert.deepEqual(simplefinLookback(daysBefore(12), NOW), { days: 30, unreachableDays: 0 });
});

test('a gap longer than the window reaches back past the last pull', () => {
  assert.deepEqual(simplefinLookback(daysBefore(45), NOW), { days: 47, unreachableDays: 0 });
});

test('a new or force-resynced connection asks for what the bridge serves, never more', () => {
  assert.deepEqual(simplefinLookback(null, NOW), { days: SIMPLEFIN_MAX_LOOKBACK_DAYS, unreachableDays: 0 });
  assert.deepEqual(simplefinLookback(undefined, NOW), { days: SIMPLEFIN_MAX_LOOKBACK_DAYS, unreachableDays: 0 });
});

test('a gap past the bridge limit is capped and the unreachable dates are named', () => {
  const last = daysBefore(120);
  const lookback = simplefinLookback(last, NOW);
  assert.deepEqual(lookback, { days: 90, unreachableDays: 30 });
  const notice = unreachableGapNotice(last, lookback, NOW);
  assert.ok(notice);
  assert.match(notice, /from 2026-06-03 to 2026-07-03 were not fetched/);
  // It is an advisory: the owner's fix is a CSV import, never re-linking the bank.
  assert.deepEqual(triageSimplefinErrors([notice]).reauth, []);
});

test('an unparseable last_synced_at raises instead of guessing a window', () => {
  assert.throws(() => simplefinLookback('not a date', NOW), /not a timestamp/);
});

test('HEALTHY: a pull 89 days ago is fully inside the 90-day request, so nothing is claimed missing', () => {
  const last = daysBefore(89);
  const lookback = simplefinLookback(last, NOW);
  assert.deepEqual(lookback, { days: 90, unreachableDays: 0 });
  assert.equal(unreachableGapNotice(last, lookback, NOW), null);
});
