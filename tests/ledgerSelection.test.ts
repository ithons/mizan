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

test('the Scheduled tab shows nothing it cannot back while the forecast loads or fails', () => {
  assert.match(source, /view === 'scheduled' && forecastQ\.isPending && <SkeletonRows/);
  assert.match(source, /forecastQ\.data !== undefined \? \(\s*<>\s*<span className="tabular-nums">\{occurrences/);
});

test('an Entries page whose only rows are hidden trades says so instead of claiming nothing matches', () => {
  assert.match(
    source,
    /folded\.hiddenTrades > 0\s*\?\s*hasNextPage\s*\?\s*'Every entry loaded so far is a brokerage trade, which is hidden\. More entries are below\.'\s*:\s*'Every entry here is a brokerage trade, which is hidden\.'/,
    'the all-trades claim is made only once nothing is left to load'
  );
});

test('the recurring candidates stay actionable when the forecast fails, and cached forecast data stays shown', () => {
  assert.match(source, /view === 'scheduled' && !forecastQ\.isPending && unscheduledCandidates\.length > 0 && \(/);
  assert.match(source, /view === 'scheduled' && forecastQ\.data !== undefined && \(/);
  assert.doesNotMatch(source, /forecastQ\.isSuccess/);
});
