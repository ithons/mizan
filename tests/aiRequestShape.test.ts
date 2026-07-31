import test from 'node:test';
import assert from 'node:assert/strict';
import http_ from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type Anthropic from '@anthropic-ai/sdk';
import { _setDbForTesting } from '../server/src/db/index';
import aiRouter, { MAX_TOOL_ROUNDS } from '../server/src/routes/ai';
import { migratedTestDb, insertCategory, insertTransaction } from './helpers/schema';
import { AnthropicResponseError, readModelText } from '../server/src/services/anthropicClient';
import {
  ADVISOR_EFFORTS,
  ADVISOR_MODELS,
  JOB_MODELS,
  MODEL_CAPABILITIES,
  clampEffort,
  modelsForJob,
  type AiJobName,
} from '../server/src/services/advisorSettings';
import { buildModelRequestShape } from '../server/src/services/aiProviders/anthropic';
import { providerForModel } from '../server/src/services/aiProviders';
import { AI_PROVIDER_IDS } from '../server/src/services/aiProviders/types';
import {
  PORTABLE_UNSUPPORTED_KEYWORDS,
  literal,
  unsupportedKeywordsFor,
} from '../server/src/services/aiProviders/schema';
import { ADVISOR_TOOLS, ADVISOR_TOOL_SPECS } from '../server/src/services/advisorChatTools';
import { WORKER_DRAFTS_SCHEMA, runBackgroundAiReview } from '../server/src/services/aiWorker';
import { suggestCategoriesForMerchants } from '../server/src/services/aiCategorySuggest';
import { AiWorkerDraftSchema } from '../shared/schemas';

// Two silent failures motivate this file, and both were HTTP 200s:
//
//   1. `response.content[0]` assumed a text block. Every current model runs adaptive thinking,
//      so content[0] is a thinking block, the extracted text is '', and the caller took an early
//      return that is indistinguishable from "the model had nothing to say". Zero drafts, no
//      exception, no log saying why.
//   2. A safety classifier can decline with `stop_reason: 'refusal'` and an empty content array.
//
// So the tests below drive the real SDK against a local server that returns those exact shapes,
// and assert on the bytes that go out as well as what comes back. Asserting the whitelist's
// contents would only restate a hardcoded list; asserting the derived request shape is what
// stops a future model being added with a parameter it rejects.

// ─── A local stand-in for the Anthropic API ──────────────────────────────────

interface FakeApi {
  /** Request bodies the SDK actually sent, in order. */
  sent: Array<Record<string, unknown>>;
}

type Reply = { status?: number; payload: unknown };

async function withFakeApi(replies: Reply[], run: (api: FakeApi) => Promise<void>): Promise<void> {
  const api: FakeApi = { sent: [] };
  let next = 0;

  const server = http_.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      api.sent.push(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
      const reply = replies[Math.min(next, replies.length - 1)];
      next += 1;
      res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.payload));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  const prevBaseUrl = process.env.ANTHROPIC_BASE_URL;
  const prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.ANTHROPIC_API_KEY = 'test-key-never-used';

  try {
    await run(api);
  } finally {
    if (prevBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = prevBaseUrl;
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function messageReply(content: unknown[], extra: Record<string, unknown> = {}): Reply {
  return {
    payload: {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'claude-test',
      content,
      stop_reason: 'end_turn',
      stop_sequence: null,
      stop_details: null,
      usage: { input_tokens: 10, output_tokens: 10 },
      ...extra,
    },
  };
}

const thinkingBlock = { type: 'thinking', thinking: 'Considering the merchants…', signature: 'sig' };
const textBlock = (text: string) => ({ type: 'text', text, citations: null });

/** Captures console output so a "fails loudly" claim can be checked rather than asserted. */
async function captureConsole(
  channel: 'error' | 'warn' | 'log',
  run: () => Promise<void>
): Promise<string[]> {
  const lines: string[] = [];
  const original = console[channel];
  console[channel] = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    await run();
  } finally {
    console[channel] = original;
  }
  return lines;
}

// ─── readModelText: the mechanism both silent failures ran through ───────────

const SAMPLING_PARAMS = ['temperature', 'top_p', 'top_k'];

function asMessage(content: unknown[], extra: Record<string, unknown> = {}): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-test',
    content,
    stop_reason: 'end_turn',
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 10, output_tokens: 10 },
    ...extra,
  } as unknown as Anthropic.Message;
}

test('HEALTHY: an ordinary single-text-block response reads exactly as its text', () => {
  assert.equal(readModelText(asMessage([textBlock('[]')])), '[]');
});

test('HEALTHY: a thinking block ahead of the text still yields the text', () => {
  assert.equal(readModelText(asMessage([thinkingBlock, textBlock('{"drafts": []}')])), '{"drafts": []}');
});

test('HEALTHY: several text blocks concatenate rather than dropping all but the first', () => {
  assert.equal(readModelText(asMessage([textBlock('{"a":'), textBlock('1}')])), '{"a":1}');
});

test('an empty content array raises instead of reading as an empty answer', () => {
  assert.throws(
    () => readModelText(asMessage([])),
    (err: unknown) => err instanceof AnthropicResponseError && err.problem === 'empty_content'
  );
});

test('a refusal raises and names the category', () => {
  assert.throws(
    () =>
      readModelText(
        asMessage([], { stop_reason: 'refusal', stop_details: { category: 'cyber', explanation: null } })
      ),
    (err: unknown) =>
      err instanceof AnthropicResponseError && err.problem === 'refusal' && /cyber/.test(err.message)
  );
});

test('a thinking-only response raises rather than resolving to an empty string', () => {
  assert.throws(
    () => readModelText(asMessage([thinkingBlock])),
    (err: unknown) => err instanceof AnthropicResponseError && err.problem === 'no_text_block'
  );
});

// ─── The request shape is derived from the model, not assumed ────────────────

test('every advisor-selectable model belongs to a provider and offers a real ladder', () => {
  // The guard a whitelist test cannot give. Offering a model whose effort ladder is empty
  // would render a dial in Settings that the derived shape silently drops, which is the
  // exact defect Phase 6.0 removed for Haiku 4.5.
  for (const { id } of ADVISOR_MODELS) {
    const caps = MODEL_CAPABILITIES[id];
    assert.ok(caps, `${id} is offered but has no capability entry`);
    assert.ok(AI_PROVIDER_IDS.includes(caps.provider), `${id} names an unknown provider`);
    assert.ok(caps.efforts.length > 0, `${id} is offered but accepts no effort level`);
    for (const effort of caps.efforts) {
      assert.ok(
        ADVISOR_EFFORTS.includes(effort),
        `${id} accepts '${effort}', which is not a name the settings screen knows`
      );
    }
  }
});

test('a dial position the chosen model has no rung for is never sent', () => {
  // Providers do NOT share a ladder: Gemini's `thinkingLevel` has no `xhigh` or `max`. A
  // stored effort surviving a provider switch must be narrowed, not passed through, because
  // one provider 400s on an unknown level and another ignores it.
  for (const id of Object.keys(MODEL_CAPABILITIES)) {
    const ladder = MODEL_CAPABILITIES[id].efforts;
    for (const effort of ADVISOR_EFFORTS) {
      const clamped = clampEffort(id, effort);
      if (ladder.length === 0) {
        assert.equal(clamped, undefined, `${id} takes no effort but clampEffort returned one`);
      } else {
        assert.ok(clamped !== undefined, `${id} has a ladder but clampEffort returned nothing`);
        assert.ok(ladder.includes(clamped), `${id} was handed '${clamped}', which it does not accept`);
      }
    }
  }
});

test('the derived Anthropic shape never carries a parameter the model rejects', () => {
  for (const [id, caps] of Object.entries(MODEL_CAPABILITIES)) {
    for (const effort of ADVISOR_EFFORTS) {
      const shape = buildModelRequestShape(id, {
        effort,
        thinkingDisplay: 'summarized',
        outputFormat: { type: 'json_schema', schema: WORKER_DRAFTS_SCHEMA } as never,
      });
      if (caps.provider !== 'anthropic') {
        // A non-Anthropic model must get NOTHING from the Anthropic shape builder. Handing a
        // Gemini model `thinking: {type:'adaptive'}` would be a 400 on a parameter it has
        // never heard of.
        assert.deepEqual(shape, {}, `${id} is not an Anthropic model but got an Anthropic shape`);
        continue;
      }
      assert.equal(shape.thinking !== undefined, caps.reasoning, `${id}: thinking mismatch`);
      assert.equal(
        shape.output_config?.effort !== undefined,
        caps.efforts.includes(effort),
        `${id}: effort '${effort}' sent when unsupported`
      );
      assert.equal(shape.output_config?.format !== undefined, caps.structuredOutput, `${id}: format mismatch`);
    }
  }
});

