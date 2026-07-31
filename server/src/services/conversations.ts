import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';

// Durable storage for advisor chat threads. The client persists each settled exchange here so
// history survives reloads and past conversations can be reopened, and `buildChatTurns` below is
// what `POST /api/ai/chat` reconstructs a turn from, so the thread the model sees is the thread
// this database holds rather than an array the request supplied.

export interface ConversationSummary {
  id: string;
  title: string;
  updated_at: string;
  message_count: number;
}

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ConversationDetail {
  id: string;
  title: string;
  messages: ConversationMessage[];
}

export function createConversation(db: Database.Database, title = ''): { id: string } {
  const id = uuidv4();
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)'
  ).run(id, title.slice(0, 200), now, now);
  return { id };
}

export function listConversations(db: Database.Database): ConversationSummary[] {
  return db.prepare(`
    SELECT c.id, c.title, c.updated_at,
           (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
    FROM conversations c
    ORDER BY c.updated_at DESC, c.rowid DESC
  `).all() as ConversationSummary[];
}

export function getConversation(db: Database.Database, id: string): ConversationDetail | null {
  const row = db.prepare('SELECT id, title FROM conversations WHERE id = ?').get(id) as
    | { id: string; title: string }
    | undefined;
  if (!row) return null;
  const messages = db.prepare(
    'SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC'
  ).all(id) as ConversationMessage[];
  return { id: row.id, title: row.title, messages };
}

// Append one or more messages and touch the conversation. Derives a title from the first
// user message the first time content arrives, so the list is readable without a prompt.
export function appendMessages(
  db: Database.Database,
  id: string,
  msgs: ConversationMessage[]
): { ok: boolean } {
  const conversation = db.prepare('SELECT id, title FROM conversations WHERE id = ?').get(id) as
    | { id: string; title: string }
    | undefined;
  if (!conversation) return { ok: false };

  const now = new Date().toISOString();
  const insert = db.prepare(
    'INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)'
  );

  const apply = db.transaction(() => {
    for (const m of msgs) {
      insert.run(uuidv4(), id, m.role, m.content, now);
    }
    let title = conversation.title;
    if (!title) {
      const firstUser = msgs.find((m) => m.role === 'user');
      if (firstUser) title = firstUser.content.replace(/\s+/g, ' ').trim().slice(0, 80);
    }
    db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?').run(title, now, id);
  });
  apply();
  return { ok: true };
}

export interface ChatTurnRequest {
  /** When set, the prior turns come from this conversation's stored messages. */
  conversationId?: string | null;
  /** The turn being asked now. It is not in the store yet: the client persists a settled exchange. */
  message?: string | null;
  /** Prior turns supplied by the request. Used only when there is no conversation id. */
  clientMessages?: readonly ConversationMessage[] | null;
}

export type ChatTurnsResult =
  | { ok: true; messages: ConversationMessage[]; history_source: 'conversation' | 'request' }
  | { ok: false; reason: 'conversation_not_found' | 'no_message' };

/**
 * The message list a chat turn runs on.
 *
 * The conversation id is the authoritative form. The client used to post its whole history array
 * and the server seeded the model from it, which put the shape of the prompt outside the server's
 * control: the system block sits behind `cache_control` and an ephemeral cache is only worth
 * anything if the prefix in front of it is stable and the server can reason about it.
 *
 * The request-supplied form is kept, and is not a fallback for a conversation that failed to load.
 * It is the path for a turn that has no conversation at all, which is a real state: the client
 * creates the conversation row on a best-effort basis and chat has to keep working when that write
 * fails. A conversation id that names nothing is an error rather than a silent demotion to the
 * client's array, because demoting quietly would reintroduce exactly what this function removes.
 *
 * The current turn is never read from the store. `appendMessages` runs after the answer settles, so
 * at the moment a turn starts the store holds every earlier exchange and not this one.
 */
export function buildChatTurns(db: Database.Database, request: ChatTurnRequest): ChatTurnsResult {
  const conversationId = request.conversationId?.trim() || null;
  const message = request.message?.trim() ?? '';

  if (conversationId) {
    if (!message) return { ok: false, reason: 'no_message' };
    const conversation = getConversation(db, conversationId);
    if (!conversation) return { ok: false, reason: 'conversation_not_found' };
    return {
      ok: true,
      messages: [...conversation.messages, { role: 'user', content: message }],
      history_source: 'conversation',
    };
  }

  const supplied = request.clientMessages ?? [];
  const messages = [...supplied, ...(message ? [{ role: 'user' as const, content: message }] : [])];
  if (messages.length === 0) return { ok: false, reason: 'no_message' };
  return { ok: true, messages, history_source: 'request' };
}

export function deleteConversation(db: Database.Database, id: string): { changed: number } {
  const result = db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
  return { changed: result.changes };
}
