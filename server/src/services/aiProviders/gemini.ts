import {
  ApiError,
  GoogleGenAI,
  ThinkingLevel,
  type CachedContent,
  type Content,
  type GenerateContentConfig,
  type GenerateContentResponse,
  type GenerateContentResponseUsageMetadata,
  type Part,
  type Tool,
} from '@google/genai';
import type { AdvisorEffort } from '../../../../shared/types';
import { MODEL_CAPABILITIES, clampEffort } from '../advisorSettings';
import { resolveCredential } from './credentials';
import {
  ProviderResponseError,
  addUsage,
  emptyUsage,
  type AdvisorToolSpec,
  type AiProvider,
  type ChatEmit,
  type ChatFailure,
  type ChatRequest,
  type ChatResult,
  type ProviderUsage,
  type StructuredRequest,
  type TextRequest,
  type TextResult,
} from './types';

/**
 * Gemini through `ai.models.generateContent*` (the Generate Content API).
 *
 * Google now ships two request surfaces in `@google/genai` and recommends the newer one on
 * every doc page. This app uses the older one deliberately: the Interactions API supports
 * implicit caching only, and explicit caching is the whole reason sending the complete
 * financial picture on every turn is affordable. That is a stated trade, not an oversight.
 *
 * Four shapes here have no counterpart on the other two providers:
 *
 *  1. Caching is a stateful RESOURCE, not a marker. `caches.create` returns a named object
 *     with an expiry and a per-hour storage bill, and a request that names it may not also
 *     send `systemInstruction`, `tools` or `toolConfig`; the API rejects that combination.
 *     So the system prompt AND the tool list move into the cache, and the per-request config
 *     carries generation parameters only.
 *  2. Retries are OFF by default. The other two SDKs retry 429s and 5xx on their own; this
 *     one makes exactly one attempt unless `retryOptions` is supplied.
 *  3. `ApiError.message` is the raw JSON body, so streaming it to the owner's chat pane would
 *     render a JSON blob. `describeError` composes a sentence from `.status` instead.
 *  4. Gemini 3 attaches an opaque `thoughtSignature` to parts including function calls, and
 *     the thinking docs say to return the entire response with all parts unmodified on the
 *     next turn. The model turn is therefore replayed part-for-part rather than rebuilt.
 */

const DEFAULT_TIMEOUT_MS = 300_000;

/**
 * How long a chat's explicit cache lives.
 *
 * Short on purpose. The cache exists to serve the tool rounds of ONE request, and storage is
 * billed for the TTL whether or not anything reads it, so a long-lived entry over an unstable
 * prefix is rent on a prefix that will not match. It is deleted when the request ends; the TTL
 * is the backstop for a process that dies before it can.
 */
const CACHE_TTL_SECONDS = 600;

const THINKING_LEVEL: Readonly<Record<AdvisorEffort, ThinkingLevel | undefined>> = {
  // Three rungs share a name with a mizan effort. `xhigh` and `max` have no Gemini
  // counterpart, and `clampEffort` never hands them here because the capability table does
  // not offer them for a Gemini model; the undefined entries make that structural.
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
  xhigh: undefined,
  max: undefined,
};

function client(options: { maxRetries?: number; timeoutMs?: number } = {}): GoogleGenAI {
  const credential = resolveCredential('gemini');
  if (!credential.apiKey) {
    throw new Error('No Gemini credentials found. Set GEMINI_API_KEY in .env, or store a key in Settings.');
  }
  return new GoogleGenAI({
    apiKey: credential.apiKey,
    httpOptions: {
      // Milliseconds. The retry delays in the same object are in FRACTIONS OF A SECOND,
      // which is a thousand-fold difference inside one config block.
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      // Measured against a local server returning 429: a client with no retryOptions makes
      // exactly one attempt. Callers that relied on an SDK's built-in retries get none here
      // unless this is set.
      ...(options.maxRetries === undefined ? {} : { retryOptions: { attempts: options.maxRetries + 1 } }),
      ...(process.env.GEMINI_BASE_URL ? { baseUrl: process.env.GEMINI_BASE_URL } : {}),
    },
  });
}

