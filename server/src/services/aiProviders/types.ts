import type { AdvisorEffort } from '../../../../shared/types';

/**
 * The provider-neutral seam over the three SDK call sites: the streaming chat with tools
 * (routes/ai.ts), the structured-output worker (aiWorker.ts), and bulk classification
 * (aiCategorySuggest.ts).
 *
 * This is deliberately NOT a lowest-common-denominator client. Nothing here flattens a
 * capability three providers implement differently; where they differ, the difference is
 * named in `ModelCapabilities` (advisorSettings.ts) and the surfaces ask the table.
 *
 * The chat loop lives INSIDE each provider rather than above them. Anthropic replays content
 * blocks, OpenAI replays `output` items including reasoning items (its own README warns that
 * filtering them makes the next request fail), and Gemini replays `candidates[0].content`
 * carrying opaque `thoughtSignature` parts it tells you not to modify. Those are three
 * different pieces of state, so a shared loop would have to own all three or lose one.
 */

export type AiProviderId = 'anthropic' | 'openai' | 'gemini';

export const AI_PROVIDER_IDS: readonly AiProviderId[] = ['anthropic', 'openai', 'gemini'];

// ─── Caching ─────────────────────────────────────────────────────────────────
// Three genuinely different mechanisms sit behind one field, and the field says which one
// rather than pretending they are the same thing:
//
//   anthropic_breakpoint   a marker on a content block; no lifecycle, nothing to manage.
//   openai_explicit        a marker on an input_text block PLUS a mandatory prompt_cache_key.
//   openai_implicit        automatic prefix matching only; no marker, no guarantee.
//   gemini_explicit_cache  a server-side object with a name, a TTL, and a storage bill.
//
// A model whose mechanism is an implicit one cannot be asked to cache a specific prefix, so
// the settings surface has to say that BEFORE the owner picks it, not after.

export type CachingMechanism =
  | 'anthropic_breakpoint'
  | 'openai_explicit'
  | 'openai_implicit'
  | 'gemini_explicit_cache';

export interface CachingProfile {
  mechanism: CachingMechanism;
  /** Below this, the provider silently (or loudly) declines to cache the prefix. */
  minimumPrefixTokens: number;
  /** How long an entry survives, as the provider documents it. */
  ttl: string;
  /** Multiplier on uncached input to WRITE the cache. 1 means the provider charges nothing extra. */
  writeCostMultiplier: number;
  /** Multiplier on uncached input to READ it back. */
  readCostMultiplier: number;
  /**
   * True when the app can prove a hit from the response rather than assume one. Every
   * mechanism here reports it, which is why routes/ai.ts can keep logging read/write tokens
   * per turn for all three.
   */
  hitReportedInUsage: boolean;
  /** One sentence the owner reads in Settings before choosing this model. */
  note: string;
}

// ─── Tools ───────────────────────────────────────────────────────────────────

/**
 * A read tool in provider-neutral form. `parameters` is plain JSON Schema; each adapter
 * renames the field its own way (`input_schema` on Anthropic, `parameters` on OpenAI,
 * `parametersJsonSchema` on Gemini).
 */
export interface AdvisorToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** Runs one tool call. Returns whatever the tool produced; the adapter serialises it. */
export type ToolRunner = (name: string, input: Record<string, unknown>) => unknown;

// ─── Streaming ───────────────────────────────────────────────────────────────

/**
 * The SSE contract routes/ai.ts already streams to the client, unchanged. Anthropic emits
 * indexed block start/stop events; OpenAI emits flat named reasoning-summary events; Gemini
 * emits whole responses whose parts carry a `thought` flag. All three are normalised to this.
 */
export type ChatStreamEvent =
  | { type: 'chunk'; text: string }
  | { type: 'thinking_start' }
  | { type: 'thinking'; text: string }
  | { type: 'thinking_end' }
  | { type: 'tool_use'; name: string };

export type ChatEmit = (event: ChatStreamEvent) => void;

// ─── Usage ───────────────────────────────────────────────────────────────────

/**
 * Normalised token accounting. The providers disagree about what their own input count
 * means, and copying one convention onto another double-counts the cached prefix on every
 * hit, so the arithmetic is done in each adapter and the result lands here already reconciled:
 *
 *   Anthropic  `usage.input_tokens` EXCLUDES both cache fields.
 *   OpenAI     `usage.input_tokens` INCLUDES `input_tokens_details.cached_tokens`.
 *   Gemini     `usageMetadata.promptTokenCount` INCLUDES `cachedContentTokenCount`.
 *
 * `uncachedInputTokens` is always input the provider billed at full rate.
 */
