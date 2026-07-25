import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeQueryFailures } from '../client/src/components/QueryErrorBanner';

function q(isError: boolean, error: unknown = null) {
  return { isError, error, refetch: () => undefined };
}

test('no banner when every query succeeded', () => {
  assert.equal(
    summarizeQueryFailures([
      { query: q(false), label: 'goals' },
      { query: q(false), label: 'budgets' },
    ]),
    null
  );
});

test('names only the queries that actually failed', () => {
  const summary = summarizeQueryFailures([
    { query: q(false), label: 'goals' },
    { query: q(true, new Error('Failed to fetch')), label: 'budgets' },
    { query: q(false), label: 'accounts' },
  ]);

  assert.deepEqual(summary?.labels, ['budgets']);
  assert.equal(summary?.detail, 'Failed to fetch');
});

test('reports one detail message even when several queries fail', () => {
  const summary = summarizeQueryFailures([
    { query: q(true, new Error('500 Internal Server Error')), label: 'goals' },
    { query: q(true, new Error('500 Internal Server Error')), label: 'budgets' },
  ]);

  // Repeating an identical message per query is noise; the labels already say what is missing.
  assert.deepEqual(summary?.labels, ['goals', 'budgets']);
  assert.equal(summary?.detail, '500 Internal Server Error');
});

test('a failure with no Error object still raises the banner', () => {
  const summary = summarizeQueryFailures([{ query: q(true, 'just a string'), label: 'insights' }]);

  assert.deepEqual(summary?.labels, ['insights']);
  // No message to show rather than printing something meaningless.
  assert.equal(summary?.detail, null);
});

test('picks the first message available when an earlier failure has none', () => {
  const summary = summarizeQueryFailures([
    { query: q(true, null), label: 'goals' },
    { query: q(true, new Error('Network request failed')), label: 'budgets' },
  ]);

  assert.equal(summary?.detail, 'Network request failed');
});
