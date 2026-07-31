import Anthropic from '@anthropic-ai/sdk';
import type { AdvisorEffort } from '../../../../shared/types';
import {
  AnthropicResponseError,
  DEFAULT_ANTHROPIC_TIMEOUT_MS,
  readModelText,
} from '../anthropicClient';
import { MODEL_CAPABILITIES, clampEffort } from '../advisorSettings';
import { resolveCredential } from './credentials';
import {
  addUsage,
  emptyUsage,
  type AdvisorToolSpec,
  type AiProvider,
  type ChatEmit,
  type ChatRequest,
  type ChatResult,
  type ProviderUsage,
  type StructuredRequest,
  type TextRequest,
  type TextResult,
} from './types';

// ─── Derived request shape ───────────────────────────────────────────────────

export interface ModelRequestShape {
  thinking?: Anthropic.ThinkingConfigParam;
  output_config?: Anthropic.OutputConfig;
}

export interface ModelRequestOptions {
  effort?: AdvisorEffort;
  /** 'summarized' returns readable reasoning text; the API default returns empty blocks. */
  thinkingDisplay?: 'summarized' | 'omitted';
  outputFormat?: Anthropic.JSONOutputFormat;
}

/**
 * Builds the optional parameters a request to `modelId` may carry, dropping any the model
 * does not accept. A model absent from the capability table, or belonging to another
 * provider, gets a bare request: no optional parameter is valid on every model, so
 * "unknown" has to mean "send nothing".
 */
export function buildModelRequestShape(
  modelId: string,
  options: ModelRequestOptions = {}
): ModelRequestShape {
  const caps = MODEL_CAPABILITIES[modelId];
  const shape: ModelRequestShape = {};
  if (!caps || caps.provider !== 'anthropic') return shape;

  if (caps.reasoning) {
    shape.thinking = options.thinkingDisplay
      ? { type: 'adaptive', display: options.thinkingDisplay }
      : { type: 'adaptive' };
  }

  const outputConfig: Anthropic.OutputConfig = {};
  if (options.effort && caps.efforts.includes(options.effort)) outputConfig.effort = options.effort;
  if (options.outputFormat && caps.structuredOutput) outputConfig.format = options.outputFormat;
  if (Object.keys(outputConfig).length > 0) shape.output_config = outputConfig;

  return shape;
}

// ─── Client ──────────────────────────────────────────────────────────────────

interface ClientOptions {
  maxRetries?: number;
  timeoutMs?: number;
}

function client(options: ClientOptions = {}): Anthropic {
  const credential = resolveCredential('anthropic');
  if (credential.source === 'none') {
    throw new Error(
      'No Anthropic credentials found. Set ANTHROPIC_API_KEY in .env, sign in with `ant auth login`, or store a key in Settings.'
    );
  }
  // apiKey is passed ONLY for a stored key. For env and OAuth sources the SDK's own
  // resolution order is the correct one and re-implementing it here would eventually disagree.
  return new Anthropic({
    timeout: options.timeoutMs ?? DEFAULT_ANTHROPIC_TIMEOUT_MS,
    ...(credential.source === 'stored' && credential.apiKey ? { apiKey: credential.apiKey } : {}),
    ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
  });
}

function toTools(tools: readonly AdvisorToolSpec[]): Anthropic.Tool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters as Anthropic.Tool.InputSchema,
  }));
}

/**
 * `usage.input_tokens` on this provider EXCLUDES both cache fields, so the uncached figure is
 * the field itself. The other two adapters have to subtract; see ProviderUsage.
 *
 * BOTH CACHE FIELDS ARE `number | null` in the installed SDK (@anthropic-ai/sdk 0.100.1,
 * `Usage` and `MessageDeltaUsage` in resources/messages/messages.ts), and the null is not
 * the same statement as a zero. `ai_runs.cache_write_tokens` is nullable for exactly the
 * reason migration 051 gives, that "0 would assert a measurement nobody took", so an absent
 * figure is forwarded as absent. A real 0 from a request that carried no breakpoint is a
 * measurement and survives untouched.
 *
 * `cacheReadTokens` cannot say the same thing, and that is a property of the shared type
 * rather than of this provider: it is declared non-null in `ProviderUsage` because the other
 * two adapters subtract it out of a total to get their uncached figure. On this path a
 * missing field therefore reads as 0, and whether a call happened at all is answered by
 * `input_tokens`/`output_tokens`, never by the cache columns.
 */
