import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('Rename and Delete appear when the conversation row takes focus, so Tab can reach them', () => {
  const source = readFileSync(new URL('../client/src/views/Advisor.tsx', import.meta.url), 'utf8');
  const actions = source.match(/className="[^"]*hidden[^"]*group-hover:flex[^"]*"/)?.[0] ?? '';
  assert.match(actions, /group-focus-within:flex/);
  assert.doesNotMatch(actions, /(^|\s)focus-within:flex/);
});

test('the window chart plots the net worth timeline, the series the Accounts chart draws', () => {
  const source = readFileSync(new URL('../client/src/views/Instrument.tsx', import.meta.url), 'utf8');
  assert.match(source, /const trendPoints = \(historyQ\.data\?\.points[^;]*value: p\.net_worth/s);
});