function toTools(tools: readonly AdvisorToolSpec[]): Tool[] {
  return [
    {
      functionDeclarations: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        // `parametersJsonSchema` takes plain JSON Schema and is mutually exclusive with
        // `parameters`, which wants the uppercase-enum OpenAPI subset.
        parametersJsonSchema: tool.parameters,
      })),
    },
  ];
}

function thinkingConfig(model: string, effort: AdvisorEffort | undefined): GenerateContentConfig['thinkingConfig'] {
  const caps = MODEL_CAPABILITIES[model];
  // Sending thinkingConfig to a model with no thinking is an error, which is the same
  // failure class the capability table exists to prevent.
  if (!caps || caps.provider !== 'gemini' || !caps.reasoning) return undefined;
  const level = effort ? THINKING_LEVEL[effort] : undefined;
  return {
    // Opt-in: without this you pay for reasoning you cannot show.
    includeThoughts: true,
    ...(level ? { thinkingLevel: level } : {}),
  };
}

/**
 * `promptTokenCount` INCLUDES `cachedContentTokenCount` (the field's own doc comment), the
 * opposite of Anthropic. `cacheWriteTokens` is null because a Gemini cache write is a
 * separate API call whose size is reported on the CachedContent, not on a generate response.
 */
function readUsage(usage: GenerateContentResponseUsageMetadata | undefined): ProviderUsage {
  if (!usage) return emptyUsage();
  const cached = usage.cachedContentTokenCount ?? 0;
  return {
    uncachedInputTokens: Math.max(0, (usage.promptTokenCount ?? 0) - cached),
    cacheReadTokens: cached,
    cacheWriteTokens: null,
    outputTokens: usage.candidatesTokenCount ?? 0,
  };
}

/** A sentence, from a provider whose error message is a JSON body. */
function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 429) return 'Gemini rate-limited the request (HTTP 429). Try again shortly.';
    if (err.status === 401 || err.status === 403) return 'Gemini rejected the credentials (HTTP ' + err.status + ').';
    return `Gemini returned HTTP ${err.status}.`;
  }
  return (err as Error).message || 'The Gemini request failed.';
}

/**
 * The ways a 200 carries no answer here, and the first one is the nastiest: a blocked prompt
 * returns `candidates` UNDEFINED with `promptFeedback.blockReason` set, so anything reading
 * `response.text` gets `undefined` and no exception.
 */
function failureOf(response: GenerateContentResponse): ChatFailure | null {
  const blockReason = response.promptFeedback?.blockReason;
  if (blockReason) {
    return { kind: 'refusal', message: `The model declined to answer: ${blockReason}` };
  }
  const candidate = response.candidates?.[0];
  if (!candidate) return { kind: 'empty', message: 'The model returned an empty response.' };

  switch (candidate.finishReason) {
    case 'MAX_TOKENS':
      return { kind: 'truncated', message: 'The answer hit the output cap before it finished. Ask again, more narrowly.' };
    case 'SAFETY':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
    case 'BLOCKLIST':
      // No stop_details equivalent to interpolate, so the enum member is said and nothing
      // about a cause is invented.
      return { kind: 'content_filter', message: `The answer was withheld: ${candidate.finishReason}.` };
    case 'RECITATION':
      return { kind: 'content_filter', message: 'The answer was withheld: RECITATION.' };
    case 'MALFORMED_FUNCTION_CALL':
    case 'UNEXPECTED_TOOL_CALL':
      return { kind: 'empty', message: `The model produced an unusable tool call: ${candidate.finishReason}.` };
    default:
      return null;
  }
}

// ─── The explicit cache ──────────────────────────────────────────────────────

interface CacheAttempt {
  cache: CachedContent | null;
  note: string;
}

/**
 * Creates the turn's cache, or explains why it could not.
 *
 * Failure is a legible fallback rather than an error: below the model's minimum token count
 * `caches.create` returns a 400, and the right response is to send the prompt and tools
 * inline and say so, not to fail the owner's question.
 *
 * Called LAZILY, only once a round has actually asked for a tool. Creating it up front is a
 * cost regression on the commonest question: `caches.create` bills the prefix at the full
 * input rate, so a single round that reads it back once pays a full write plus a read plus
 * storage where sending the prompt inline would have paid one full read and nothing else.
 * Deferring until a second round exists means this mechanism is never worse than not caching.
 */