test('a model with no capability entry gets a bare request, never a guessed one', () => {
  // No optional parameter here is valid on every model, so "unknown" has to mean "send nothing".
  assert.deepEqual(
    buildModelRequestShape('some-model-added-later', {
      effort: 'max',
      thinkingDisplay: 'summarized',
      outputFormat: { type: 'json_schema', schema: WORKER_DRAFTS_SCHEMA } as never,
    }),
    {}
  );
  // And it cannot be routed at all, because every SDK widens its model parameter to `string`
  // and would otherwise fail as an opaque 404 mid-stream.
  assert.throws(() => providerForModel('some-model-added-later'));
});

test('every job names a model the capability table knows and that can serve it', () => {
  for (const [job, assignment] of Object.entries(JOB_MODELS)) {
    const caps = MODEL_CAPABILITIES[assignment.model];
    assert.ok(caps, `job '${job}' names unknown model '${assignment.model}'`);
    if (assignment.effort) {
      assert.ok(
        caps.efforts.includes(assignment.effort),
        `job '${job}' asks for effort '${assignment.effort}', which ${assignment.model} does not accept`
      );
    }
    assert.ok(
      modelsForJob(job as AiJobName).some((m) => m.id === assignment.model),
      `job '${job}' defaults to a model it is not allowed to use`
    );
  }
});

test('every offered model states what its caching costs before it is picked', () => {
  // "A model that cannot cache a large prefix should say what that costs BEFORE the owner
  // picks it, not after." The note is what a settings screen renders, so an empty one is a
  // silently missing warning rather than a visibly missing one.
  for (const [id, caps] of Object.entries(MODEL_CAPABILITIES)) {
    assert.ok(caps.caching.note.trim().length > 20, `${id} has no caching note worth reading`);
    assert.ok(caps.caching.minimumPrefixTokens > 0, `${id} claims a zero-token cache minimum`);
    assert.ok(caps.caching.hitReportedInUsage, `${id} cannot prove a cache hit, only assume one`);
    assert.ok(caps.contextWindow > 0 && caps.maxOutputTokens > 0, `${id} has no stated limits`);
  }
});

test('every advisor tool name is legal on the strictest provider', () => {
  // Gemini constrains function names (leading letter or underscore, then letters, digits,
  // `_`, `.`, `:`, `-`, at most 128 characters) where the other two do not. Asserted here
  // rather than discovered as a 400 on the first Gemini chat.
  for (const tool of ADVISOR_TOOL_SPECS) {
    assert.match(tool.name, /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/, `tool name '${tool.name}' is not portable`);
    assert.ok(tool.description.length > 0, `tool '${tool.name}' has no description`);
    assert.equal(typeof tool.parameters, 'object', `tool '${tool.name}' has no parameter schema`);
  }
  assert.equal(ADVISOR_TOOL_SPECS.length, ADVISOR_TOOLS.length, 'the neutral specs must not drop a tool');
});

// ─── The worker's structured-output contract, per provider ───────────────────

/**
 * Walks schema NODES only. A `properties` map is not a schema node: `create_merchant_rule`
 * has a property literally named `pattern`, and treating that map as a node would read the
 * property name as the JSON Schema keyword of the same name.
 */
function walkSchema(node: unknown, path: string, visit: (obj: Record<string, unknown>, path: string) => void): void {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return;
  const obj = node as Record<string, unknown>;
  visit(obj, path);

  for (const [name, child] of Object.entries((obj.properties ?? {}) as Record<string, unknown>)) {
    walkSchema(child, `${path}.properties.${name}`, visit);
  }
  if (obj.items) walkSchema(obj.items, `${path}.items`, visit);
  for (const branch of ['anyOf', 'allOf', 'oneOf'] as const) {
    const variants = obj[branch];
    if (Array.isArray(variants)) {
      variants.forEach((variant, i) => walkSchema(variant, `${path}.${branch}[${i}]`, visit));
    }
  }
}

test('the draft output schema satisfies every provider’s restrictions at once', () => {
  // The three subsets differ in both directions, so one shared assertion would either pass a
  // schema that 400s on Anthropic or reject one that is fine on OpenAI. This walks the union,
  // which is what keeps ONE schema correct for all three.
  for (const provider of AI_PROVIDER_IDS) {
    for (const keyword of unsupportedKeywordsFor(provider)) {
      assert.ok(
        PORTABLE_UNSUPPORTED_KEYWORDS.includes(keyword),
        `'${keyword}' is unusable on ${provider} but missing from the portable list`
      );
    }
  }

  walkSchema(WORKER_DRAFTS_SCHEMA, 'schema', (node, path) => {
    for (const keyword of PORTABLE_UNSUPPORTED_KEYWORDS) {
      assert.ok(!(keyword in node), `${path} uses '${keyword}', which at least one provider rejects or ignores`);
    }
    if (node.type !== 'object') return;
    // Anthropic requires this on every object and OpenAI requires it under strict mode.
    assert.equal(node.additionalProperties, false, `${path} is an object without additionalProperties: false`);
    const properties = Object.keys((node.properties ?? {}) as Record<string, unknown>);
    assert.deepEqual(
      [...(node.required as string[] ?? [])].sort(),
      [...properties].sort(),
      `${path} must require every property it declares`
    );
  });
});

test('the payload discriminator survives the provider that ignores unknown keywords', () => {
  // Gemini drops keywords outside its supported list SILENTLY, so a `const` discriminator
  // would stop existing with no error anywhere and `kind === payload.kind` would go
  // unenforced by the schema. `literal()` is the single-member enum that says the same thing.
  assert.deepEqual(literal('categorize_transaction'), { enum: ['categorize_transaction'] });
  const json = JSON.stringify(WORKER_DRAFTS_SCHEMA);
  assert.equal(json.includes('"const"'), false, 'the draft schema still uses const somewhere');
});

test('a draft matching the output schema also satisfies the Zod trust boundary', () => {
  // If these two disagreed, the API would return exactly what we asked for and every draft
  // would then be rejected as malformed: zero drafts, with the rejection logged as the
  // model's fault rather than ours.
  const conforming = {
    kind: 'categorize_transaction',
    label: 'Categorize Trupanion',
    summary: 'Trupanion is pet insurance.',
    route: '/transactions',
    payload: { kind: 'categorize_transaction', transaction_id: 'txn_1', category_id: 'cat_1' },
    changes: [{ field: 'category', before: null, after: 'Health' }],
  };
  assert.equal(AiWorkerDraftSchema.safeParse(conforming).success, true);

  const ruleDraft = {
    kind: 'create_merchant_rule',
    label: 'Always Health',
    summary: 'Future Trupanion charges are Health.',
    route: '/transactions',
    payload: { kind: 'create_merchant_rule', pattern: 'Trupanion', category_id: 'cat_1', apply_existing: true },
    changes: [],
  };
  assert.equal(AiWorkerDraftSchema.safeParse(ruleDraft).success, true);
});

// ─── Over the wire: bulk categorization (Haiku, no thinking, no effort) ──────

function suggestDb() {
  const db = migratedTestDb();
  insertCategory(db, { id: 'cat_groceries', name: 'Groceries' });
  return db;
}

test('HEALTHY: a thinking block ahead of the JSON still produces suggestions', async (t) => {
  const db = suggestDb();
  t.after(() => db.close());

  await withFakeApi(
    [messageReply([thinkingBlock, textBlock('[{"merchant":"COSTCO","category_id":"cat_groceries"}]')])],
    async (api) => {
      const out = await suggestCategoriesForMerchants(db, ['COSTCO']);
      assert.deepEqual(out, [
        { merchant: 'COSTCO', category_id: 'cat_groceries', category_name: 'Groceries' },
      ]);

      const body = api.sent[0];
      assert.equal(body.model, JOB_MODELS.bulk_categorization.model);
      for (const param of SAMPLING_PARAMS) {
        assert.ok(!(param in body), `bulk categorization must not send '${param}'`);
      }
      // Haiku 4.5 takes neither, and the derived shape is what keeps them off the wire.
      assert.equal('thinking' in body, false);
      assert.equal('output_config' in body, false);
    }
  );
});

