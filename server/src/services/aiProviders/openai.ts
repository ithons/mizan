import OpenAI from 'openai';
import type { ResponseInput, ResponseInputItem } from 'openai/resources/responses/responses';
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
 * OpenAI through the Responses API (`POST /v1/responses`).
 *
 * Chat Completions still exists, but Responses is the surface that carries reasoning, effort,
 * explicit cache breakpoints and the typed tool loop, so it is the only one this app targets.
 *
 * Three shapes here have no Anthropic counterpart and each is load-bearing:
 *
 *  1. `instructions` is typed `string | null`, so it cannot carry a content block and
 *     therefore cannot carry a cache breakpoint. The financial context does NOT ride there;
 *     it is the first item of `input`, as a `developer` message whose `input_text` block
 *     holds `prompt_cache_breakpoint`. This is the largest structural change the port forces.
 *  2. `prompt_cache_key` must be sent for reliable cache matching on gpt-5.6 and later.
 *     Omitting it is the single easiest way to get a correct-looking request with a 0% hit
 *     rate, which is why it is a constant here rather than an option.
 *  3. `usage.input_tokens` is the TOTAL and `cached_tokens` is a subset of it, the opposite
 *     of Anthropic. `readUsage` subtracts; copying Anthropic's arithmetic would overstate
 *     uncached input by the entire cached prefix on every hit.
 */

/**
 * One key for the whole app. The guide asks that traffic per key stay near or below roughly
 * 15 requests a minute, which a single-owner loopback ledger satisfies with one constant.
 */
const PROMPT_CACHE_KEY = 'mizan-advisor';

const DEFAULT_TIMEOUT_MS = 300_000;

function client(options: { maxRetries?: number; timeoutMs?: number } = {}): OpenAI {
  const credential = resolveCredential('openai');
  if (credential.source === 'none') {
    throw new Error('No OpenAI credentials found. Set OPENAI_API_KEY in .env, or store a key in Settings.');
  }
  // Passed only for a stored key: the SDK resolves OPENAI_API_KEY and OPENAI_BASE_URL itself,
  // and OPENAI_BASE_URL is the hook the request-shape tests point at a local server.
  return new OpenAI({
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...(credential.source === 'stored' && credential.apiKey ? { apiKey: credential.apiKey } : {}),
    ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
  });
}

function toTools(tools: readonly AdvisorToolSpec[]): OpenAI.Responses.FunctionTool[] {
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    // `strict: true` subjects the tool schema to the structured-output subset. The advisor
    // tools carry optional filter properties by design, which that subset forbids, so this
    // stays false rather than quietly dropping half of every tool's parameters.
    strict: false,
  }));
}

/** The cacheable prefix, as the one input item a breakpoint can be attached to. */
function cachedPrefixItem(systemText: string): ResponseInputItem {
  return {
    role: 'developer',
    content: [
      {
        type: 'input_text',
        text: systemText,
        prompt_cache_breakpoint: { mode: 'explicit' },
      },
    ],
  };
}

/**
 * The `reasoning` block for `model`, or nothing if it has no dial to set.
 *
 * `summary` IS NOT UNCONDITIONAL, and both halves of that matter.
 *
 * It is asked for only where something reads it, which is the streaming chat and nowhere else:
 * `createOnce` returns `response.output_text`, which joins `output_text` parts only, so a
 * summary requested there is reasoning-summary output that is generated, billed and dropped.
 *
 * And it is the one parameter here that an organization may not be entitled to send at all.
 * The reasoning guide states: "Before using summarizers with our latest reasoning models, you
 * may need to complete organization verification to ensure safe deployment." An unverified
 * org gets HTTP 400 `param: 'reasoning.summary'`, which would take out every OpenAI call site
 * rather than the one display nicety it actually blocks. See `summaryUnavailable`.
 */
function reasoningFor(
  model: string,
  effort?: string,
  summary?: 'auto'
): OpenAI.Reasoning | undefined {
  const caps = MODEL_CAPABILITIES[model];
  if (!caps || caps.provider !== 'openai' || !caps.reasoning) return undefined;
  const reasoning: OpenAI.Reasoning = {};
  if (effort) reasoning.effort = effort as OpenAI.ReasoningEffort;
  // Opt-in: without this the reasoning item comes back with an empty summary array and
  // nothing streams, which is the analogue of Anthropic's display:'omitted' default.
  if (summary) reasoning.summary = summary;
  return Object.keys(reasoning).length > 0 ? reasoning : undefined;
}

/**
 * True for the 400 that says this organization may not have reasoning summaries.
 *
 * Matched on `param` rather than on the message, because the message is prose OpenAI owns.
 * The message is checked too, and only as a fallback, for a body that names the reason
 * without filling in `param`.
 */
function summaryUnavailable(err: unknown): boolean {
  if (!(err instanceof OpenAI.APIError) || err.status !== 400) return false;
  return err.param === 'reasoning.summary' || /verified.*reasoning summaries/i.test(err.message);
}

