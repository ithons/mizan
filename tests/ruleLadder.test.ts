import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ratioOf, THEMES, type Theme } from './helpers/palette';

const ROOT = join(__dirname, '..');

/**
 * What each rule weight can actually carry, on the palette that shipped.
 *
 * `.claude/plans/rebuild-part-3.md` Phase 13 move 1 declares a four-weight ladder and names
 * `border-line-2` as "the structural rung (section boundary, clears 3:1)". That is not true of the
 * palette in `index.css`. Phase 13 was written against a candidate palette called "Bone and
 * Signal"; commit 4a2db38 shipped pure black and white instead, and every contrast figure in that
 * section is a measurement of a palette that was never built. This file re-derives the ladder from
 * the triplets that did ship and pins the result, so the next reader who reaches for "the rung that
 * clears 3:1" finds out from a failing test rather than from a sentence.
 *
 * 3:1 is the non-text floor (WCAG 1.4.11). A 1px rule between two grounds is seen against both, so
 * a boundary is judged against the ground it sits ON as well as the one it separates from.
 */
const GROUNDS = ['paper', 'card', 'card-alt', 'card-white', 'rail', 'well'] as const;

function minAcross(token: string): number {
  return Math.min(...THEMES.flatMap((t: Theme) => GROUNDS.map((g) => ratioOf(token, g, t))));
}

test('the quiet rung is below the floor on every ground, deliberately', () => {
  // `line` marks an item boundary inside a list. It is meant to be unable to shout, and a future
  // reader "fixing" it to clear 3:1 would turn every list into a grid.
  for (const theme of THEMES) {
    for (const ground of GROUNDS) {
      const r = ratioOf('line', ground, theme);
      assert.ok(r < 3, `line on ${ground}/${theme} is ${r.toFixed(2)}; the quiet rung must stay quiet`);
    }
  }
});

test('the datum rung is unmistakable on every ground', () => {
  // `ink-soft` is the one full-width rule on a sheet: the Ledger's today rule. It separates what is
  // expected from what happened, so it may not be subtle anywhere.
  assert.ok(minAcross('ink-soft') >= 10, `ink-soft bottoms out at ${minAcross('ink-soft').toFixed(2)}`);
});

test('line-2 is NOT a token that clears the floor everywhere, whatever the plan says', () => {
  // The specific claim being refuted, kept as a test so it cannot be re-asserted in prose.
  const failures = THEMES.flatMap((theme: Theme) =>
    GROUNDS.filter((g) => ratioOf('line-2', g, theme) < 3).map((g) => `${g}/${theme} ${ratioOf('line-2', g, theme).toFixed(2)}`)
  );
  assert.deepEqual(
    failures.sort(),
    ['card-white/dark 2.72', 'rail/light 2.92', 'well/light 2.84'],
    'the grounds line-2 cannot carry a structural rule on have changed; re-derive the ladder'
  );
});

test('exactly two rule tokens clear the floor on every ground, and faint is the quieter', () => {
  const clears = ['line', 'line-2', 'line-3', 'faint'].filter((t) => minAcross(t) >= 3);
  assert.deepEqual(clears, ['line-3', 'faint'], 'the set of tokens that can be a structural rung moved');
  // The quietest token that clears is the honest structural rung: a boundary should be as loud as
  // it must be and no louder. `line-3` is spoken for by e3 (the elevation that carries money) and
  // by the closing double rule, so chrome using it would read at the weight of a dialog.
  assert.ok(
    minAcross('faint') < minAcross('line-3'),
    'faint is no longer the quieter of the two tokens that clear'
  );
});

/**
 * The one boundary in the app between chrome and money.
 *
 * Phase 13 move 2 called this "the most important boundary in the app" and measured it at "1.10:1
 * in the current light theme". Measured in a browser off the rendered element it was 2.92:1 against
 * the rail it sits on (borderLeftColor rgb(145,145,145) on backgroundColor rgb(246,246,246)) and
 * 3.15:1 against the page. It cleared on one side and missed on the other.
 */
test('the rail boundary clears the floor on both sides, in both themes', () => {
  const rail = readFileSync(join(ROOT, 'client/src/components/NavRail.tsx'), 'utf8');
  const nav = rail.slice(rail.indexOf('aria-label="Primary"'));
  const cls = nav.slice(0, nav.indexOf('>'));
  const token = cls.match(/border-l\s+border-([\w-]+)/)?.[1];
  assert.ok(token, 'the rail no longer declares its left boundary where this test looks');

  for (const theme of THEMES) {
    for (const ground of ['rail', 'paper'] as const) {
      const r = ratioOf(token, ground, theme);
      assert.ok(
        r >= 3,
        `the rail boundary (${token}) is ${r.toFixed(2)}:1 against ${ground} in ${theme}; a rule ` +
          'between two grounds is seen against both'
      );
    }
  }
});

test('chrome does not borrow the weight the highest elevation uses', () => {
  const rail = readFileSync(join(ROOT, 'client/src/components/NavRail.tsx'), 'utf8');
  const nav = rail.slice(rail.indexOf('aria-label="Primary"'));
  const token = nav.slice(0, nav.indexOf('>')).match(/border-l\s+border-([\w-]+)/)?.[1];
  const card = readFileSync(join(ROOT, 'client/src/components/balance/Card.tsx'), 'utf8');
  // Card.tsx's `elevations` map gives e3 its border. Whatever that token is, the rail must not
  // share it: chrome against money is not the same statement as a dialog that carries money.
  const e3 = card.match(/^\s*3:\s*'[^']*border-([\w-]+)/m)?.[1];
  assert.ok(e3, "Card.tsx no longer declares e3's border where this test looks");
  assert.notEqual(token, e3, 'the rail boundary now reads at the weight of the e3 elevation');
});