test('HEALTHY: an ordinary single-text-block reply behaves exactly as before', async (t) => {
  const db = suggestDb();
  t.after(() => db.close());

  await withFakeApi(
    [messageReply([textBlock('[{"merchant":"COSTCO","category_id":"cat_groceries"}]')])],
    async () => {
      assert.deepEqual(await suggestCategoriesForMerchants(db, ['COSTCO']), [
        { merchant: 'COSTCO', category_id: 'cat_groceries', category_name: 'Groceries' },
      ]);
    }
  );
});

test('HEALTHY: a model that recognises nothing still returns an empty list, not an error', async (t) => {
  const db = suggestDb();
  t.after(() => db.close());

  // The one case that legitimately yields zero suggestions. It has to stay quiet, or the
  // distinction between "nothing recognised" and "the call broke" is lost the other way.
  await withFakeApi([messageReply([thinkingBlock, textBlock('[]')])], async () => {
    assert.deepEqual(await suggestCategoriesForMerchants(db, ['ZZZ UNKNOWN']), []);
  });
});

test('a refusal is reported rather than returning zero suggestions', async (t) => {
  const db = suggestDb();
  t.after(() => db.close());

  await withFakeApi(
    [messageReply([], { stop_reason: 'refusal', stop_details: { category: 'cyber', explanation: 'declined' } })],
    async () => {
      await assert.rejects(
        suggestCategoriesForMerchants(db, ['COSTCO']),
        (err: unknown) => err instanceof AnthropicResponseError && err.problem === 'refusal'
      );
    }
  );
});

test('an empty content array is reported rather than returning zero suggestions', async (t) => {
  const db = suggestDb();
  t.after(() => db.close());

  await withFakeApi([messageReply([])], async () => {
    await assert.rejects(
      suggestCategoriesForMerchants(db, ['COSTCO']),
      (err: unknown) => err instanceof AnthropicResponseError && err.problem === 'empty_content'
    );
  });
});

// ─── Over the wire: the background worker (Sonnet 5, thinking + effort) ──────

function workerDb() {
  const db = migratedTestDb();
  // cat_health is one of the categories migration 001 seeds; the worker's prompt lists
  // whatever is in the table, so there is nothing to add.
  insertTransaction(db, {
    id: 'txn_trupanion',
    merchant_name: 'Trupanion',
    amount: -3902,
    category_id: null,
  });
  _setDbForTesting(db);
  return db;
}

