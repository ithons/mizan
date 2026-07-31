import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
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
  buildModelRequestShape,
} from '../server/src/services/advisorSettings';
import { WORKER_DRAFTS_FORMAT, runBackgroundAiReview } from '../server/src/services/aiWorker';
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

  const server = http.createServer((req, res) => {
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
  channel: 'error' | 'warn',
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

test('every advisor-selectable model accepts every effort the settings screen offers', () => {
  // The guard that a whitelist test cannot give: re-adding a model that takes no effort level
  // would render an effort dial in Settings that the derived shape silently drops.
  for (const { id } of ADVISOR_MODELS) {
    const caps = MODEL_CAPABILITIES[id];
    assert.ok(caps, `${id} is offered but has no capability entry`);
    for (const effort of ADVISOR_EFFORTS) {
      assert.ok(caps.efforts.includes(effort), `${id} is offered but does not accept effort '${effort}'`);
    }
  }
});

test('the derived shape never carries a parameter the model rejects', () => {
  for (const [id, caps] of Object.entries(MODEL_CAPABILITIES)) {
    for (const effort of ADVISOR_EFFORTS) {
      const shape = buildModelRequestShape(id, {
        effort,
        thinkingDisplay: 'summarized',
        outputFormat: WORKER_DRAFTS_FORMAT,
      });
      assert.equal(
        shape.thinking !== undefined,
        caps.adaptiveThinking,
        `${id}: thinking sent=${shape.thinking !== undefined}, supported=${caps.adaptiveThinking}`
      );
      assert.equal(
        shape.output_config?.effort !== undefined,
        caps.efforts.includes(effort),
        `${id}: effort '${effort}' sent when unsupported`
      );
      assert.equal(
        shape.output_config?.format !== undefined,
        caps.structuredOutput,
        `${id}: structured output sent when unsupported`
      );
    }
  }
});

test('a model with no capability entry gets a bare request, never a guessed one', () => {
  // No optional parameter here is valid on every model, so "unknown" has to mean "send nothing".
  assert.deepEqual(
    buildModelRequestShape('some-model-added-later', {
      effort: 'max',
      thinkingDisplay: 'summarized',
      outputFormat: WORKER_DRAFTS_FORMAT,
    }),
    {}
  );
});

test('every job names a model the capability table knows', () => {
  for (const [job, assignment] of Object.entries(JOB_MODELS)) {
    const caps = MODEL_CAPABILITIES[assignment.model];
    assert.ok(caps, `job '${job}' names unknown model '${assignment.model}'`);
    if (assignment.effort) {
      assert.ok(
        caps.efforts.includes(assignment.effort),
        `job '${job}' asks for effort '${assignment.effort}', which ${assignment.model} does not accept`
      );
    }
  }
});

// ─── The worker's structured-output contract ─────────────────────────────────

// Structured outputs reject these; each one is a 400 on every run rather than a bad answer.
const UNSUPPORTED_SCHEMA_KEYWORDS = [
  'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'exclusiveMinimum',
  'exclusiveMaximum', 'multipleOf', 'minItems', 'maxItems', 'uniqueItems',
  'minProperties', 'maxProperties', 'patternProperties', '$ref', '$defs',
];

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

test('the draft output schema satisfies the structured-output restrictions', () => {
  walkSchema(WORKER_DRAFTS_FORMAT.schema, 'schema', (node, path) => {
    for (const keyword of UNSUPPORTED_SCHEMA_KEYWORDS) {
      assert.ok(!(keyword in node), `${path} uses unsupported keyword '${keyword}'`);
    }
    if (node.type !== 'object') return;
    assert.equal(node.additionalProperties, false, `${path} is an object without additionalProperties: false`);
    const properties = Object.keys((node.properties ?? {}) as Record<string, unknown>);
    assert.deepEqual(
      [...(node.required as string[] ?? [])].sort(),
      [...properties].sort(),
      `${path} must require every property it declares`
    );
  });
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
    assert.deepEqual(outputConfig.format, WORKER_DRAFTS_FORMAT);
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

interface StreamTurn {
  blocks: StreamBlock[];
  stopReason: 'end_turn' | 'tool_use';
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
      usage: { input_tokens: 10, output_tokens: 0 },
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
    usage: { output_tokens: 20 },
  });
  push('message_stop', {});

  return frames.join('');
}

async function listenOn(server: http.Server): Promise<number> {
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

  const upstream = http.createServer((req, res) => {
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
  const local = http.createServer(app);
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
