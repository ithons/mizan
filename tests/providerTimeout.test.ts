import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import http from 'node:http';
import axios from 'axios';
import { PROVIDER_HTTP_TIMEOUT_MS } from '../server/src/services/httpTimeouts';
import { defaultIsRetryable, withRetry } from '../server/src/services/retry';

const ROOT = join(__dirname, '..');

/** Source with comments stripped, so a comment naming an API is not read as a call to it. */
function code(relPath: string): string {
  return readFileSync(join(ROOT, relPath), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

/**
 * Every outbound provider call is bounded.
 *
 * Axios waits forever by default and none of the four sites set a timeout, while `retry.ts` treats
 * a statusless error (a hung socket) as retryable and tries three times. So one dead socket could
 * hold `runFullSync` open indefinitely and the hourly scheduler skipped passes behind it.
 */
test('every axios call site sets a timeout', () => {
  const files = [
    'server/src/services/simplefin.ts',
    'server/src/services/coinbase.ts',
    'server/src/routes/simplefin.ts',
  ];

  let sitesChecked = 0;
  for (const file of files) {
    const src = code(file);
    // Every way this codebase actually invokes axios, excluding the import line.
    // The generic in `axios.get<{ data: ... }>(` sits between the method and the paren.
    const callSite = /axios(?:\s*\.\s*(?:create|get|post|put|request)\s*(?:<[^(]*>)?\s*)?\(/g;
    let match: RegExpExecArray | null;
    while ((match = callSite.exec(src)) !== null) {
      sitesChecked++;
      // The options object follows the call. 400 chars covers the longest of them (the signed
      // Coinbase request, which carries headers) without reaching the next statement.
      const window = src.slice(match.index, match.index + 400);
      assert.match(
        window,
        /PROVIDER_HTTP_TIMEOUT_MS/,
        `an outbound call in ${file} sets no timeout, so it waits forever:\n${window.slice(0, 160)}`
      );
    }
  }

  // Guards the guard: if a call site is renamed out of the pattern this test goes quiet, and a
  // silent pass here is exactly the failure mode it exists to prevent.
  assert.equal(sitesChecked, 4, `expected 4 outbound axios call sites, found ${sitesChecked}`);
});

test('a hung server is abandoned rather than waited on forever', async () => {
  // A socket that accepts the connection and then never answers, which is the case a missing
  // timeout cannot escape and the OS may hold open for many minutes.
  const server = http.createServer(() => {
    /* deliberately never responds */
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;

  const started = Date.now();
  await assert.rejects(
    () => axios.get(`http://127.0.0.1:${port}/hang`, { timeout: 250 }),
    (err: unknown) => {
      const code = (err as { code?: string }).code;
      return code === 'ECONNABORTED' || code === 'ETIMEDOUT';
    },
    'a hung request did not time out'
  );
  assert.ok(Date.now() - started < 5000, 'the request outlived its own timeout');

  server.close();
});

test('a statusless network error is retryable, which is why the timeout has to exist', () => {
  // This is the amplifier: without a timeout, `withRetry` turns one unbounded wait into three.
  assert.equal(defaultIsRetryable({ isAxiosError: true }), true);
  assert.equal(defaultIsRetryable({ isAxiosError: true, response: { status: 500 } }), true);
  assert.equal(defaultIsRetryable({ isAxiosError: true, response: { status: 402 } }), false);
});

test('the bound times the attempts stays inside the default sync interval', async () => {
  // MIZAN_SYNC_INTERVAL_MINUTES defaults to 60. A provider stage that could outlive that would
  // stack runs behind it, which is the failure the AI call already argues about for itself.
  const MAX_ATTEMPTS = 3;
  assert.ok(
    (PROVIDER_HTTP_TIMEOUT_MS * MAX_ATTEMPTS) / 60_000 < 60,
    'timeout x attempts can outlive the sync interval'
  );

  // And the retry helper really does stop at three attempts.
  let calls = 0;
  await assert.rejects(() =>
    withRetry(async () => {
      calls++;
      throw { isAxiosError: true };
    }, { baseDelayMs: 1 })
  );
  assert.equal(calls, MAX_ATTEMPTS);
});