function openDraftCount(db: ReturnType<typeof workerDb>): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM advisor_drafts`).get() as { n: number }).n;
}

const workerDraftsJson = JSON.stringify({
  drafts: [
    {
      kind: 'categorize_transaction',
      label: 'Categorize Trupanion',
      summary: 'Trupanion is pet insurance.',
      route: '/transactions',
      payload: { kind: 'categorize_transaction', transaction_id: 'txn_trupanion', category_id: 'cat_health' },
      changes: [],
    },
  ],
});

test('HEALTHY: a thinking block ahead of the drafts still yields the drafts', async (t) => {
  const db = workerDb();
  t.after(() => db.close());

  await withFakeApi([messageReply([thinkingBlock, textBlock(workerDraftsJson)])], async (api) => {
    const errors = await captureConsole('error', () => runBackgroundAiReview());
    assert.deepEqual(errors, [], 'a healthy pass must log no error');
    assert.equal(openDraftCount(db), 1);

    const body = api.sent[0];
    const job = JOB_MODELS.background_review;
    assert.equal(body.model, job.model);
    for (const param of SAMPLING_PARAMS) {
      assert.ok(!(param in body), `the worker must not send '${param}'`);
    }
    assert.deepEqual(body.thinking, { type: 'adaptive' });
    const outputConfig = body.output_config as Record<string, unknown>;
    assert.equal(outputConfig.effort, job.effort);
    assert.deepEqual(outputConfig.format, { type: 'json_schema', schema: WORKER_DRAFTS_SCHEMA });
    // The prompt prefix carries today's date and the sync timestamp, so a cache breakpoint
    // would bill 1.25x writes against zero reads on every call.
    assert.equal(JSON.stringify(body.system ?? '').includes('cache_control'), false);
  });
});

test('HEALTHY: an ordinary single-text-block reply yields the same drafts', async (t) => {
  const db = workerDb();
  t.after(() => db.close());

  await withFakeApi([messageReply([textBlock(workerDraftsJson)])], async () => {
    const errors = await captureConsole('error', () => runBackgroundAiReview());
    assert.deepEqual(errors, []);
    assert.equal(openDraftCount(db), 1);
  });
});

test('HEALTHY: an empty drafts array is quiet and writes nothing', async (t) => {
  const db = workerDb();
  t.after(() => db.close());

  // "Nothing worth suggesting" is a normal outcome and must not read as a failure.
  await withFakeApi([messageReply([thinkingBlock, textBlock('{"drafts": []}')])], async () => {
    const errors = await captureConsole('error', () => runBackgroundAiReview());
    assert.deepEqual(errors, []);
    assert.equal(openDraftCount(db), 0);
  });
});

test('an empty content array fails loudly instead of silently producing no drafts', async (t) => {
  const db = workerDb();
  t.after(() => db.close());

  await withFakeApi([messageReply([])], async () => {
    const errors = await captureConsole('error', () => runBackgroundAiReview());
    assert.equal(openDraftCount(db), 0);
    assert.equal(errors.length, 1, 'the pass must say why it produced nothing');
    assert.match(errors[0], /no content blocks/i);
  });
});

test('a refusal is reported rather than passing as a quiet pass', async (t) => {
  const db = workerDb();
  t.after(() => db.close());

  await withFakeApi(
    [messageReply([], { stop_reason: 'refusal', stop_details: { category: null, explanation: 'declined' } })],
    async () => {
      const errors = await captureConsole('error', () => runBackgroundAiReview());
      assert.equal(openDraftCount(db), 0);
      assert.equal(errors.length, 1);
      assert.match(errors[0], /declined/i);
    }
  );
});

test('a reply that ignores the output contract fails loudly', async (t) => {
  const db = workerDb();
  t.after(() => db.close());

  // Unreachable while the structured-output request parameter holds, which is exactly why it
  // needs a test: if that parameter were ever dropped, this is the path the response takes.
  await withFakeApi([messageReply([textBlock('[{"kind":"categorize_transaction"}]')])], async () => {
    const errors = await captureConsole('error', () => runBackgroundAiReview());
    assert.equal(openDraftCount(db), 0);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /output contract/i);
  });
});

// ─── The chat loop, over the wire: rounds exhausted is not a completed answer ─
//
// Third case of the same class as the refusal and the empty content array, and the one the
// other two left open: the loop can run out of tool rounds while the model is still asking
// for tools. The stream then carries tool_use events and no answer, and used to close with
// {type:'done'} anyway. These drive the real router over HTTP against a fake streaming API.

type StreamBlock = { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string };

/**
 * One turn's token counts, in Anthropic's own accounting: `input_tokens` EXCLUDES both cache
 * fields here, which is the opposite of the other two providers.
 */
interface TurnUsage {
  input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  output_tokens: number;
}

interface StreamTurn {
  blocks: StreamBlock[];
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens';
  usage?: TurnUsage;
}

/** The SSE bytes the Anthropic SDK expects for one streamed turn. */
function sseFrames(turn: StreamTurn): string {
  const frames: string[] = [];
  const push = (type: string, payload: Record<string, unknown>): void => {
    frames.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
  };

  push('message_start', {
    message: {
      id: 'msg_stream',
      type: 'message',
      role: 'assistant',
      model: 'claude-test',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      stop_details: null,
      // The SDK's own accumulator takes input and both cache figures from message_start and
      // overwrites output_tokens from message_delta, so a turn's usage is split across the two.
      usage: turn.usage
        ? { ...turn.usage, output_tokens: 0 }
        : { input_tokens: 10, output_tokens: 0 },
    },
  });
  turn.blocks.forEach((block, index) => {
    if (block.type === 'text') {
      push('content_block_start', { index, content_block: { type: 'text', text: '', citations: null } });
      push('content_block_delta', { index, delta: { type: 'text_delta', text: block.text } });
    } else {
      push('content_block_start', {
        index,
        content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
      });
      push('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: '{}' } });
    }
    push('content_block_stop', { index });
  });
  push('message_delta', {
    delta: { stop_reason: turn.stopReason, stop_sequence: null },
    usage: { output_tokens: turn.usage?.output_tokens ?? 20 },
  });
  push('message_stop', {});

  return frames.join('');
}

async function listenOn(server: http_.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

/**
 * Mounts the real ai router against a fake Anthropic API that streams `turns` in order,
 * repeating the last one once they run out. Returns every SSE event the router emitted.
 */
async function chatOverHttp(
  turns: StreamTurn[],
  body: unknown,
  run: (events: Array<Record<string, unknown>>, api: FakeApi) => void
): Promise<void> {
  const api: FakeApi = { sent: [] };
  let next = 0;

  const upstream = http_.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      api.sent.push(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
      const turn = turns[Math.min(next, turns.length - 1)];
      next += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sseFrames(turn));
    });
  });
  const upstreamPort = await listenOn(upstream);

  const app = express();
  app.use(express.json());
  app.use('/api/ai', aiRouter);
  const local = http_.createServer(app);
  const localPort = await listenOn(local);

  const prevBaseUrl = process.env.ANTHROPIC_BASE_URL;
  const prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${upstreamPort}`;
  process.env.ANTHROPIC_API_KEY = 'test-key-never-used';

  try {
    const res = await fetch(`http://127.0.0.1:${localPort}/api/ai/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    const events = text
      .split('\n\n')
      .filter((frame) => frame.startsWith('data: '))
      .map((frame) => JSON.parse(frame.slice('data: '.length)) as Record<string, unknown>);
    run(events, api);
  } finally {
    if (prevBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = prevBaseUrl;
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
    await new Promise<void>((resolve) => local.close(() => resolve()));
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
}

const askAboutGoals = { messages: [{ role: 'user', content: 'How are my goals doing?' }] };

function chatDb() {
  const db = migratedTestDb();
  _setDbForTesting(db);
  return db;
}

test('HEALTHY: a chat turn that calls no tools streams its text and ends with done', async (t) => {
  const db = chatDb();
  t.after(() => db.close());

  await chatOverHttp(
    [{ blocks: [{ type: 'text', text: 'Both goals are on track.' }], stopReason: 'end_turn' }],
    askAboutGoals,
    (events, api) => {
      assert.equal(api.sent.length, 1, 'one turn means one upstream request');
      assert.deepEqual(
        events,
        [
          { type: 'chunk', text: 'Both goals are on track.' },
          { type: 'done' },
        ],
        'no new event and no error on the ordinary path'
      );
    }
  );
});

test('HEALTHY: a chat turn with two tool rounds still ends with done', async (t) => {
  const db = chatDb();
  t.after(() => db.close());

  await chatOverHttp(
    [
      { blocks: [{ type: 'tool_use', id: 'toolu_1', name: 'list_goals' }], stopReason: 'tool_use' },
      { blocks: [{ type: 'tool_use', id: 'toolu_2', name: 'get_budgets' }], stopReason: 'tool_use' },
      { blocks: [{ type: 'text', text: 'You are ahead on both.' }], stopReason: 'end_turn' },
    ],
    askAboutGoals,
    (events, api) => {
      assert.equal(api.sent.length, 3, 'two tool rounds plus the answering turn');
      assert.deepEqual(
        events,
        [
          { type: 'tool_use', name: 'list_goals' },
          { type: 'tool_use', name: 'get_budgets' },
          { type: 'chunk', text: 'You are ahead on both.' },
          { type: 'done' },
        ],
        'tool rounds are reported as before and the stream still completes'
      );
    }
  );
});

test('exhausting the tool rounds says so instead of closing as a completed answer', async (t) => {
  const db = chatDb();
  t.after(() => db.close());

  // A model that never stops asking for tools. Before, this fell out of the loop and wrote
  // {type:'done'}: a completed stream carrying tool_use events and no answer.
  await chatOverHttp(
    [{ blocks: [{ type: 'tool_use', id: 'toolu_loop', name: 'list_goals' }], stopReason: 'tool_use' }],
    askAboutGoals,
    (events, api) => {
      assert.equal(api.sent.length, MAX_TOOL_ROUNDS, 'the loop is still bounded');
      assert.equal(
        events.filter((e) => e.type === 'done').length,
        0,
        'a turn that never answered must not close as done'
      );

      const errors = events.filter((e) => e.type === 'error');
      assert.equal(errors.length, 1);
      assert.match(String(errors[0].message), new RegExp(`${MAX_TOOL_ROUNDS} tool rounds`));
    }
  );
});

// ─── Over the wire: OpenAI ───────────────────────────────────────────────────
//
// Same technique as the Anthropic sections above and for the same reason: the assertions are
// on the bytes the real SDK sends, not on a mock of what we hoped it would send. Three shapes
// here have no Anthropic counterpart and each one, got wrong, is silent rather than loud:
// a missing `prompt_cache_key` produces a correct-looking request with a 0% hit rate, an
// `instructions` string cannot carry a breakpoint at all, and `store` defaults to true.

interface FakeHttp {
  sent: Array<{ method: string; path: string; body: Record<string, unknown> }>;
}

type Responder = (req: { method: string; path: string; body: Record<string, unknown> }) =>
  | { status?: number; json: unknown }
  | { status?: number; sse: string };

async function withFakeHost(
  envVar: 'OPENAI_BASE_URL' | 'GEMINI_BASE_URL',
  keyVar: 'OPENAI_API_KEY' | 'GEMINI_API_KEY',
  respond: Responder,
  run: (http: FakeHttp) => Promise<void>
): Promise<void> {
  const http: FakeHttp = { sent: [] };
  const server = http_.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const path = req.url ?? '';
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      http.sent.push({ method: req.method ?? 'GET', path, body });
      const reply = respond({ method: req.method ?? 'GET', path, body });
      if ('sse' in reply) {
        res.writeHead(reply.status ?? 200, { 'content-type': 'text/event-stream' });
        res.end(reply.sse);
        return;
      }
      res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.json));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  const prevBase = process.env[envVar];
  const prevKey = process.env[keyVar];
  const prevAnthropicKey = process.env.ANTHROPIC_API_KEY;
  // The provider under test must be the one that answers, so the Anthropic key is removed for
  // the duration: a request reaching the wrong provider would otherwise leave the local server
  // silent and the assertion would read as "no request was made".
  delete process.env.ANTHROPIC_API_KEY;
  process.env[envVar] = envVar === 'OPENAI_BASE_URL'
    ? `http://127.0.0.1:${port}/v1`
    : `http://127.0.0.1:${port}`;
  process.env[keyVar] = 'test-key-never-used';

  try {
    await run(http);
  } finally {
    if (prevBase === undefined) delete process.env[envVar];
    else process.env[envVar] = prevBase;
    if (prevKey === undefined) delete process.env[keyVar];
    else process.env[keyVar] = prevKey;
    if (prevAnthropicKey !== undefined) process.env.ANTHROPIC_API_KEY = prevAnthropicKey;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** A completed Responses object carrying one text item. */
function openaiResponse(text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'resp_test',
    object: 'response',
    created_at: 0,
    model: 'gpt-test',
    status: 'completed',
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    metadata: {},
    parallel_tool_calls: true,
    temperature: null,
    tool_choice: 'auto',
    tools: [],
    top_p: null,
    output: [
      {
        type: 'message',
        id: 'msg_1',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [], logprobs: [] }],
      },
    ],
    usage: {
      input_tokens: 1200,
      input_tokens_details: { cached_tokens: 1000, cache_write_tokens: 0 },
      output_tokens: 40,
      output_tokens_details: { reasoning_tokens: 10 },
      total_tokens: 1240,
    },
    ...extra,
  };
}

