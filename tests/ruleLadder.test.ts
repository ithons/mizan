import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ratioOf, THEMES, type Theme } from './helpers/palette';

const ROOT = join(__dirname, '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

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
/**
 * The grounds the app actually paints, read out of the source rather than listed here.
 *
 * The first version of this file hand-listed six, and the list was wrong in both directions. It
 * carried `card-white`, which has ZERO `bg-card-white` call sites in `client/src` and which
 * `Card.tsx:63` already describes as "not a rung: on light it is the same pure white as `paper`",
 * so the ladder was being judged against a surface nothing renders. And it omitted `track`, which
 * 12 call sites paint (`ProgressBar`, `SkeletonLoader`) and which is the darkest ground in the
 * app. Deriving the list means it cannot drift from what ships again.
 */
function paintedGrounds(): string[] {
  const found = new Set<string>();
  for (const file of walk(join(ROOT, 'client', 'src'))) {
    for (const m of readFileSync(file, 'utf8').matchAll(/\bbg-(paper|card|card-alt|card-white|rail|well|track)\b/g)) {
      found.add(m[1]);
    }
  }
  return [...found].sort();
}

const GROUNDS = paintedGrounds();

function minAcross(token: string): number {
  return Math.min(...THEMES.flatMap((t: Theme) => GROUNDS.map((g) => ratioOf(token, g, t))));
}

test('the ground set is derived from what the app paints, and card-white is not one', () => {
  // Asserted rather than assumed, because every ratio below is a minimum over this list. If the
  // list silently loses a ground, every "clears on every ground" claim in this file weakens
  // without any of them failing.
  assert.ok(GROUNDS.includes('track'), 'track is painted 12 times and must be judged');
  assert.ok(GROUNDS.includes('rail') && GROUNDS.includes('well') && GROUNDS.includes('paper'));
  assert.ok(
    !GROUNDS.includes('card-white'),
    'card-white grew a call site; it is now a real ground and the ladder below must be re-derived'
  );
  assert.ok(GROUNDS.length >= 5, `only ${GROUNDS.length} grounds found; the walk is not reaching the source`);
});

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
  // The floor is 9, not 10. 10 was tuned to a ground set that omitted `track`, the darkest ground
  // in the app; against it `ink-soft` measures 9.81 light. Still four times the non-text floor and
  // twice the text floor, so the rule holds and the number was the artefact.
  assert.ok(minAcross('ink-soft') >= 9, `ink-soft bottoms out at ${minAcross('ink-soft').toFixed(2)}`);
});

test('line-2 is NOT a token that clears the floor everywhere, whatever the plan says', () => {
  // The specific claim being refuted, kept as a test so it cannot be re-asserted in prose.
  const failures = THEMES.flatMap((theme: Theme) =>
    GROUNDS.filter((g) => ratioOf('line-2', g, theme) < 3).map((g) => `${g}/${theme} ${ratioOf('line-2', g, theme).toFixed(2)}`)
  );
  assert.deepEqual(
    failures.sort(),
    ['rail/light 2.92', 'track/dark 2.44', 'track/light 2.39', 'well/light 2.84'],
    'the grounds line-2 cannot carry a structural rule on have changed; re-derive the ladder'
  );
});

test('exactly one rule token clears the floor on every painted ground, and faint is not it', () => {
  // This test used to say "exactly two", and that was an artefact of the wrong ground set. Against
  // the grounds the app actually paints, `faint` measures 2.91 on `track` in light and misses. Only
  // `line-3` clears everywhere.
  const clears = ['line', 'line-2', 'line-3', 'faint'].filter((t) => minAcross(t) >= 3);
  assert.deepEqual(clears, ['line-3'], 'the set of tokens that can be a structural rung anywhere moved');

  // `faint` is still the right rung for chrome, and the reason is a pairing rather than a minimum.
  // A boundary should be as loud as it must be and no louder; `line-3` is spoken for by e3 (the
  // elevation that carries money) and by the closing double rule, so chrome using it would read at
  // the weight of a dialog. `faint` clears every ground it is DRAWN on, which is the claim that
  // matters and which the next test enforces directly.
  for (const ground of ['rail', 'paper'] as const) {
    for (const theme of THEMES) {
      assert.ok(ratioOf('faint', ground, theme) >= 3, `faint on ${ground}/${theme} stopped clearing`);
    }
  }
  assert.ok(ratioOf('faint', 'track', 'light') < 3, 'faint now clears track; the carve-out below is stale');
});

test('no rule token is drawn on a ground it cannot clear', () => {
  // The claim that actually protects the reader, and the one a minimum-across-grounds test cannot
  // make. `faint` fails only on `track`; `line-2` fails on `track`, `rail` and `well`. So the
  // question is not what a token clears everywhere, it is whether any element pairs a token with a
  // ground it misses. Judged per JSX element, the way graphicRestraint.test.ts judges textures.
  // Derived, not typed. A hand-written table of which token misses which ground is a second copy
  // of what `ratioOf` already computes, and CLAUDE.md's rule about the fifth copy applies to a
  // contrast table exactly as it does to a list of action kinds: the enforcement and the statement
  // have to be one thing or they drift.
  //
  // `line` is excluded by name and only by name. It misses on every ground by design, and the two
  // tests above pin that as the point of the quiet rung, so including it here would report the
  // whole app as broken.
  const CANNOT: Record<string, string[]> = Object.fromEntries(
    ['line-2', 'line-3', 'faint'].map((rule) => [
      rule,
      GROUNDS.filter((g) => THEMES.some((t: Theme) => ratioOf(rule, g, t) < 3)),
    ])
  );
  assert.deepEqual(
    CANNOT,
    { 'line-2': ['rail', 'track', 'well'], 'line-3': [], faint: ['track'] },
    'the ladder moved; this test now guards a different set of pairings than it was written for'
  );
  const offenders: string[] = [];
  for (const file of walk(join(ROOT, 'client', 'src'))) {
    const src = readFileSync(file, 'utf8');
    for (const tag of src.matchAll(/<[A-Za-z][^>]*>/g)) {
      for (const [rule, grounds] of Object.entries(CANNOT)) {
        if (!new RegExp(`\\b(?:border|divide|ring)(?:-[trblxy])?-${rule}\\b`).test(tag[0])) continue;
        for (const ground of grounds) {
          // The RESTING ground only. A `hover:bg-well` is a transient state whose border is still
          // being judged against the surface the element rests on, and treating it as the ground
          // flagged the Retry button in `QueryState`, whose border is fine at rest.
          if (!new RegExp(`(^|[\\s"'])bg-${ground}\\b`).test(tag[0])) continue;
          const line = src.slice(0, tag.index).split('\n').length;
          offenders.push(`${file.replace(ROOT, '')}:${line} draws ${rule} on ${ground}`);
        }
      }
    }
  }
  assert.deepEqual(offenders, [], 'a structural rule is drawn on a ground it cannot clear 3:1 against');
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
