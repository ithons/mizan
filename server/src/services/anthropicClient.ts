import Anthropic from '@anthropic-ai/sdk';
import { resolveCredential, type CredentialSource } from './aiProviders/credentials';

/**
 * Single place the app decides whether it can talk to Anthropic, and how.
 *
 * Every AI path used to hardcode `new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })`, which
 * silently disabled the advisor, the background worker, and category suggestions for anyone
 * authenticating any other way: the key is only ONE of the credentials the SDK understands.
 *
 * The SDK resolves credentials itself, first match wins:
 *   1. ANTHROPIC_API_KEY
 *   2. ANTHROPIC_AUTH_TOKEN        (e.g. a short-lived OAuth access token)
 *   3. an OAuth profile from `ant auth login`, stored under the Anthropic config dir
 *
 * So when one of those is present the client is constructed bare and the SDK picks it. Phase 10
 * adds a fourth source below all of them, the encrypted `.mizan/credentials.json` store, which
 * the SDK knows nothing about and therefore has to be passed explicitly. The ordering lives in
 * `aiProviders/credentials.ts` because OpenAI and Gemini resolve the same way minus the OAuth
 * profile, which is Anthropic's alone.
 */

export function hasAnthropicCredentials(): boolean {
  return resolveCredential('anthropic').source !== 'none';
}

/** Describes the credential in use, for settings/status surfaces. Never returns the secret. */
export function anthropicCredentialSource(): CredentialSource {
  return resolveCredential('anthropic').source;
}

/**
 * Per-request wall clock for the Anthropic adapter's one-shot calls.
 *
 * The SDK's own defaults are a 600_000 ms timeout and 2 retries (`BaseAnthropic.DEFAULT_TIMEOUT`
 * and the `maxRetries` fallback in `@anthropic-ai/sdk/client.js`), and a timed-out request is
 * itself retried, so a wedged call can hold a caller for 30 minutes. That is not survivable for
 * the background worker, whose per-job re-entrancy guard turns one hang into every subsequent
 * review pass being skipped, silently, for as long as it lasts.
 *
 * Five minutes bounds each caller by `timeout x (maxRetries + 1)`: the worker passes
 * `maxRetries: 1`, so two attempts cap it at 10 minutes, inside the default 60-minute sync
 * cadence that fires it (`DEFAULT_SYNC_INTERVAL_MINUTES` in `index.ts`); the classifier passes
 * 2, so three attempts cap it at 15. The chat route sets its own longer timeout because the
 * owner is watching it. The same arithmetic holds on OpenAI, whose measured defaults are
 * identical; Gemini makes ONE attempt unless retries are asked for, so there the number
 * supplies a retry rather than lowering one.
 */
export const DEFAULT_ANTHROPIC_TIMEOUT_MS = 300_000;

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
