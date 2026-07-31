import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import Database from 'better-sqlite3';
import aiRouter from '../server/src/routes/ai';
import { _setDbForTesting } from '../server/src/db/index';
import { migratedTestDb } from './helpers/schema';
import {
  buildChatTurns,
  createConversation,
  listConversations,
  getConversation,
  appendMessages,
  deleteConversation,
} from '../server/src/services/conversations';

const setup = migratedTestDb;

test('create, append, and read a conversation round-trips messages in order', (t) => {
  const db = setup();
  t.after(() => db.close());
  const { id } = createConversation(db);
  appendMessages(db, id, [
    { role: 'user', content: 'How much did I spend on food?' },
    { role: 'assistant', content: 'About $240 this month.' },
  ]);
  const conv = getConversation(db, id);
  assert.equal(conv?.messages.length, 2);
  assert.equal(conv?.messages[0].role, 'user');
  assert.equal(conv?.messages[1].content, 'About $240 this month.');
});

test('title is derived from the first user message', (t) => {
  const db = setup();
  t.after(() => db.close());
  const { id } = createConversation(db);
  appendMessages(db, id, [
    { role: 'user', content: 'Where can I cut spending?' },
    { role: 'assistant', content: 'Look at dining out.' },
  ]);
  assert.equal(getConversation(db, id)?.title, 'Where can I cut spending?');
});

test('listConversations reports message counts, newest first', (t) => {
  const db = setup();
  t.after(() => db.close());
  const a = createConversation(db).id;
  appendMessages(db, a, [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'ok' }]);
  const b = createConversation(db).id;
  appendMessages(db, b, [{ role: 'user', content: 'second' }]);
  const list = listConversations(db);
  assert.equal(list.length, 2);
  assert.equal(list[0].id, b); // most recently updated first
  const counts = new Map(list.map((c) => [c.id, c.message_count]));
  assert.equal(counts.get(a), 2);
  assert.equal(counts.get(b), 1);
});

test('appendMessages to a missing conversation reports not-ok', (t) => {
  const db = setup();
  t.after(() => db.close());
  assert.equal(appendMessages(db, 'nope', [{ role: 'user', content: 'x' }]).ok, false);
});

/**
 * The chat used to seed the model from an array the request supplied. These cover the switch to
 * loading it from the conversation, and the thing that switch must not change: the turn list the
 * model sees for a given exchange.
 */

test('HEALTHY: the server-loaded history is identical to the array the client used to send', (t) => {
  const db = setup();
  t.after(() => db.close());

  const { id } = createConversation(db);
  appendMessages(db, id, [
    { role: 'user', content: 'How much did I spend on food?' },
    { role: 'assistant', content: 'About $240 this month.' },
  ]);

  // What the client posted before: every earlier turn plus the new one, in one array.
  const clientSupplied = buildChatTurns(db, {
    clientMessages: [
      { role: 'user', content: 'How much did I spend on food?' },
      { role: 'assistant', content: 'About $240 this month.' },
      { role: 'user', content: 'And on transport?' },
    ],
    message: null,
  });
  // What it posts now: the id, and the new turn only.
  const serverLoaded = buildChatTurns(db, { conversationId: id, message: 'And on transport?' });

  assert.equal(clientSupplied.ok, true);
  assert.equal(serverLoaded.ok, true);
  if (!clientSupplied.ok || !serverLoaded.ok) return;
  assert.deepEqual(serverLoaded.messages, clientSupplied.messages);
  assert.equal(serverLoaded.history_source, 'conversation');
  assert.equal(clientSupplied.history_source, 'request');
});

test('HEALTHY: the first turn of a brand-new conversation is just that turn', (t) => {
  const db = setup();
  t.after(() => db.close());

  const { id } = createConversation(db);
  const turns = buildChatTurns(db, { conversationId: id, message: 'Where can I cut $200 a month?' });

  assert.equal(turns.ok, true);
  if (!turns.ok) return;
  assert.deepEqual(turns.messages, [{ role: 'user', content: 'Where can I cut $200 a month?' }]);
});

test('HEALTHY: a turn with no conversation still works, unchanged', (t) => {
  const db = setup();
  t.after(() => db.close());

  // The client creates the conversation row best-effort. When that write fails there is no id, and
  // chat has to keep working rather than refusing.
  const turns = buildChatTurns(db, {
    conversationId: null,
    clientMessages: [{ role: 'user', content: 'Am I on track for my goals?' }],
  });

  assert.equal(turns.ok, true);
  if (!turns.ok) return;
  assert.deepEqual(turns.messages, [{ role: 'user', content: 'Am I on track for my goals?' }]);
  assert.equal(turns.history_source, 'request');
});

test('a conversation id that names nothing is refused rather than demoted to the client array', (t) => {
  const db = setup();
  t.after(() => db.close());

  const turns = buildChatTurns(db, {
    conversationId: 'gone',
    message: 'And on transport?',
    clientMessages: [{ role: 'user', content: 'anything at all' }],
  });

  assert.equal(turns.ok, false);
  if (turns.ok) return;
  assert.equal(turns.reason, 'conversation_not_found');
});

test('a conversation id with no message is refused: the store never holds the current turn', (t) => {
  const db = setup();
  t.after(() => db.close());

  const { id } = createConversation(db);
  appendMessages(db, id, [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'ok' }]);

  const turns = buildChatTurns(db, { conversationId: id, message: '   ' });
  assert.equal(turns.ok, false);
  if (turns.ok) return;
  assert.equal(turns.reason, 'no_message');
});