async function createCache(
  ai: GoogleGenAI,
  request: ChatRequest
): Promise<CacheAttempt> {
  try {
    const cache = await ai.caches.create({
      model: request.model,
      config: {
        displayName: 'mizan-advisor',
        ttl: `${CACHE_TTL_SECONDS}s`,
        systemInstruction: request.systemText,
        tools: toTools(request.tools),
      },
    });
    const cached = cache.usageMetadata?.totalTokenCount ?? 0;
    return { cache, note: `explicit cache ${cache.name ?? 'unnamed'} holds ${cached} tok` };
  } catch (err) {
    const minimum = MODEL_CAPABILITIES[request.model]?.caching.minimumPrefixTokens;
    return {
      cache: null,
      note: `explicit cache not created (${describeError(err)}); prompt and tools sent inline, uncached${minimum ? `; the prefix must reach ${minimum} tokens` : ''}`,
    };
  }
}

async function deleteCache(ai: GoogleGenAI, cache: CachedContent | null): Promise<void> {
  if (!cache?.name) return;
  try {
    await ai.caches.delete({ name: cache.name });
  } catch (err) {
    // Best-effort, but never silent: an undeleted cache keeps billing storage until its TTL.
    console.warn(`[gemini] could not delete cache ${cache.name}: ${describeError(err)}`);
  }
}

// ─── Chat ────────────────────────────────────────────────────────────────────

async function streamChat(request: ChatRequest, emit: ChatEmit): Promise<ChatResult> {
  const ai = client({ timeoutMs: request.timeoutMs });
  const contents: Content[] = request.turns.map((turn) => ({
    role: turn.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: turn.content }],
  }));

  // Built on the first tool round, not up front. See createCache.
  let attempt: CacheAttempt = { cache: null, note: 'no cache: the turn answered in one round' };
  let usage = emptyUsage();
  let answered = false;

  try {
    for (let round = 0; round < request.maxToolRounds; round++) {
      const config: GenerateContentConfig = {
        maxOutputTokens: request.maxOutputTokens,
        thinkingConfig: thinkingConfig(request.model, clampEffort(request.model, request.effort)),
        httpOptions: { timeout: request.timeoutMs },
        // A request naming a cache may not also carry systemInstruction/tools/toolConfig:
        // the API answers 400 `CachedContent can not be used with GenerateContent request
        // setting system_instruction, tools or tool_config`.
        ...(attempt.cache?.name
          ? { cachedContent: attempt.cache.name }
          : { systemInstruction: request.systemText, tools: toTools(request.tools) }),
      };

      const stream = await ai.models.generateContentStream({ model: request.model, contents, config });

      // Every part is kept verbatim, in order. Gemini 3 attaches `thoughtSignature` to parts
      // including function calls and the docs say not to concatenate, merge or modify them,
      // so the model turn is replayed exactly as received rather than rebuilt from the text.
      const modelParts: Part[] = [];
      let thinkingOpen = false;
      let last: GenerateContentResponse | null = null;
      // This round's figures, kept separate from the running total. `usageMetadata` is a
      // RUNNING TOTAL restated on the chunks that carry it, not a per-chunk increment, so
      // within a round the last one seen is the round's whole cost; summing the chunks would
      // multiply it. Across rounds it is the opposite: each round is a fresh request with its
      // own count, so the rounds have to be added or only the last one is ever billed for.
      let roundUsage: ProviderUsage | null = null;

      for await (const chunk of stream) {
        last = chunk;
        if (chunk.usageMetadata) roundUsage = readUsage(chunk.usageMetadata);
        // Not `chunk.text`: measured, that getter returns undefined and logs to the console
        // when a functionCall part is present, and its own docstring says it drops thought
        // parts and reads candidate 0 only.
        for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
          modelParts.push(part);
          if (part.functionCall?.name) {
            emit({ type: 'tool_use', name: part.functionCall.name });
          } else if (typeof part.text === 'string' && part.text.length > 0) {
            if (part.thought === true) {
              // There is no thinking_start/_end event here; both boundaries are synthesised
              // from the `thought` flag turning on and off.
              if (!thinkingOpen) {
                thinkingOpen = true;
                emit({ type: 'thinking_start' });
              }
              emit({ type: 'thinking', text: part.text });
            } else {
              if (thinkingOpen) {
                thinkingOpen = false;
                emit({ type: 'thinking_end' });
              }
              emit({ type: 'chunk', text: part.text });
            }
          }
        }
      }
      if (thinkingOpen) emit({ type: 'thinking_end' });
      // Before every exit below, so a round that ended in a failure still reports what it cost.
      if (roundUsage) usage = addUsage(usage, roundUsage);

      if (!last) {
        return {
          answered: false,
          failure: { kind: 'empty', message: 'The model returned an empty response.' },
          usage,
          cacheNote: cacheNote(attempt, usage),
        };
      }

      const failure = failureOf(last);
      if (failure) return { answered: false, failure, usage, cacheNote: cacheNote(attempt, usage) };

      const calls = modelParts.filter((part) => part.functionCall?.name);
      if (calls.length === 0) {
        answered = true;
        break;
      }

      // A tool round means at least one more request with the same prefix, which is the
      // point at which a cache starts paying for itself.
      if (!attempt.cache) attempt = await createCache(ai, request);

      contents.push({ role: 'model', parts: modelParts });
      contents.push({
        role: 'user',
        parts: calls.map((part) => ({
          functionResponse: {
            // `id` is optional in the type where Anthropic's tool_use.id is required, so it
            // is forwarded only when the model actually supplied one.
            ...(part.functionCall?.id ? { id: part.functionCall.id } : {}),
            name: part.functionCall?.name,
            // An OBJECT, not a JSON string. `{result: ...}` is the documented convention.
            response: { result: request.runTool(part.functionCall?.name ?? '', part.functionCall?.args ?? {}) },
          },
        })),
      });
    }
  } finally {
    await deleteCache(ai, attempt.cache);
  }

  if (!answered) {
    return {
      answered: false,
      failure: {
        kind: 'rounds_exhausted',
        message: `The advisor stopped after ${request.maxToolRounds} tool rounds without finishing its answer. Ask again, more narrowly.`,
      },
      usage,
      cacheNote: cacheNote(attempt, usage),
    };
  }
  return { answered: true, usage, cacheNote: cacheNote(attempt, usage) };
}

