import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { THEMES, contrast, triplet } from './helpers/palette';

/**
 * The "?" explanations render wherever a section label sits: on paper, on a card, inside an
 * elevated card and on a well. Their text tones are measured on every one of those grounds.
 */
const SOURCE = readFileSync(join(import.meta.dirname, '..', 'client/src/components/balance/Disclosure.tsx'), 'utf8');
const GROUNDS = ['paper', 'card', 'card-alt', 'well'];
const AA_TEXT = 4.5;
const NON_TEXT = 3;

test('every text tone in the explanations clears AA on every ground they sit on', () => {
  const tones = [...new Set([...SOURCE.matchAll(/\btext-(ink|muted-2|muted)\b/g)].map((m) => m[1]))];
  assert.deepEqual(tones.sort(), ['ink', 'muted', 'muted-2']);
  for (const tone of tones) {
    for (const ground of GROUNDS) {
      for (const theme of THEMES) {
        const ratio = contrast(triplet(tone, theme), triplet(ground, theme));
        assert.ok(ratio >= AA_TEXT, `${tone} on ${ground} (${theme}) is ${ratio.toFixed(2)}:1`);
      }
    }
  }
});

test('the "?" ring is visible on every ground as a control', () => {
  assert.match(SOURCE, /border-line-3/);
  for (const ground of GROUNDS) {
    for (const theme of THEMES) {
      const ratio = contrast(triplet('line-3', theme), triplet(ground, theme));
      assert.ok(ratio >= NON_TEXT, `line-3 on ${ground} (${theme}) is ${ratio.toFixed(2)}:1`);
    }
  }
});
