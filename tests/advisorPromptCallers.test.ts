import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const CLIENT = join(ROOT, 'client', 'src');
const SELF = join(CLIENT, 'lib', 'advisorPrompts.ts');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

/**
 * Every prompt builder has a screen that asks it.
 *
 * `advisorPrompts.ts` was 824 lines and 16 builders, and 14 of them had no production caller: the
 * screens they wrote questions for (Reports, the Dashboard cards, per-row "ask the advisor" on
 * budgets, goals, holdings, transactions and accounts) were deleted in the 12-to-6 consolidation,
 * and nobody walked the builders afterwards. Their tests kept passing, which is how 700 lines of
 * prose about screens that did not exist stayed green for a month. This repo's own rule is that a
 * fetcher with no caller is a dropped capability rather than dead code, and it asks for a decision
 * per builder. The decision here was to delete: Cmd+K is the one conversational surface and it
 * builds its context server-side (`buildFinancialContext`), so a client-side builder that
 * pre-writes a question about a screen is only worth keeping while that screen exists.
 *
 * This is the guard that stops it regrowing. A builder added here without a caller fails.
 */
test('every exported prompt builder is called from a screen', () => {
  const src = readFileSync(SELF, 'utf8');
  const builders = [...src.matchAll(/^export function (build\w*AdvisorPrompt)\b/gm)].map((m) => m[1]);
  assert.ok(builders.length > 0, 'no builders found; the regex or the file moved');

  const others = walk(CLIENT).filter((p) => p !== SELF).map((p) => readFileSync(p, 'utf8')).join('\n');
  const uncalled = builders.filter((b) => !new RegExp(`\\b${b}\\b`).test(others));
  assert.deepEqual(uncalled, [], `prompt builders with no production caller: ${uncalled.join(', ')}`);
});

test('the prompt source union names only sources a live builder emits', () => {
  const src = readFileSync(SELF, 'utf8');
  const emitted = new Set([...src.matchAll(/source: '([a-z_]+)'/g)].map((m) => m[1]));
  const ask = readFileSync(join(CLIENT, 'lib', 'askAdvisor.ts'), 'utf8');
  const union = ask.match(/export type AdvisorPromptSource = ([^;]+);/)?.[1] ?? '';
  const declared = [...union.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.ok(declared.length > 0, 'AdvisorPromptSource union not found');
  const dead = declared.filter((s) => !emitted.has(s));
  assert.deepEqual(dead, [], `AdvisorPromptSource carries values nothing emits: ${dead.join(', ')}`);
});