function readUsage(usage: Anthropic.Usage): ProviderUsage {
  return {
    uncachedInputTokens: usage.input_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? null,
    outputTokens: usage.output_tokens,
  };
}

function refusalMessage(message: Anthropic.Message): string {
  const detail = message.stop_details?.explanation ?? message.stop_details?.category ?? null;
  return detail ? `The model declined to answer: ${detail}` : 'The model declined to answer.';
}

// ─── Chat ────────────────────────────────────────────────────────────────────

async function streamChat(request: ChatRequest, emit: ChatEmit): Promise<ChatResult> {
  const anthropic = client({ timeoutMs: request.timeoutMs });
  const conversation: Anthropic.MessageParam[] = request.turns.map((turn) => ({
    role: turn.role,
    content: turn.content,
  }));

  let usage = emptyUsage();
  let answered = false;

  for (let round = 0; round < request.maxToolRounds; round++) {
    const stream = anthropic.messages.stream(
      {
        model: request.model,
        max_tokens: request.maxOutputTokens,
        // Derived from the model, never assumed: thinking mode, effort support and structured
        // output all differ across the family, and a request built without reference to the
        // model it names is the same latent defect the migration comments in db/migrations
        // record. A model this table does not know gets a bare request.
        ...buildModelRequestShape(request.model, {
          effort: clampEffort(request.model, request.effort),
          thinkingDisplay: 'summarized',
        }),
        // Stable prefix (prompt + snapshot) is cached; the tool list is fixed, so the cached
        // prefix holds across every tool round of the conversation.
        system: [{ type: 'text', text: request.systemText, cache_control: { type: 'ephemeral' } }],
        tools: toTools(request.tools),
        messages: conversation,
      },
      { timeout: request.timeoutMs }
    );

    let thinkingBlockIndex: number | null = null;

    for await (const event of stream) {
      if (event.type === 'content_block_start') {
        if (event.content_block.type === 'thinking') {
          thinkingBlockIndex = event.index;
          emit({ type: 'thinking_start' });
        } else if (event.content_block.type === 'tool_use') {
          emit({ type: 'tool_use', name: event.content_block.name });
        }
      } else if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') {
          emit({ type: 'chunk', text: event.delta.text });
        } else if (event.delta.type === 'thinking_delta') {
          emit({ type: 'thinking', text: event.delta.thinking });
        }
      } else if (event.type === 'content_block_stop' && event.index === thinkingBlockIndex) {
        emit({ type: 'thinking_end' });
      }
    }

    const message = await stream.finalMessage();
    usage = addUsage(usage, readUsage(message.usage));

    // A safety classifier can decline with an HTTP 200 and no content at all. Left
    // unhandled that reads as a successful, empty answer, so say what happened instead.
    if (message.stop_reason === 'refusal') {
      return { answered: false, failure: { kind: 'refusal', message: refusalMessage(message) }, usage, cacheNote: cacheNote(usage, request.model) };
    }

    if (message.stop_reason !== 'tool_use') {
      if (message.content.length === 0) {
        return {
          answered: false,
          failure: { kind: 'empty', message: 'The model returned an empty response.' },
          usage,
          cacheNote: cacheNote(usage, request.model),
        };
      }
      // A DELIBERATE CHANGE OF BEHAVIOUR ON THIS PATH, recorded because it is visible to the
      // owner. The loop used to check only for empty content and then complete, so a turn cut
      // off at the cap streamed its partial text and closed with {type:'done'}: a stream that
      // says the answer finished when it was severed mid-sentence. It now streams the partial
      // text AND an error frame, which is two things on screen for one turn and is the point:
      // the text is what the model managed to say and the frame is why it stops there.
      //
      // Kept rather than reverted because the other two providers already report this, from
      // `finishReason: 'MAX_TOKENS'` on Gemini and `status: 'incomplete'` on OpenAI. Dropping
      // it would leave Anthropic alone in closing a severed answer as a completed one.
      if (message.stop_reason === 'max_tokens') {
        return {
          answered: false,
          failure: {
            kind: 'truncated',
            message: `The answer hit the ${request.maxOutputTokens}-token output cap before it finished. Ask again, more narrowly.`,
          },
          usage,
          cacheNote: cacheNote(usage, request.model),
        };
      }
      answered = true;
      break;
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of message.content) {
      if (block.type === 'tool_use') {
        // `tool_use.input` arrives already parsed on this provider; the other two hand back
        // a JSON string and have to parse it behind an explicit failure path.
        const result = request.runTool(block.name, block.input as Record<string, unknown>);
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
      }
    }
    conversation.push({ role: 'assistant', content: message.content });
    conversation.push({ role: 'user', content: toolResults });
  }

  if (!answered) {
    return {
      answered: false,
      failure: {
        kind: 'rounds_exhausted',
        message: `The advisor stopped after ${request.maxToolRounds} tool rounds without finishing its answer. Ask again, more narrowly.`,
      },
      usage,
      cacheNote: cacheNote(usage, request.model),
    };
  }
  return { answered: true, usage, cacheNote: cacheNote(usage, request.model) };
}

