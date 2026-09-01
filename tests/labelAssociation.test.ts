import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const CLIENT = join(__dirname, '..', 'client', 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.tsx')) out.push(p);
  }
  return out;
}

/**
 * Every label names its control.
 *
 * Part III measured `htmlFor` at 0 across 40 `<label>` elements and scheduled the fix for Phase 14,
 * after the graphic layer, on the argument that a later mark vocabulary would be the natural
 * source of text alternatives. The graphic layer never landed and the count grew to 42 of 43. A
 * label that is not associated with its control is not a label to a screen reader, and that does
 * not depend on any mark vocabulary, so this half of Phase 14 was done on 2026-09-01.
 *
 * Two shapes associate: `htmlFor` pointing at an `id`, or wrapping the control. Both are accepted.
 */
const CONTROL = /<(input|select|textarea)\b/;

test('every <label> either carries htmlFor or wraps its control', () => {
  const bare: string[] = [];
  for (const file of walk(CLIENT)) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/g)) {
      if (/\bhtmlFor=/.test(m[1])) continue;
      if (CONTROL.test(m[2])) continue;
      bare.push(`${file.replace(CLIENT, 'client/src')}: ${m[2].replace(/\s+/g, ' ').trim().slice(0, 40)}`);
    }
  }
  assert.deepEqual(bare, [], `labels associated with nothing:\n  ${bare.join('\n  ')}`);
});

test('every htmlFor names an id that exists in the same file', () => {
  const dangling: string[] = [];
  for (const file of walk(CLIENT)) {
    const src = readFileSync(file, 'utf8');
    const ids = new Set([...src.matchAll(/\bid="([\w-]+)"/g)].map((m) => m[1]));
    for (const m of src.matchAll(/\bhtmlFor="([\w-]+)"/g)) {
      if (!ids.has(m[1])) dangling.push(`${file.replace(CLIENT, 'client/src')}: htmlFor="${m[1]}"`);
    }
  }
  assert.deepEqual(dangling, [], `htmlFor pointing at no id:\n  ${dangling.join('\n  ')}`);
});

test('the sync line announces its own changes', () => {
  const rail = readFileSync(join(CLIENT, 'components', 'NavRail.tsx'), 'utf8');
  // It is the one element on every screen that changes without the owner acting.
  const button = rail.slice(rail.indexOf('{syncLabel}') - 900, rail.indexOf('{syncLabel}'));
  assert.match(button, /aria-live="polite"/, 'a sync finishing or failing is not announced');
});