function useModel(db: ReturnType<typeof migratedTestDb>, model: string, job?: string): void {
  db.prepare(
    `INSERT INTO app_preferences (key, value, created_at, updated_at) VALUES (?, ?, '2026-07-31', '2026-07-31')
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    // Values are JSON-encoded in this table; a bare string parses as corrupt and the
    // preference silently reads as unset.
  ).run(job ? `ai_job_model_${job}` : 'advisor_model', JSON.stringify(model));
}

test('OpenAI: the worker sends text.format, store:false and no sampling parameter', async (t) => {
  const db = workerDb();
  t.after(() => db.close());
  useModel(db, 'gpt-5.6-terra', 'background_review');

  await withFakeHost('OPENAI_BASE_URL', 'OPENAI_API_KEY',
    () => ({ json: openaiResponse(workerDraftsJson) }),
    async (http) => {
      const errors = await captureConsole('error', () => runBackgroundAiReview({ db }));
      assert.deepEqual(errors, [], 'a healthy pass must log no error');
      assert.equal(openDraftCount(db), 1);

      const [request] = http.sent;
      assert.match(request.path, /\/v1\/responses$/, 'the Responses API is the target, not chat completions');
      assert.equal(request.body.model, 'gpt-5.6-terra');
      for (const param of SAMPLING_PARAMS) {
        assert.ok(!(param in request.body), `reasoning models reject '${param}'`);
      }
      // `store` defaults to TRUE on this provider, which would retain the ledger's financial
      // context on OpenAI's servers. A loopback single-owner app says no explicitly.
      assert.equal(request.body.store, false);
      const text = request.body.text as { format: Record<string, unknown> };
      assert.equal(text.format.type, 'json_schema');
      // `name` is required here and has no Anthropic counterpart.
      assert.equal(text.format.name, 'mizan_advisor_drafts');
      assert.deepEqual(text.format.schema, WORKER_DRAFTS_SCHEMA);
      const reasoning = request.body.reasoning as { effort?: string; summary?: string };
      assert.equal(reasoning.effort, 'medium');
    }
  );
});

test('OpenAI: uncached input is the difference, not the whole input count', async (t) => {
  const db = workerDb();
  t.after(() => db.close());
  useModel(db, 'gpt-5.6-terra', 'background_review');

  // The accounting is INVERTED relative to Anthropic: `input_tokens` is the total and
  // `cached_tokens` is a subset of it. Copying Anthropic's arithmetic would record 1200
  // uncached tokens on a request where only 200 were billed at full rate.
  await withFakeHost('OPENAI_BASE_URL', 'OPENAI_API_KEY',
    () => ({ json: openaiResponse(workerDraftsJson) }),
    async () => {
      await captureConsole('error', () => runBackgroundAiReview({ db }));
      const run = db.prepare(
        `SELECT input_tokens, cache_read_tokens FROM ai_runs WHERE status = 'completed' ORDER BY started_at DESC LIMIT 1`
      ).get() as { input_tokens: number; cache_read_tokens: number };
      assert.equal(run.cache_read_tokens, 1000);
      assert.equal(run.input_tokens, 200, 'uncached input must exclude the cached prefix');
    }
  );
});

test('OpenAI: the run row names the model that answered, not the compile-time default', async (t) => {
  const db = workerDb();
  t.after(() => db.close());
  useModel(db, 'gpt-5.6-terra', 'background_review');

  // `ai_runs.model` exists, in migration 051's words, "so a retiering is visible in the history
  // rather than only in the diff that caused it". Written from the declaration it recorded
  // claude-sonnet-5 while the request went to OpenAI: the one divergence this column is for,
  // present in the column itself.
  await withFakeHost('OPENAI_BASE_URL', 'OPENAI_API_KEY',
    () => ({ json: openaiResponse(workerDraftsJson) }),
    async (http) => {
      const errors = await captureConsole('error', () => runBackgroundAiReview({ db }));
      assert.deepEqual(errors, []);

      const row = db.prepare(
        `SELECT model, effort FROM ai_runs ORDER BY started_at DESC LIMIT 1`
      ).get() as { model: string; effort: string | null };
      assert.equal(row.model, 'gpt-5.6-terra');
      assert.equal(row.model, http.sent[0].body.model, 'the audit row and the request must agree');
      assert.equal(row.effort, (http.sent[0].body.reasoning as { effort?: string }).effort);
    }
  );
});

test('OpenAI: a refusal is reported rather than reading as an empty answer', async (t) => {
  const db = workerDb();
  t.after(() => db.close());
  useModel(db, 'gpt-5.6-terra', 'background_review');

  // `response.output_text` joins only `output_text` parts, so a refusal-only response yields
  // an empty string with HTTP 200 and a populated `output` array. Same silent-empty class as
  // the `content[0]` bug, needing a completely different detection.
  const refused = openaiResponse('', {
    output: [
      {
        type: 'message',
        id: 'msg_1',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'refusal', refusal: 'I cannot help with that.' }],
      },
    ],
  });

  await withFakeHost('OPENAI_BASE_URL', 'OPENAI_API_KEY', () => ({ json: refused }), async () => {
    const errors = await captureConsole('error', () => runBackgroundAiReview({ db }));
    assert.equal(openDraftCount(db), 0);
    assert.equal(errors.length, 1, 'the pass must say why it produced nothing');
    assert.match(errors[0], /declined/i);
  });
});

// ─── Over the wire: Gemini ───────────────────────────────────────────────────

function geminiResponse(text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    candidates: [
      { content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP', index: 0 },
    ],
    usageMetadata: { promptTokenCount: 1200, cachedContentTokenCount: 1000, candidatesTokenCount: 40, totalTokenCount: 1240 },
    ...extra,
  };
}

test('Gemini: the worker sends responseJsonSchema and a thinking level, not a const schema', async (t) => {
  const db = workerDb();
  t.after(() => db.close());
  useModel(db, 'gemini-3.5-flash-lite', 'background_review');

  await withFakeHost('GEMINI_BASE_URL', 'GEMINI_API_KEY',
    () => ({ json: geminiResponse(workerDraftsJson) }),
    async (http) => {
      const errors = await captureConsole('error', () => runBackgroundAiReview({ db }));
      assert.deepEqual(errors, []);
      assert.equal(openDraftCount(db), 1);

      const [request] = http.sent;
      assert.match(request.path, /:generateContent/, 'the Generate Content surface, not Interactions');
      const config = request.body.generationConfig as Record<string, unknown>;
      // Structured output here is a mime type PLUS a schema, not `output_config.format`.
      assert.equal(config.responseMimeType, 'application/json');
      assert.deepEqual(config.responseJsonSchema, WORKER_DRAFTS_SCHEMA);
      const thinking = config.thinkingConfig as { includeThoughts?: boolean; thinkingLevel?: string };
      // Opt-in, or you pay for reasoning you cannot display.
      assert.equal(thinking.includeThoughts, true);
      assert.equal(thinking.thinkingLevel, 'MEDIUM');
      assert.ok(!('temperature' in config), 'no sampling parameter is sent');
      // No explicit cache on this path: the worker's prefix is unstable and it fires hourly.
      assert.ok(!('cachedContent' in request.body), 'the worker must not build a cache object');
    }
  );
});

test('Gemini: a blocked prompt is reported even though it arrives as HTTP 200 with no candidates', async (t) => {
  const db = workerDb();
  t.after(() => db.close());
  useModel(db, 'gemini-3.5-flash-lite', 'background_review');

  // The nastiest empty on this provider: `candidates` is UNDEFINED and `promptFeedback`
  // carries the reason, so `response.text` is `undefined` and nothing throws.
  await withFakeHost('GEMINI_BASE_URL', 'GEMINI_API_KEY',
    () => ({ json: { promptFeedback: { blockReason: 'SAFETY', safetyRatings: [] } } }),
    async () => {
      const errors = await captureConsole('error', () => runBackgroundAiReview({ db }));
      assert.equal(openDraftCount(db), 0);
      assert.equal(errors.length, 1);
      assert.match(errors[0], /SAFETY/);
    }
  );
});

test('Gemini: uncached input excludes the cached prefix', async (t) => {
  const db = workerDb();
  t.after(() => db.close());
  useModel(db, 'gemini-3.5-flash-lite', 'background_review');

  // `promptTokenCount` INCLUDES `cachedContentTokenCount`, like OpenAI and unlike Anthropic.
  await withFakeHost('GEMINI_BASE_URL', 'GEMINI_API_KEY',
    () => ({ json: geminiResponse(workerDraftsJson) }),
    async () => {
      await captureConsole('error', () => runBackgroundAiReview({ db }));
      const run = db.prepare(
        `SELECT input_tokens, cache_read_tokens, cache_write_tokens FROM ai_runs WHERE status = 'completed' ORDER BY started_at DESC LIMIT 1`
      ).get() as { input_tokens: number; cache_read_tokens: number; cache_write_tokens: number | null };
      assert.equal(run.cache_read_tokens, 1000);
      assert.equal(run.input_tokens, 200);
      // A Gemini cache write is a separate API call, so there is no per-turn figure to record
      // and the column says null rather than a zero that would read as "nothing was written".
      assert.equal(run.cache_write_tokens, null);
    }
  );
});

// ─── Over the wire: the chat loop on each provider ───────────────────────────
//
// Caching is the thing that matters most here, and each provider needs a different assertion
// to prove the same property. Anthropic's breakpoint is a marker on a system block; OpenAI's
// cannot live in `instructions` at all and needs a mandatory cache key beside it; Gemini's is
// a server-side object that forbids sending the prompt and tools on the same request.

/** Mounts the real ai router against a fake provider host and returns the SSE events it emitted. */
async function chatAgainstHost(
  envVar: 'OPENAI_BASE_URL' | 'GEMINI_BASE_URL',
  keyVar: 'OPENAI_API_KEY' | 'GEMINI_API_KEY',
  respond: Responder,
  run: (events: Array<Record<string, unknown>>, http: FakeHttp) => void
): Promise<void> {
  await withFakeHost(envVar, keyVar, respond, async (http) => {
    const app = express();
    app.use(express.json());
    app.use('/api/ai', aiRouter);
    const local = http_.createServer(app);
    const localPort = await listenOn(local);
    try {
      const res = await fetch(`http://127.0.0.1:${localPort}/api/ai/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(askAboutGoals),
      });
      const text = await res.text();
      const events = text
        .split('\n\n')
        .filter((frame) => frame.startsWith('data: '))
        .map((frame) => JSON.parse(frame.slice('data: '.length)) as Record<string, unknown>);
      run(events, http);
    } finally {
      await new Promise<void>((resolve) => local.close(() => resolve()));
    }
  });
}