/**
 * `input_tokens` here is the TOTAL input and `cached_tokens` is a subset of it. Proven by the
 * caching guide's own worked example (prompt 2006, cached 1920, completion 300, total 2306,
 * where 2006 + 300 = 2306). Uncached input is therefore the difference, floored at zero so a
 * provider-side inconsistency can never produce a negative token count in a log line.
 */
function readUsage(usage: OpenAI.Responses.ResponseUsage | undefined): ProviderUsage {
  if (!usage) return emptyUsage();
  const cached = usage.input_tokens_details?.cached_tokens ?? 0;
  return {
    uncachedInputTokens: Math.max(0, usage.input_tokens - cached),
    cacheReadTokens: cached,
    cacheWriteTokens: usage.input_tokens_details?.cache_write_tokens ?? null,
    outputTokens: usage.output_tokens,
  };
}

/**
 * The ways a 200 carries no answer on this provider. There is no `stop_reason`, and
 * `response.output_text` joins only `output_text` parts, so a refusal-only response yields an
 * empty string with a populated `output` array: the same silent-empty class as the
 * `content[0]` bug, needing a completely different detection.
 */
function failureOf(response: OpenAI.Responses.Response): ChatFailure | null {
  for (const item of response.output) {
    if (item.type === 'message') {
      for (const part of item.content) {
        if (part.type === 'refusal') {
          return { kind: 'refusal', message: `The model declined to answer: ${part.refusal}` };
        }
      }
    }
  }
  if (response.status === 'incomplete') {
    const reason = response.incomplete_details?.reason;
    if (reason === 'content_filter') {
      return { kind: 'content_filter', message: 'The answer was withheld by a content filter.' };
    }
    return { kind: 'truncated', message: 'The answer hit the output cap before it finished. Ask again, more narrowly.' };
  }
  if (response.status === 'failed') {
    const detail = response.error?.message ?? 'no detail given';
    return { kind: 'empty', message: `The request failed: ${detail}` };
  }
  if (response.output.length === 0) {
    return { kind: 'empty', message: 'The model returned an empty response.' };
  }
  return null;
}

/** The model's tool calls, with the argument parse behind an explicit failure path. */
interface ParsedToolCall {
  callId: string;
  name: string;
  input: Record<string, unknown>;
  parseError?: string;
}

function toolCallsOf(response: OpenAI.Responses.Response): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];
  for (const item of response.output) {
    if (item.type !== 'function_call') continue;
    // `arguments` is a JSON STRING here, where Anthropic's `tool_use.input` arrives parsed.
    // A malformed one is the model's fault and must be reported back to it, not thrown: the
    // loop can still recover on the next round if the model corrects itself.
    try {
      const parsed: unknown = JSON.parse(item.arguments);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        calls.push({ callId: item.call_id, name: item.name, input: {}, parseError: 'arguments were not a JSON object' });
        continue;
      }
      calls.push({ callId: item.call_id, name: item.name, input: parsed as Record<string, unknown> });
    } catch (err) {
      calls.push({ callId: item.call_id, name: item.name, input: {}, parseError: (err as Error).message });
    }
  }
  return calls;
}