function cacheNote(attempt: CacheAttempt, usage: ProviderUsage): string {
  return `${attempt.note}; read ${usage.cacheReadTokens} tok back`;
}

// ─── One-shot calls ──────────────────────────────────────────────────────────

async function createOnce(
  request: StructuredRequest | TextRequest,
  schema?: Record<string, unknown>
): Promise<TextResult> {
  const ai = client({ maxRetries: request.maxRetries, timeoutMs: request.timeoutMs });
  const caps = MODEL_CAPABILITIES[request.model];

  // No explicit cache on this path. The worker's prefix is unstable by construction and it
  // fires hourly, so an explicit cache would pay storage for a prefix that never matches.
  // Gemini's implicit prefix matching still applies for free, with no guarantee.
  const response = await ai.models.generateContent({
    model: request.model,
    contents: [{ role: 'user', parts: [{ text: request.userText }] }],
    config: {
      systemInstruction: request.systemText,
      maxOutputTokens: request.maxOutputTokens,
      thinkingConfig: thinkingConfig(request.model, request.effort ? clampEffort(request.model, request.effort) : undefined),
      httpOptions: { timeout: request.timeoutMs },
      ...(schema && caps?.structuredOutput
        ? { responseMimeType: 'application/json', responseJsonSchema: schema }
        : {}),
    },
  });

  const failure = failureOf(response);
  if (failure && failure.kind !== 'truncated') throw new ProviderResponseError('gemini', failure);

  const text = (response.candidates?.[0]?.content?.parts ?? [])
    .filter((part) => part.thought !== true && typeof part.text === 'string')
    .map((part) => part.text)
    .join('')
    .trim();

  if (!text) {
    throw new ProviderResponseError('gemini', {
      kind: 'empty',
      message: 'The model returned no text.',
    });
  }

  return {
    text,
    usage: readUsage(response.usageMetadata),
    truncated: response.candidates?.[0]?.finishReason === 'MAX_TOKENS',
  };
}

export const geminiProvider: AiProvider = {
  id: 'gemini',
  isConfigured: () => resolveCredential('gemini').source !== 'none',
  streamChat,
  generateStructured: (request) => createOnce(request, request.schema),
  generateText: (request) => createOnce(request),
};
