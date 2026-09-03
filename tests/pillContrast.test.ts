import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ratioOf, THEMES, type Theme } from './helpers/palette';

const PILL = join(__dirname, '..', 'client', 'src', 'components', 'balance', 'CategoryPill.tsx');

/**
 * The most repeated element in the app, and the tightest text figure in the palette.
 *
 * `CategoryPill` renders on every categorized ledger row. Nothing asserted its contrast, and the
 * categorized variant clears the 4.5:1 AA text floor at **4.91 on light and 6.45 on dark**.
 * It measured 4.52 / 4.53 before the Jade & Ink repalette, i.e. inside the rounding of any token
 * nudge, on the element that appears more times per screen than any other. The margin is healthier
 * now and the pin stays, because what made it worth pinning was the call-site count, not the
 * particular figure.
 *
 * Found by driving the running app rather than by reading: a browser sweep for borders under 3:1
 * flagged 44 of these on the dark ledger. The border turned out to be fine (see below) and the text
 * margin, which the sweep was not looking for, turned out to be the real finding.
 *
 * The Tailwind names and the CSS variable names differ here and the mapping is not guessable:
 * `text-sage-text` reads `--mz-pill-text-c`, `bg-pill-bg` reads `--mz-pill-muted-bg-c`, and
 * `border-pill-border` reads `--mz-pill-muted-border-c` (`tailwind.config.js:56,66-67`). Measuring
 * the variable named after the utility silently measures a token that does not exist.
 */
const VARIANTS = [
  { name: 'categorized', text: 'pill-text', fill: 'sage-tint', border: 'sage-tint-border' },
  { name: 'uncategorized', text: 'muted-2', fill: 'pill-muted-bg', border: 'pill-muted-border' },
] as const;

test('both pill variants clear the AA text floor in both themes', () => {
  for (const v of VARIANTS) {
    for (const theme of THEMES) {
      const r = ratioOf(v.text, v.fill, theme);
      assert.ok(
        r >= 4.5,
        `the ${v.name} pill's text is ${r.toFixed(2)}:1 on ${theme}; AA for text is 4.5`
      );
    }
  }
});

test('the categorized pill is the tighter one, and how tight is stated', () => {
  // Pinned as a figure rather than a floor, so a change that erodes the margin fails here and is
  // read, instead of passing until it crosses 4.5 and fails somewhere else.
  const light = ratioOf('pill-text', 'sage-tint', 'light');
  const dark = ratioOf('pill-text', 'sage-tint', 'dark');
  assert.ok(light >= 4.5 && light < 5.2, `categorized pill text on light is ${light.toFixed(2)}, was 4.91`);
  assert.ok(dark >= 4.5, `categorized pill text on dark is ${dark.toFixed(2)}`);
  assert.ok(light < dark, 'light is no longer the tighter of the two, so this test names the wrong one');
  // And the other variant is genuinely comfortable, so the tightness is specific and not a palette
  // wide problem someone might "fix" by moving a shared token.
  assert.ok(ratioOf('muted-2', 'pill-muted-bg', 'light') > 5, 'the uncategorized pill got tight too');
});

test('the pill border is deliberately quiet, and is not a rule that must clear 3:1', () => {
  // A future reader running a 3:1 sweep will find these (1.30 and 1.73 categorized, 1.53 and 1.98
  // uncategorized) and reach for a darker token. They should not. WCAG 1.4.11 covers visual
  // information REQUIRED to identify a component; the pill is identified by its fill against the
  // row and by its own text, both of which clear, so the border is reinforcement. Darkening it
  // would turn a quiet chip into a boxed one on every ledger row, which is the crowding failure
  // `graphicRestraint.test.ts` exists to prevent.
  for (const v of VARIANTS) {
    for (const theme of THEMES) {
      const r = ratioOf(v.border, v.fill, theme);
      assert.ok(r < 3, `the ${v.name} pill border is ${r.toFixed(2)}:1 on ${theme}; it is meant to be quiet`);
    }
  }
});

test('the component still uses the tokens these figures were measured from', () => {
  // Every figure above is a property of four token pairs. If the component stops painting with
  // them, the assertions keep passing and stop meaning anything.
  const src = readFileSync(PILL, 'utf8');
  for (const cls of [
    'border-sage-tint-border', 'bg-sage-tint', 'text-sage-text',
    'border-pill-border', 'bg-pill-bg', 'text-muted-2',
  ]) {
    assert.ok(src.includes(cls), `CategoryPill no longer uses ${cls}; re-derive this file`);
  }
});