async function streamChat(request: ChatRequest, emit: ChatEmit): Promise<ChatResult> {
  const openai = client({ timeoutMs: request.timeoutMs });
  const input: ResponseInput = [
    cachedPrefixItem(request.systemText),
    ...request.turns.map((turn) => ({ role: turn.role, content: turn.content })),
  ];

  const effort = clampEffort(request.model, request.effort);
  let summary: 'auto' | undefined = 'auto';
  let usage = emptyUsage();
  let answered = false;

  /** One streamed round, emitting as it goes. Returns the response the loop reasons about. */
  const streamRound = async (): Promise<OpenAI.Responses.Response> => {
    const reasoning = reasoningFor(request.model, effort, summary);
    const stream = openai.responses.stream({
      model: request.model,
      input,
      tools: toTools(request.tools),
      max_output_tokens: request.maxOutputTokens,
      ...(reasoning ? { reasoning } : {}),
      // Mandatory on gpt-5.6+ for reliable cache matching, and `explicit` mode suppresses the
      // automatic breakpoint so the one above is the boundary.
      prompt_cache_key: PROMPT_CACHE_KEY,
      prompt_cache_options: { mode: 'explicit' },
      // `store` defaults to TRUE, which would retain this ledger's financial context on
      // OpenAI's servers for later retrieval. A loopback single-owner app says no explicitly.
      store: false,
      // No temperature or top_p: reasoning models reject non-default sampling parameters,
      // the same trap Phase 6.0 removed for Anthropic 4.7+.
      stream_options: { include_obfuscation: false },
    });

    let thinkingOpen = false;
    for await (const event of stream) {
      if (event.type === 'response.output_text.delta') {
        emit({ type: 'chunk', text: event.delta });
      } else if (event.type === 'response.reasoning_summary_part.added') {
        if (!thinkingOpen) {
          thinkingOpen = true;
          emit({ type: 'thinking_start' });
        }
      } else if (event.type === 'response.reasoning_summary_text.delta') {
        emit({ type: 'thinking', text: event.delta });
      } else if (event.type === 'response.reasoning_summary_part.done') {
        if (thinkingOpen) {
          thinkingOpen = false;
          emit({ type: 'thinking_end' });
        }
      } else if (event.type === 'response.output_item.added' && event.item.type === 'function_call') {
        emit({ type: 'tool_use', name: event.item.name });
      }
    }
    if (thinkingOpen) emit({ type: 'thinking_end' });

    return stream.finalResponse();
  };

  for (let round = 0; round < request.maxToolRounds; round++) {
    let response: OpenAI.Responses.Response;
    try {
      response = await streamRound();
    } catch (err) {
      // The 400 arrives from request validation, before any SSE byte, so nothing has been
      // emitted and the round can simply be run again. Retried WITHOUT the summary rather
      // than failed: the answer streams from `output_text` either way, and losing the
      // owner's question over a display nicety they are not entitled to is the wrong trade.
      // Said out loud once, because silently dropping thinking output looks like a model
      // that stopped reasoning.
      if (summary === undefined || !summaryUnavailable(err)) throw err;
      console.warn(
        "[openai] This organization is not verified for reasoning summaries, so the advisor's " +
        'thinking will not be shown. Verify the organization to restore it; the answer itself is unaffected.'
      );
      summary = undefined;
      response = await streamRound();
    }
    usage = addUsage(usage, readUsage(response.usage));

    const failure = failureOf(response);
    if (failure) return { answered: false, failure, usage, cacheNote: cacheNote(usage) };

    const calls = toolCallsOf(response);
    if (calls.length === 0) {
      answered = true;
      break;
    }

    // Every output item is replayed verbatim, reasoning items included. The installed README
    // states outright that filtering `response.output` down to messages "can drop required
    // reasoning or tool-call items and cause the next request to fail". `encrypted_content`
    // is populated by default, so this works with store:false.
    for (const item of response.output) input.push(item as ResponseInputItem);

    for (const call of calls) {
      const output = call.parseError
        ? JSON.stringify({ error: `Could not read the arguments for ${call.name}: ${call.parseError}` })
        : JSON.stringify(request.runTool(call.name, call.input));
      // A tool result is a TOP-LEVEL input item here, not a content block inside a user
      // message, so there is no wrapper role to push.
      input.push({ type: 'function_call_output', call_id: call.callId, output });
    }
  }

  if (!answered) {
    return {
      answered: false,
      failure: {
        kind: 'rounds_exhausted',
        message: `The advisor stopped after ${request.maxToolRounds} tool rounds without finishing its answer. Ask again, more narrowly.`,
      },
      usage,
      cacheNote: cacheNote(usage),
    };
  }
  return { answered: true, usage, cacheNote: cacheNote(usage) };
}

function cacheNote(usage: ProviderUsage): string {
  const written = usage.cacheWriteTokens === null ? 'not reported' : `${usage.cacheWriteTokens} tok`;
  return `explicit breakpoint read ${usage.cacheReadTokens} tok, wrote ${written}`;
}

// ─── One-shot calls ──────────────────────────────────────────────────────────

async function createOnce(
  request: StructuredRequest | TextRequest,
  format?: { schema: Record<string, unknown>; name: string }
): Promise<TextResult> {
  const openai = client({ maxRetries: request.maxRetries, timeoutMs: request.timeoutMs });
  const caps = MODEL_CAPABILITIES[request.model];
  // No `summary` argument: this path returns `output_text` and never reads a reasoning item,
  // so asking for one would bill summary output that nothing consumes, and would fail the
  // hourly worker and the classifier outright on an organization that cannot have summaries.
  const reasoning = reasoningFor(
    request.model,
    request.effort ? clampEffort(request.model, request.effort) : undefined
  );

  const response = await openai.responses.create({
    model: request.model,
    // No breakpoint and no cache key on this path on purpose: the callers here are the hourly
    // worker, whose prefix is unstable by construction, and the classifier. `implicit` leaves
    // OpenAI's automatic prefix matching in place, which costs nothing and may still hit.
    instructions: request.systemText,
    input: request.userText,
    max_output_tokens: request.maxOutputTokens,
    store: false,
    ...(reasoning ? { reasoning } : {}),
    ...(format && caps?.structuredOutput
      ? { text: { format: { type: 'json_schema' as const, name: format.name, schema: format.schema, strict: true } } }
      : {}),
  });

  const failure = failureOf(response);
  if (failure && failure.kind !== 'truncated') throw new ProviderResponseError('openai', failure);

  return {
    text: response.output_text.trim(),
    usage: readUsage(response.usage),
    truncated: response.status === 'incomplete',
  };
}

export const openaiProvider: AiProvider = {
  id: 'openai',
  isConfigured: () => resolveCredential('openai').source !== 'none',
  streamChat,
  generateStructured: (request) =>
    createOnce(request, { schema: request.schema, name: request.schemaName }),
  generateText: (request) => createOnce(request),
};
