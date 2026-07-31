import fs from 'fs';
import os from 'os';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';

/**
 * Single place the app decides whether it can talk to Anthropic, and how.
 *
 * Every AI path used to hardcode `new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })`, which
 * silently disabled the advisor, the background worker, and category suggestions for anyone
 * authenticating any other way — the key is only ONE of the credentials the SDK understands.
 *
 * The SDK resolves credentials itself, first match wins:
 *   1. ANTHROPIC_API_KEY
 *   2. ANTHROPIC_AUTH_TOKEN        (e.g. a short-lived OAuth access token)
 *   3. an OAuth profile from `ant auth login`, stored under the Anthropic config dir
 *
 * So the client is constructed bare and the SDK picks whichever is present. This function's only
 * job is to answer "is there anything to authenticate with?" without throwing.
 */

function configDir(): string {
  return process.env.ANTHROPIC_CONFIG_DIR ?? path.join(os.homedir(), '.config', 'anthropic');
}

/** True when an `ant auth login` profile exists on disk. */
function hasOAuthProfile(): boolean {
  try {
    const credentials = path.join(configDir(), 'credentials');
    return fs.existsSync(credentials) && fs.readdirSync(credentials).some((f) => f.endsWith('.json'));
  } catch {
    return false; // An unreadable config dir means "no profile", never a crash.
  }
}

export function hasAnthropicCredentials(): boolean {
  return Boolean(
    process.env.ANTHROPIC_API_KEY ||
    process.env.ANTHROPIC_AUTH_TOKEN ||
    process.env.ANTHROPIC_PROFILE ||
    hasOAuthProfile()
  );
}

/** Describes the credential in use, for settings/status surfaces. Never returns the secret. */
export function anthropicCredentialSource(): 'api_key' | 'auth_token' | 'oauth_profile' | 'none' {
  if (process.env.ANTHROPIC_API_KEY) return 'api_key';
  if (process.env.ANTHROPIC_AUTH_TOKEN) return 'auth_token';
  if (process.env.ANTHROPIC_PROFILE || hasOAuthProfile()) return 'oauth_profile';
  return 'none';
}

/**
 * Per-request wall clock for every client this factory builds.
 *
 * The SDK's own defaults are a 600_000 ms timeout and 2 retries (`BaseAnthropic.DEFAULT_TIMEOUT`
 * and the `maxRetries` fallback in `@anthropic-ai/sdk/client.js`), and a timed-out request is
 * itself retried, so a wedged call can hold a caller for 30 minutes. That is not survivable for
 * the background worker, whose `workerRunning` re-entrancy guard turns one hang into every
 * subsequent review pass being skipped, silently, for as long as it lasts.
 *
 * Five minutes bounds each caller that takes this default by `timeout x (maxRetries + 1)`:
 * `aiWorker.ts` passes `maxRetries: 1`, so two attempts cap it at 10 minutes, inside the default
 * 60-minute sync cadence that fires it (`DEFAULT_SYNC_INTERVAL_MINUTES` in `index.ts`);
 * `aiCategorySuggest.ts` keeps the SDK's 2 retries, so three attempts cap it at 15. It does NOT
 * bound the chat route, which overrides the timeout on the request itself (`routes/ai.ts`) and
 * keeps the SDK's 2 retries, giving that path a 30-minute worst case.
 */
export const DEFAULT_ANTHROPIC_TIMEOUT_MS = 300_000;

export interface AnthropicClientOptions {
  /** SDK retry count. Total wall clock is `DEFAULT_ANTHROPIC_TIMEOUT_MS x (maxRetries + 1)`. */
  maxRetries?: number;
}

/** A client, or null when nothing is configured. Callers must handle null rather than throwing. */
export function getAnthropicClient(options: AnthropicClientOptions = {}): Anthropic | null {
  if (!hasAnthropicCredentials()) return null;
  // No apiKey on purpose: the SDK applies the credential resolution order documented above.
  return new Anthropic({
    timeout: DEFAULT_ANTHROPIC_TIMEOUT_MS,
    ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
  });
}

export type AnthropicResponseProblem = 'refusal' | 'empty_content' | 'no_text_block';

/** A 200 that carries no usable answer. Thrown so it can never read as "no results". */
export class AnthropicResponseError extends Error {
  constructor(readonly problem: AnthropicResponseProblem, message: string) {
    super(message);
    this.name = 'AnthropicResponseError';
  }
}

/**
 * Extracts the assistant's text from a response, or throws.
 *
 * Two failure modes here are 200s, not exceptions, and both used to resolve to `''` and
 * take an early return that was indistinguishable from "the model had nothing to say":
 *
 *  - adaptive thinking makes `content[0]` a thinking block, so reading the first block
 *    alone finds no text even on a perfectly good answer;
 *  - a safety classifier can decline with `stop_reason: 'refusal'` and an empty `content`.
 *
 * So this reads every text block, and raises on refusal or on a response with no text at
 * all. Callers that legitimately expect a non-text turn (a tool_use round) must not use it.
 */
export function readModelText(response: Anthropic.Message): string {
  if (response.stop_reason === 'refusal') {
    const detail = response.stop_details?.explanation ?? response.stop_details?.category ?? null;
    throw new AnthropicResponseError(
      'refusal',
      `Model declined the request${detail ? `: ${detail}` : '.'}`
    );
  }
  if (response.content.length === 0) {
    throw new AnthropicResponseError(
      'empty_content',
      `Model returned no content blocks (stop_reason: ${response.stop_reason ?? 'null'}).`
    );
  }

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');

  if (!text.trim()) {
    const kinds = [...new Set(response.content.map((block) => block.type))].join(', ');
    throw new AnthropicResponseError(
      'no_text_block',
      `Model returned no text (blocks: ${kinds}; stop_reason: ${response.stop_reason ?? 'null'}).`
    );
  }
  return text;
}