function openaiSse(events: Array<Record<string, unknown>>): string {
  return events
    .map((event, i) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: i })}\n\n`)
    .join('');
}

/**
 * The event sequence the SDK's own stream accumulator requires.
 *
 * Not a stylistic choice: `ResponseStream` rebuilds the response from the item and part
 * lifecycle events, and a bare text delta with no `output_item.added` ahead of it fails with
 * "missing output at index 0". Writing the real sequence is what makes this a test of the SDK
 * rather than of a hand-rolled parser.
 */
function openaiTextTurn(text: string, usage?: Record<string, unknown>): string {
  const message = { type: 'message', id: 'msg_1', status: 'in_progress', role: 'assistant', content: [] };
  const response = openaiResponse(text, usage ? { usage } : {});
  return openaiSse([
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: message },
    { type: 'response.content_part.added', item_id: 'msg_1', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [], logprobs: [] } },
    { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: text, logprobs: [] },
    { type: 'response.output_text.done', item_id: 'msg_1', output_index: 0, content_index: 0, text, logprobs: [] },
    { type: 'response.content_part.done', item_id: 'msg_1', output_index: 0, content_index: 0, part: { type: 'output_text', text, annotations: [], logprobs: [] } },
    { type: 'response.output_item.done', output_index: 0, item: (response.output as Array<Record<string, unknown>>)[0] },
    { type: 'response.completed', response },
  ]);
}

/** A turn that asks for one tool, with the reasoning item the next request has to replay. */
function openaiToolTurn(usage?: Record<string, unknown>): { sse: string; response: Record<string, unknown> } {
  const reasoning = { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'opaque' };
  const call = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'list_goals', arguments: '{}', status: 'completed' };
  const response = openaiResponse('', { output: [reasoning, call], ...(usage ? { usage } : {}) });
  return {
    response,
    sse: openaiSse([
      { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { ...reasoning, status: 'in_progress' } },
      { type: 'response.output_item.done', output_index: 0, item: reasoning },
      { type: 'response.output_item.added', output_index: 1, item: { ...call, status: 'in_progress' } },
      { type: 'response.function_call_arguments.done', item_id: 'fc_1', output_index: 1, arguments: '{}' },
      { type: 'response.output_item.done', output_index: 1, item: call },
      { type: 'response.completed', response },
    ]),
  };
}

test('OpenAI: the cached prefix is an input block with a breakpoint, never instructions', async (t) => {
  const db = chatDb();
  t.after(() => db.close());
  useModel(db, 'gpt-5.6-terra');

  await chatAgainstHost('OPENAI_BASE_URL', 'OPENAI_API_KEY',
    () => ({ sse: openaiTextTurn('Both goals are on track.') }),
    (events, http) => {
      assert.deepEqual(events, [
        { type: 'chunk', text: 'Both goals are on track.' },
        { type: 'done' },
      ], 'the SSE contract the client consumes is unchanged');

      const body = http.sent[0].body;
      // `instructions` is typed `string | null` and cannot carry a content block, so the
      // financial context CANNOT ride there and still be cached. It is input[0].
      assert.ok(!body.instructions, 'the context must not be sent as instructions');
      const input = body.input as Array<{ role?: string; content?: Array<Record<string, unknown>> }>;
      assert.equal(input[0].role, 'developer');
      const block = input[0].content?.[0] as { type: string; text: string; prompt_cache_breakpoint?: unknown };
      assert.equal(block.type, 'input_text');
      assert.ok(block.text.length > 100, 'the breakpoint must sit on the whole stable prefix');
      assert.deepEqual(block.prompt_cache_breakpoint, { mode: 'explicit' });

      // Omitting this is the single easiest way to get a correct-looking request with a 0%
      // hit rate, so it is asserted rather than trusted.
      assert.equal(typeof body.prompt_cache_key, 'string');
      assert.deepEqual(body.prompt_cache_options, { mode: 'explicit' });
      assert.equal(body.store, false);

      // Tool definitions are flat here: `parameters`, not `input_schema`, plus a type tag.
      const tools = body.tools as Array<Record<string, unknown>>;
      assert.equal(tools[0].type, 'function');
      assert.ok('parameters' in tools[0] && !('input_schema' in tools[0]));
    }
  );
});

test('OpenAI: a tool round replays the output items verbatim and answers', async (t) => {
  const db = chatDb();
  t.after(() => db.close());
  useModel(db, 'gpt-5.6-terra');

  let turn = 0;
  await chatAgainstHost('OPENAI_BASE_URL', 'OPENAI_API_KEY',
    () => (turn++ === 0 ? { sse: openaiToolTurn().sse } : { sse: openaiTextTurn('You are ahead on both.') }),
    (events, http) => {
      assert.equal(http.sent.length, 2, 'one tool round plus the answering turn');
      assert.deepEqual(events, [
        { type: 'tool_use', name: 'list_goals' },
        { type: 'chunk', text: 'You are ahead on both.' },
        { type: 'done' },
      ]);

      const second = http.sent[1].body.input as Array<Record<string, unknown>>;
      // The reasoning item is replayed. The installed README states that filtering
      // `response.output` down to messages can drop required reasoning or tool-call items
      // and make the next request fail.
      assert.ok(second.some((item) => item.type === 'reasoning'), 'the reasoning item must be replayed');
      assert.ok(second.some((item) => item.type === 'function_call'));
      // A tool result is a TOP-LEVEL item here, not a content block inside a user message.
      const result = second.find((item) => item.type === 'function_call_output');
      assert.ok(result, 'the tool result must be a top-level input item');
      assert.equal(result.call_id, 'call_1');
      assert.equal(typeof result.output, 'string');
    }
  );
});

function geminiSse(chunks: Array<Record<string, unknown>>): string {
  return chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('');
}

test('Gemini: a one-round answer builds no cache at all', async (t) => {
  const db = chatDb();
  t.after(() => db.close());
  useModel(db, 'gemini-3.6-flash');

  // Creating the cache up front is a COST REGRESSION on the commonest question: caches.create
  // bills the prefix at the full input rate, so one round that reads it back once pays a full
  // write plus a read plus storage where an inline prompt pays one full read and nothing else.
  await chatAgainstHost('GEMINI_BASE_URL', 'GEMINI_API_KEY',
    () => ({ sse: geminiSse([geminiResponse('Both goals are on track.')]) }),
    (events, http) => {
      assert.deepEqual(events, [
        { type: 'chunk', text: 'Both goals are on track.' },
        { type: 'done' },
      ]);
      assert.ok(
        !http.sent.some((r) => r.path.includes('/cachedContents')),
        'a single round must not pay for a cache it can only read once'
      );
      const generate = http.sent.find((r) => r.path.includes(':streamGenerateContent'));
      assert.ok(generate?.body.systemInstruction, 'the prompt is sent inline instead');
    }
  );
});

test('Gemini: a tool round moves the prompt and tools into a cache object', async (t) => {
  const db = chatDb();
  t.after(() => db.close());
  useModel(db, 'gemini-3.6-flash');

  const toolChunk = {
    candidates: [
      {
        content: { role: 'model', parts: [{ functionCall: { name: 'list_goals', args: {} }, thoughtSignature: 'opaque' }] },
        finishReason: 'STOP',
        index: 0,
      },
    ],
    usageMetadata: { promptTokenCount: 1200, cachedContentTokenCount: 0, candidatesTokenCount: 10, totalTokenCount: 1210 },
  };
  let turn = 0;

  await chatAgainstHost('GEMINI_BASE_URL', 'GEMINI_API_KEY',
    (req) => {
      if (req.path.includes('/cachedContents') && req.method === 'POST') {
        return { json: { name: 'cachedContents/abc123', model: 'models/gemini-3.6-flash', usageMetadata: { totalTokenCount: 11000 } } };
      }
      if (req.method === 'DELETE') return { json: {} };
      return { sse: geminiSse([turn++ === 0 ? toolChunk : geminiResponse('You are ahead on both.')]) };
    },
    (events, http) => {
      assert.deepEqual(events, [
        { type: 'tool_use', name: 'list_goals' },
        { type: 'chunk', text: 'You are ahead on both.' },
        { type: 'done' },
      ]);

      const create = http.sent.find((r) => r.method === 'POST' && r.path.includes('/cachedContents'));
      assert.ok(create, 'a second round means the cache starts paying for itself');
      assert.ok(create.body.systemInstruction, 'the system prompt lives in the cache');
      assert.ok(Array.isArray(create.body.tools), 'so does the whole tool list');
      assert.equal(create.body.ttl, '600s');

      const generates = http.sent.filter((r) => r.path.includes(':streamGenerateContent'));
      assert.equal(generates.length, 2);
      // The first round predates the cache and carries the prompt inline.
      assert.ok(generates[0].body.systemInstruction);
      assert.ok(!('cachedContent' in generates[0].body));
      // The second names the cache and may NOT also carry systemInstruction/tools/toolConfig:
      // the API answers 400. This is the largest structural difference of the three providers.
      assert.equal(generates[1].body.cachedContent, 'cachedContents/abc123');
      assert.ok(!('systemInstruction' in generates[1].body), 'sending it alongside the cache is a 400');
      assert.ok(!('tools' in generates[1].body), 'sending them alongside the cache is a 400');

      // The model turn is replayed part for part, signature included: the thinking docs say
      // not to concatenate, merge or modify a signature-carrying part.
      const replayed = generates[1].body.contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
      const modelTurn = replayed.find((c) => c.role === 'model');
      assert.equal(modelTurn?.parts[0].thoughtSignature, 'opaque');
      const toolResult = replayed.at(-1);
      assert.equal(toolResult?.role, 'user');
      // An OBJECT, not a JSON string, and not a distinct message role.
      assert.equal(typeof (toolResult?.parts[0].functionResponse as { response: unknown }).response, 'object');

      // An undeleted cache keeps billing storage until its TTL expires.
      assert.ok(http.sent.some((r) => r.method === 'DELETE' && r.path.includes('cachedContents/abc123')));
    }
  );
});

test('Gemini: a cache that cannot be created degrades to an inline prompt, and says so', async (t) => {
  const db = chatDb();
  t.after(() => db.close());
  useModel(db, 'gemini-3.6-flash');

  // Below the model's minimum token count `caches.create` is a 400. The right answer is to
  // send the prompt and tools inline and record why, not to fail the owner's question. Driven
  // through a TOOL round, because that is the only point at which a cache is attempted.
  const toolChunk = {
    candidates: [
      { content: { role: 'model', parts: [{ functionCall: { name: 'list_goals', args: {} } }] }, finishReason: 'STOP', index: 0 },
    ],
    usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 10, totalTokenCount: 1210 },
  };
  let turn = 0;

  await chatAgainstHost('GEMINI_BASE_URL', 'GEMINI_API_KEY',
    (req) => {
      if (req.path.includes('/cachedContents') && req.method === 'POST') {
        return { status: 400, json: { error: { code: 400, message: 'Cached content is too small.', status: 'INVALID_ARGUMENT' } } };
      }
      return { sse: geminiSse([turn++ === 0 ? toolChunk : geminiResponse('You are ahead on both.')]) };
    },
    (events, http) => {
      assert.deepEqual(events, [
        { type: 'tool_use', name: 'list_goals' },
        { type: 'chunk', text: 'You are ahead on both.' },
        { type: 'done' },
      ], 'a cache that cannot be built must not cost the owner their answer');

      assert.ok(
        http.sent.some((r) => r.method === 'POST' && r.path.includes('/cachedContents')),
        'the fallback is only meaningful if a cache was actually attempted'
      );
      const generates = http.sent.filter((r) => r.path.includes(':streamGenerateContent'));
      assert.equal(generates.length, 2);
      for (const generate of generates) {
        assert.ok(!('cachedContent' in generate.body));
        assert.ok(generate.body.systemInstruction, 'the prompt is sent inline instead');
        assert.ok(Array.isArray(generate.body.tools as unknown[]), 'and so are the tools');
      }
    }
  );
});

// ─── What a multi-round turn cost, on every provider ─────────────────────────
//
// The one number that decides whether this design is affordable, and the only place all three
// providers can be wrong in the same flattering direction. Gemini's adapter kept the LAST
// chunk's figures instead of adding the rounds up, so an eight-round turn reported round
// eight and nothing else: uncached input understated by every earlier round, and the cache
// made to look several times better than it is. Asserted for all three so it cannot come back
// on any of them, and so a "fix" that sums Gemini's per-chunk restatements fails too.
//
// One scenario, three accountings. Round 0 pays 5000 uncached and writes the prefix; round 1
// reads that prefix back and pays 1000 uncached. The truth is 6000 uncached, 5000 read and
// 150 output, whichever provider is asked.

const ROUND_0_ANTHROPIC: TurnUsage = {
  input_tokens: 5000,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 5000,
  output_tokens: 100,
};
const ROUND_1_ANTHROPIC: TurnUsage = {
  input_tokens: 1000,
  cache_read_input_tokens: 5000,
  cache_creation_input_tokens: 0,
  output_tokens: 50,
};

/** OpenAI's `input_tokens` is the TOTAL, cached included, so 6000 here is 1000 uncached. */
const ROUND_0_OPENAI = {
  input_tokens: 5000,
  input_tokens_details: { cached_tokens: 0, cache_write_tokens: 5000 },
  output_tokens: 100,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: 5100,
};
const ROUND_1_OPENAI = {
  input_tokens: 6000,
  input_tokens_details: { cached_tokens: 5000, cache_write_tokens: 0 },
  output_tokens: 50,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: 6050,
};

/** Gemini's `promptTokenCount` likewise INCLUDES `cachedContentTokenCount`. */
const ROUND_0_GEMINI = { promptTokenCount: 5000, cachedContentTokenCount: 0, candidatesTokenCount: 100, totalTokenCount: 5100 };
const ROUND_1_GEMINI = { promptTokenCount: 6000, cachedContentTokenCount: 5000, candidatesTokenCount: 50, totalTokenCount: 6050 };

/** The line routes/ai.ts writes per turn, which is where these figures are actually read. */
function chatUsageLine(logs: string[]): string {
  const line = logs.find((l) => l.startsWith('[ai/chat]'));
  assert.ok(line, 'a chat turn must report what it cost');
  return line;
}

function assertTwoRoundTotals(logs: string[]): void {
  const line = chatUsageLine(logs);
  assert.match(line, /uncached input 6000 tok/, `only the last round was counted: ${line}`);
  assert.match(line, /output 150 tok/, `output was overwritten rather than added: ${line}`);
  assert.match(line, /read 5000 tok/, `the cache read was not carried: ${line}`);
}

test('Anthropic: a two-round turn reports both rounds, not the last one', async (t) => {
  const db = chatDb();
  t.after(() => db.close());

  const logs = await captureConsole('log', () =>
    chatOverHttp(
      [
        { blocks: [{ type: 'tool_use', id: 'toolu_1', name: 'list_goals' }], stopReason: 'tool_use', usage: ROUND_0_ANTHROPIC },
        { blocks: [{ type: 'text', text: 'You are ahead on both.' }], stopReason: 'end_turn', usage: ROUND_1_ANTHROPIC },
      ],
      askAboutGoals,
      (events, api) => {
        assert.equal(api.sent.length, 2, 'one tool round plus the answering turn');
        assert.deepEqual(events, [
          { type: 'tool_use', name: 'list_goals' },
          { type: 'chunk', text: 'You are ahead on both.' },
          { type: 'done' },
        ]);
      }
    )
  );

  assertTwoRoundTotals(logs);
});

test('OpenAI: a two-round turn reports both rounds, not the last one', async (t) => {
  const db = chatDb();
  t.after(() => db.close());
  useModel(db, 'gpt-5.6-terra');

  let turn = 0;
  const logs = await captureConsole('log', () =>
    chatAgainstHost('OPENAI_BASE_URL', 'OPENAI_API_KEY',
      () => (turn++ === 0
        ? { sse: openaiToolTurn(ROUND_0_OPENAI).sse }
        : { sse: openaiTextTurn('You are ahead on both.', ROUND_1_OPENAI) }),
      (events, http) => {
        assert.equal(http.sent.length, 2);
        assert.deepEqual(events, [
          { type: 'tool_use', name: 'list_goals' },
          { type: 'chunk', text: 'You are ahead on both.' },
          { type: 'done' },
        ]);
      }
    )
  );

  assertTwoRoundTotals(logs);
});

test('Gemini: a two-round turn reports both rounds, and restated chunks are not double-counted', async (t) => {
  const db = chatDb();
  t.after(() => db.close());
  useModel(db, 'gemini-3.6-flash');

  const toolChunk = {
    candidates: [
      { content: { role: 'model', parts: [{ functionCall: { name: 'list_goals', args: {} } }] }, finishReason: 'STOP', index: 0 },
    ],
    usageMetadata: ROUND_0_GEMINI,
  };
  // Round 1 arrives as TWO chunks, each carrying a running total rather than an increment.
  // Adding them would report 70 output tokens for a round that produced 50, so the adapter has
  // to keep the last figure within a round and add only across rounds.
  const partial = {
    candidates: [{ content: { role: 'model', parts: [{ text: 'You are ' }] }, index: 0 }],
    usageMetadata: { ...ROUND_1_GEMINI, candidatesTokenCount: 20, totalTokenCount: 6020 },
  };
  const final = geminiResponse('ahead on both.', { usageMetadata: ROUND_1_GEMINI });
  let turn = 0;

  const logs = await captureConsole('log', () =>
    chatAgainstHost('GEMINI_BASE_URL', 'GEMINI_API_KEY',
      (req) => {
        if (req.path.includes('/cachedContents') && req.method === 'POST') {
          return { json: { name: 'cachedContents/abc123', usageMetadata: { totalTokenCount: 11000 } } };
        }
        if (req.method === 'DELETE') return { json: {} };
        return { sse: geminiSse(turn++ === 0 ? [toolChunk] : [partial, final]) };
      },
      (events) => {
        assert.deepEqual(events, [
          { type: 'tool_use', name: 'list_goals' },
          { type: 'chunk', text: 'You are ' },
          { type: 'chunk', text: 'ahead on both.' },
          { type: 'done' },
        ]);
      }
    )
  );

  assertTwoRoundTotals(logs);
});

// ─── OpenAI reasoning summaries: asked for only where one is read ─────────────

test('OpenAI: a chat turn asks for a reasoning summary and the one-shot calls do not', async (t) => {
  const db = chatDb();
  t.after(() => db.close());
  useModel(db, 'gpt-5.6-terra');

  // `summary` is the only parameter here an organization may not be entitled to send, and on
  // the one-shot paths it is also pure waste: `createOnce` returns `output_text`, which never
  // includes a reasoning item, so a summary there is billed output nothing reads.
  await chatAgainstHost('OPENAI_BASE_URL', 'OPENAI_API_KEY',
    () => ({ sse: openaiTextTurn('Both goals are on track.') }),
    (_events, http) => {
      const reasoning = http.sent[0].body.reasoning as { summary?: string };
      assert.equal(reasoning.summary, 'auto', 'nothing streams as thinking without it');
    }
  );
});

test('OpenAI: the worker asks for no reasoning summary, because it reads none', async (t) => {
  const db = workerDb();
  t.after(() => db.close());
  useModel(db, 'gpt-5.6-terra', 'background_review');

  await withFakeHost('OPENAI_BASE_URL', 'OPENAI_API_KEY',
    () => ({ json: openaiResponse(workerDraftsJson) }),
    async (http) => {
      const errors = await captureConsole('error', () => runBackgroundAiReview({ db }));
      assert.deepEqual(errors, []);
      const reasoning = http.sent[0].body.reasoning as Record<string, unknown>;
      assert.equal(reasoning.effort, 'medium', 'the effort dial is still set');
      assert.ok(!('summary' in reasoning), 'a summary here is billed output that nothing consumes');
    }
  );
});

test('OpenAI: an org that cannot have reasoning summaries still gets its answer, and is told', async (t) => {
  const db = chatDb();
  t.after(() => db.close());
  useModel(db, 'gpt-5.6-terra');

  // The exact 400 an unverified organization gets. It would otherwise take out all three
  // OpenAI call sites over a display nicety, so the round is retried without the summary.
  const refusal = {
    status: 400,
    json: {
      error: {
        message: 'Your organization must be verified to generate reasoning summaries.',
        type: 'invalid_request_error',
        param: 'reasoning.summary',
        code: 'unsupported_value',
      },
    },
  };
  let attempt = 0;

  const warnings = await captureConsole('warn', () =>
    chatAgainstHost('OPENAI_BASE_URL', 'OPENAI_API_KEY',
      () => (attempt++ === 0 ? refusal : { sse: openaiTextTurn('Both goals are on track.') }),
      (events, http) => {
        assert.deepEqual(events, [
          { type: 'chunk', text: 'Both goals are on track.' },
          { type: 'done' },
        ], 'a summary the org may not have must not cost the owner their answer');

        assert.equal(http.sent.length, 2, 'the refused round is retried, not abandoned');
        const first = http.sent[0].body.reasoning as { summary?: string; effort?: string };
        const second = http.sent[1].body.reasoning as { summary?: string; effort?: string };
        assert.equal(first.summary, 'auto');
        assert.ok(!('summary' in second), 'the retry drops the parameter that was refused');
        assert.equal(second.effort, first.effort, 'and changes nothing else about the request');
      }
    )
  );

  assert.equal(warnings.length, 1, 'silently losing the thinking pane reads as a model that stopped reasoning');
  assert.match(warnings[0], /reasoning summaries/i);
});

// ─── A truncated answer is not a completed one ───────────────────────────────

test('Anthropic: a turn cut off at the output cap says so instead of closing as done', async (t) => {
  const db = chatDb();
  t.after(() => db.close());

  // A DELIBERATE CHANGE from the loop this replaced, which checked only for empty content and
  // then completed: a severed answer streamed its partial text and closed with {type:'done'}.
  // The partial text still streams, because it is what the model managed to say, and an error
  // frame now follows it. Both Gemini (finishReason MAX_TOKENS) and OpenAI (status
  // 'incomplete') already reported this, so the alternative was Anthropic alone staying quiet.
  await chatOverHttp(
    [{ blocks: [{ type: 'text', text: 'Your goals are ' }], stopReason: 'max_tokens' }],
    askAboutGoals,
    (events) => {
      assert.equal(events.filter((e) => e.type === 'done').length, 0);
      assert.deepEqual(events[0], { type: 'chunk', text: 'Your goals are ' }, 'the partial answer is not withheld');
      const errors = events.filter((e) => e.type === 'error');
      assert.equal(errors.length, 1);
      assert.match(String(errors[0].message), /output cap/);
    }
  );
});

test('Gemini: a thought part streams as thinking, not as the answer', async (t) => {
  const db = chatDb();
  t.after(() => db.close());
  useModel(db, 'gemini-3.6-flash');

  // There is no thinking_start/_end event on this provider; both boundaries are synthesised
  // from the `thought` flag turning on and off, and a thought part read as answer text would
  // put the model's reasoning in the owner's answer.
  await chatAgainstHost('GEMINI_BASE_URL', 'GEMINI_API_KEY',
    (req) => {
      if (req.path.includes('/cachedContents') && req.method === 'POST') {
        return { json: { name: 'cachedContents/abc123', usageMetadata: { totalTokenCount: 11000 } } };
      }
      if (req.method === 'DELETE') return { json: {} };
      return {
        sse: geminiSse([
          { candidates: [{ content: { role: 'model', parts: [{ text: 'Checking the goals.', thought: true }] }, index: 0 }] },
          geminiResponse('Both goals are on track.'),
        ]),
      };
    },
    (events) => {
      assert.deepEqual(events, [
        { type: 'thinking_start' },
        { type: 'thinking', text: 'Checking the goals.' },
        { type: 'thinking_end' },
        { type: 'chunk', text: 'Both goals are on track.' },
        { type: 'done' },
      ]);
    }
  );
});
