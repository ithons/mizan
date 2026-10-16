import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTurnGate } from '../client/src/lib/turnGate';

test('a turn stopped and replaced before its save resolves no longer owns the streaming state', () => {
  const turns = createTurnGate();
  const first = turns.begin();
  turns.supersede();
  const second = turns.begin();
  assert.equal(first(), false);
  assert.equal(second(), true);
});

test('stopping with nothing new begun still retires the old turn', () => {
  const turns = createTurnGate();
  const only = turns.begin();
  turns.supersede();
  assert.equal(only(), false);
});

test('the chat hook clears streaming and adopts a new conversation only for the current turn', () => {
  const source = readFileSync(new URL('../client/src/hooks/useAiChat.ts', import.meta.url), 'utf8');
  const send = source.slice(source.indexOf('const sendMessage'), source.indexOf('const stopStreaming'));
  for (const line of send.split('\n').filter((l) => l.includes('setIsStreaming(false)'))) {
    assert.match(line, /isCurrent\(\)/, line.trim());
  }
  assert.match(send, /if \(!isCurrent\(\)\) \{\s*aiApi\.deleteConversation\(created\.id\)[\s\S]*?return;\s*\}\s*setConversationId\(created\.id\)/);
  assert.match(send, /if \(!isCurrent\(\)\) return;\s*const controller = new AbortController\(\);/, 'a superseded turn never starts its stream');
  const load = source.slice(source.indexOf('const loadConversation'), source.indexOf('const sendMessage'));
  assert.match(load, /await aiApi\.getConversation\(id\);\s*if \(!isCurrent\(\)\) return;/);
});