export interface ProviderUsage {
  uncachedInputTokens: number;
  cacheReadTokens: number;
  /** Null where the provider reports no per-turn write figure (Gemini bills the write on a separate call). */
  cacheWriteTokens: number | null;
  outputTokens: number;
}

export function emptyUsage(): ProviderUsage {
  return { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: null, outputTokens: 0 };
}

export function addUsage(total: ProviderUsage, next: ProviderUsage): ProviderUsage {
  return {
    uncachedInputTokens: total.uncachedInputTokens + next.uncachedInputTokens,
    cacheReadTokens: total.cacheReadTokens + next.cacheReadTokens,
    cacheWriteTokens:
      total.cacheWriteTokens === null && next.cacheWriteTokens === null
        ? null
        : (total.cacheWriteTokens ?? 0) + (next.cacheWriteTokens ?? 0),
    outputTokens: total.outputTokens + next.outputTokens,
  };
}

// ─── Failure ─────────────────────────────────────────────────────────────────

/**
 * The ways a 200 carries no usable answer. Every one of these used to be an early return
 * that read as "the model had nothing to say"; each provider reaches them differently:
 *
 *   refusal          Anthropic `stop_reason`, OpenAI a `refusal` content item,
 *                    Gemini a `finishReason` or an absent `candidates` array.
 *   content_filter   OpenAI `incomplete_details.reason`, Gemini `finishReason`. Anthropic
 *                    has no distinct state for it, so no Anthropic path sets this.
 *   empty            a completed response with nothing in it.
 *   truncated        the output cap was hit mid-answer.
 *   rounds_exhausted the tool loop ran out while the model was still asking for tools.
 */
export type ChatFailureKind =
  | 'refusal'
  | 'content_filter'
  | 'empty'
  | 'truncated'
  | 'rounds_exhausted';

export interface ChatFailure {
  kind: ChatFailureKind;
  message: string;
}

// ─── Requests ────────────────────────────────────────────────────────────────

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  model: string;
  effort: AdvisorEffort;
  /** The stable prefix: system prompt plus the financial snapshot. This is what gets cached. */
  systemText: string;
  tools: readonly AdvisorToolSpec[];
  turns: readonly ChatTurn[];
  maxOutputTokens: number;
  timeoutMs: number;
  maxToolRounds: number;
  runTool: ToolRunner;
}

export interface ChatResult {
  /** False when the stream carried tool activity but no turn ever produced an answer. */
  answered: boolean;
  failure?: ChatFailure;
  usage: ProviderUsage;
  /** How the prefix was cached on this request, or why it was not. Logged, never assumed. */
  cacheNote: string;
}

export interface StructuredRequest {
  model: string;
  effort?: AdvisorEffort;
  systemText: string;
  userText: string;
  /** Plain JSON Schema. Portable across all three: see PORTABLE_SCHEMA_RULES in schema.ts. */
  schema: Record<string, unknown>;
  /** Required by OpenAI's `text.format`, ignored by the other two. */
  schemaName: string;
  maxOutputTokens: number;
  timeoutMs: number;
  /** Retries the transport should make. Gemini retries nothing unless asked; see gemini.ts. */
  maxRetries: number;
}

export interface TextRequest {
  model: string;
  effort?: AdvisorEffort;
  systemText: string;
  userText: string;
  maxOutputTokens: number;
  timeoutMs: number;
  maxRetries: number;
}

export interface TextResult {
  text: string;
  usage: ProviderUsage;
  /** Set when the provider truncated the answer, so callers can warn rather than parse garbage. */
  truncated: boolean;
}

/**
 * A 200 that carries no usable answer, raised so it can never read as "no results".
 * Mirrors AnthropicResponseError, which predates this file and stays where it is because
 * `readModelText` is still the Anthropic reader.
 */
export class ProviderResponseError extends Error {
  constructor(readonly provider: AiProviderId, readonly failure: ChatFailure) {
    super(failure.message);
    this.name = 'ProviderResponseError';
  }
}

export interface AiProvider {
  readonly id: AiProviderId;
  /** True when a key is resolvable, from the environment or the encrypted store. */
  isConfigured(): boolean;
  /** Streams one chat turn and drives the bounded tool loop. Never throws on a model-level failure. */
  streamChat(request: ChatRequest, emit: ChatEmit): Promise<ChatResult>;
  /** One structured-output call. Returns the raw JSON text; the caller owns the parse. */
  generateStructured(request: StructuredRequest): Promise<TextResult>;
  /** One plain-text call. */
  generateText(request: TextRequest): Promise<TextResult>;
}
