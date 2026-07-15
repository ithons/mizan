import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';

// Durable storage for advisor chat threads. The chat itself still streams statelessly
// (routes/ai.ts /chat); the client persists each settled exchange here so history
// survives reloads and past conversations can be reopened.

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

export function deleteConversation(db: Database.Database, id: string): { changed: number } {
  const result = db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
  return { changed: result.changes };
}