test('an empty request is refused', (t) => {
  const db = setup();
  t.after(() => db.close());
  const turns = buildChatTurns(db, {});
  assert.equal(turns.ok, false);
});

/**
 * The same claim one level up: drive the real router against a fake Anthropic endpoint and read the
 * outgoing request body. The unit tests above compare the turn list; this compares what actually
 * goes on the wire, which is the thing the ephemeral cache prefix depends on.
 */
async function chatRequestBody(body: unknown): Promise<Record<string, unknown>> {
  let sent: Record<string, unknown> = {};
  const upstream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      sent = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        'event: message_stop\ndata: {"type":"message_stop"}\n\n'
      );
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));

  const app = express();
  app.use(express.json());
  app.use('/api/ai', aiRouter);
  const local = http.createServer(app);
  await new Promise<void>((resolve) => local.listen(0, '127.0.0.1', resolve));

  const prevBaseUrl = process.env.ANTHROPIC_BASE_URL;
  const prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  process.env.ANTHROPIC_API_KEY = 'test-key-never-used';
  try {
    const res = await fetch(`http://127.0.0.1:${(local.address() as AddressInfo).port}/api/ai/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    await res.text();
    return sent;
  } finally {
    if (prevBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = prevBaseUrl;
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
    await new Promise<void>((resolve) => local.close(() => resolve()));
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
}

test('HEALTHY: over HTTP, the conversation-loaded turn sends the same body as the client array did', async (t) => {
  const db = migratedTestDb();
  _setDbForTesting(db);
  t.after(() => db.close());

  const { id } = createConversation(db);
  appendMessages(db, id, [
    { role: 'user', content: 'How much did I spend on food?' },
    { role: 'assistant', content: 'About $240 this month.' },
  ]);

  const fromArray = await chatRequestBody({
    messages: [
      { role: 'user', content: 'How much did I spend on food?' },
      { role: 'assistant', content: 'About $240 this month.' },
      { role: 'user', content: 'And on transport?' },
    ],
  });
  const fromConversation = await chatRequestBody({
    conversation_id: id,
    message: 'And on transport?',
  });

  assert.deepEqual(fromConversation, fromArray, 'the whole outgoing request, not just the messages');
});

test('over HTTP, an unknown conversation id is a 404 rather than a quiet fallback', async (t) => {
  const db = migratedTestDb();
  _setDbForTesting(db);
  t.after(() => db.close());

  const sent = await chatRequestBody({
    conversation_id: 'gone',
    message: 'And on transport?',
    messages: [{ role: 'user', content: 'anything at all' }],
  });
  assert.deepEqual(sent, {}, 'nothing reached the model');
});

/**
 * The digest routes ride along here because this file already owns the harness that mounts the real
 * ai router over HTTP, and `since` is a route-level concern: the service never sees the raw string.
 */
async function withAiRouter<T>(
  db: Database.Database,
  run: (base: string) => Promise<T>
): Promise<T> {
  _setDbForTesting(db);
  const app = express();
  app.use(express.json());
  app.use('/api/ai', aiRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('HEALTHY: a real ISO since is accepted, and a date-only one is normalized rather than refused', async (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  await withAiRouter(db, async (base) => {
    const full = await fetch(`${base}/api/ai/digest?since=${encodeURIComponent('2026-07-01T00:00:00.000Z')}`);
    assert.equal(full.status, 200);
    assert.equal(((await full.json()) as { data: { since: string } }).data.since, '2026-07-01T00:00:00.000Z');

    const dateOnly = await fetch(`${base}/api/ai/digest?since=2026-07-01`);
    assert.equal(dateOnly.status, 200);
    assert.equal(
      ((await dateOnly.json()) as { data: { since: string } }).data.since,
      '2026-07-01T00:00:00.000Z',
      'normalized to the form created_at is stored in, because the comparison is lexicographic'
    );
  });
});

test('a since Date.parse accepts but the ledger cannot compare is refused, not silently answered', async (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  // 'Jan 1 2020' parses fine and then sorts ABOVE every ISO created_at, so the revert used to
  // return ok with planned_rows 0 and reverted_rows 0: success, having done nothing.
  await withAiRouter(db, async (base) => {
    for (const bad of ['Jan 1 2020', '07/01/2026', 'yesterday']) {
      const get = await fetch(`${base}/api/ai/digest?since=${encodeURIComponent(bad)}`);
      assert.equal(get.status, 400, `${bad} must be refused by GET /digest`);

      const post = await fetch(`${base}/api/ai/digest/revert`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ since: bad }),
      });
      assert.equal(post.status, 400, `${bad} must be refused by POST /digest/revert`);
    }
  });
});

test('the digest echoes the action cap it used, and the revert refuses a wider one', async (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  await withAiRouter(db, async (base) => {
    const res = await fetch(`${base}/api/ai/digest?limit=5`);
    const body = (await res.json()) as { data: { action_limit: number } };
    assert.equal(body.data.action_limit, 5, 'the panel can send this back so both name one population');

    const tooBig = await fetch(`${base}/api/ai/digest/revert`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ since: '2026-07-01T00:00:00.000Z', limit: 99999 }),
    });
    assert.equal(tooBig.status, 400);
  });
});

test('deleting a conversation cascades its messages', (t) => {
  const db = setup();
  t.after(() => db.close());
  const { id } = createConversation(db);
  appendMessages(db, id, [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }]);
  assert.equal(deleteConversation(db, id).changed, 1);
  assert.equal(getConversation(db, id), null);
  const remaining = db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number };
  assert.equal(remaining.n, 0);
});