/**
 * What the cache actually did on this request, from the response's own numbers.
 *
 * Stated rather than assumed because a breakpoint that never gets read is not free: it bills
 * the write premium on every turn and returns nothing, and the only way to tell the two apart
 * is the usage figures.
 */
function cacheNote(usage: ProviderUsage, modelId: string): string {
  const minimum = MODEL_CAPABILITIES[modelId]?.caching.minimumPrefixTokens;
  // 'not reported' rather than '0 tok': a reply that carried no write figure and a reply that
  // reported writing nothing are different facts, and this line is read to tell them apart.
  const written = usage.cacheWriteTokens === null ? 'not reported' : `${usage.cacheWriteTokens} tok`;
  if (usage.cacheReadTokens > 0) {
    return `breakpoint read ${usage.cacheReadTokens} tok, wrote ${written}`;
  }
  const floor = minimum === undefined ? '' : `; prefix must reach ${minimum} tokens to cache at all`;
  return `breakpoint read 0 tok, wrote ${written}${floor}`;
}

// ─── One-shot calls ──────────────────────────────────────────────────────────

async function createOnce(
  request: StructuredRequest | TextRequest,
  outputFormat?: Anthropic.JSONOutputFormat
): Promise<TextResult> {
  const anthropic = client({ maxRetries: request.maxRetries, timeoutMs: request.timeoutMs });
  const response = await anthropic.messages.create({
    model: request.model,
    max_tokens: request.maxOutputTokens,
    system: request.systemText,
    messages: [{ role: 'user', content: request.userText }],
    // No sampling parameter: a temperature is a 400 on every 4.7+ model. Every optional
    // parameter here is derived from the model rather than assumed, so retiering a job
    // cannot send a shape the new model rejects.
    ...buildModelRequestShape(request.model, {
      effort: request.effort ? clampEffort(request.model, request.effort) : undefined,
      outputFormat,
    }),
  });

  // readModelText raises on a refusal or a response carrying no text, so neither can pass
  // through here looking like "the model had nothing to say".
  const text = readModelText(response).trim();
  return {
    text,
    usage: readUsage(response.usage),
    truncated: response.stop_reason === 'max_tokens',
  };
}

export const anthropicProvider: AiProvider = {
  id: 'anthropic',
  isConfigured: () => resolveCredential('anthropic').source !== 'none',
  streamChat,
  generateStructured: (request) =>
    createOnce(request, {
      type: 'json_schema',
      schema: request.schema,
    } as Anthropic.JSONOutputFormat),
  generateText: (request) => createOnce(request),
};

export { AnthropicResponseError };
