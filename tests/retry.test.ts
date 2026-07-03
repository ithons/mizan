import test from 'node:test';
import assert from 'node:assert/strict';
import { withRetry, defaultIsRetryable } from '../server/src/services/retry';
import { CoinbaseApiError } from '../server/src/services/coinbase';

test('withRetry: succeeds on the first try without delay', async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls++;
    return 'ok';
  });

  assert.equal(result, 'ok');
  assert.equal(calls, 1);
});

test('withRetry: succeeds after transient failures within maxAttempts', async () => {
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls++;
      if (calls < 3) throw new Error('transient');
      return 'ok';
    },
    { maxAttempts: 3, baseDelayMs: 1, isRetryable: () => true }
  );

  assert.equal(result, 'ok');
  assert.equal(calls, 3);
});

test('withRetry: exhausts attempts and throws the last error', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls++;
        throw new Error(`fail ${calls}`);
      },
      { maxAttempts: 3, baseDelayMs: 1, isRetryable: () => true }
    ),
    /fail 3/
  );
  assert.equal(calls, 3);
});

test('withRetry: does not retry when isRetryable returns false', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls++;
        throw new Error('permanent');
      },
      { maxAttempts: 3, baseDelayMs: 1, isRetryable: () => false }
    ),
    /permanent/
  );
  assert.equal(calls, 1);
});

test('defaultIsRetryable: axios-shaped error with no response is retryable (network failure)', () => {
  const err = { isAxiosError: true };
  assert.equal(defaultIsRetryable(err), true);
});

test('defaultIsRetryable: axios-shaped 5xx is retryable', () => {
  const err = { isAxiosError: true, response: { status: 503 } };
  assert.equal(defaultIsRetryable(err), true);
});

test('defaultIsRetryable: axios-shaped 4xx is not retryable', () => {
  const err = { isAxiosError: true, response: { status: 401 } };
  assert.equal(defaultIsRetryable(err), false);
});

test('defaultIsRetryable: CoinbaseApiError with 5xx status is retryable', () => {
  const err = new CoinbaseApiError('Coinbase API error (500): boom', 500);
  assert.equal(defaultIsRetryable(err), true);
});

test('defaultIsRetryable: CoinbaseApiError with 4xx status is not retryable', () => {
  const err = new CoinbaseApiError('Coinbase API error (401): boom', 401);
  assert.equal(defaultIsRetryable(err), false);
});

test('defaultIsRetryable: plain Error (no status, not axios-shaped) is not retryable', () => {
  const err = new Error('unstructured failure');
  assert.equal(defaultIsRetryable(err), false);
});
