import test from 'node:test';
import assert from 'node:assert/strict';
import { simplefinLookbackDays } from '../server/src/services/simplefin';

/**
 * How far back a SimpleFIN sync asks.
 *
 * The incremental window was a fixed 30 days whatever the gap, so an app left closed for six weeks
 * asked only for the last 30 and never fetched the 12 days before them. Reconciliation would show
 * the hole later as an unexplained residual; the sync itself said nothing.
 */

const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const daysBefore = (n: number): string => new Date(NOW - n * 86_400_000).toISOString();

test('HEALTHY: an hourly sync asks for the ordinary 30-day window', () => {
  assert.equal(simplefinLookbackDays(daysBefore(1 / 24), NOW), 30);
});

test('HEALTHY: a gap inside the window does not widen it', () => {
  assert.equal(simplefinLookbackDays(daysBefore(12), NOW), 30);
});

test('a gap longer than the window reaches back past the last pull', () => {
  const asked = simplefinLookbackDays(daysBefore(45), NOW);
  assert.ok(asked >= 45, `asked for ${asked} days after a 45-day gap`);
  assert.equal(asked, 47);
});

test('a brand-new or force-resynced connection asks for the full backlog', () => {
  assert.equal(simplefinLookbackDays(null, NOW), 730);
  assert.equal(simplefinLookbackDays(undefined, NOW), 730);
});

test('an unparseable last_synced_at raises instead of guessing a window', () => {
  assert.throws(() => simplefinLookbackDays('not a date', NOW), /not a timestamp/);
});
