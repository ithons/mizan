import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  createConversation,
  listConversations,
  getConversation,
  appendMessages,
  deleteConversation,
} from '../server/src/services/conversations';

function setup(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('user','assistant')),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  db.pragma('foreign_keys = ON');
  return db;
}

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
