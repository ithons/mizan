import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../client/src/views/Ledger.tsx', import.meta.url), 'utf8');

test('hiding brokerage trades drops the selection, so a bulk write cannot reach rows off screen', () => {
  assert.match(source, /onClick=\{\(\) => \{ setShowTrades\(\(shown\) => !shown\); setSelectedIds\(new Set\(\)\); \}\}/);
});

test('switching between Entries and Scheduled drops the selection', () => {
  assert.match(source, /setSelectedIds\(new Set\(\)\);\s*\}, \[[^\]]*\bview\]\);/);
});
