import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { THEMES, contrast, ratio, relativeLuminance, triplet, type Rgb, type Theme } from './helpers/palette';

/**
 * A bar has to clear 3:1 twice, and the two pull opposite ways.
 *
 * WCAG 1.4.11 wants 3:1 against the adjacent colour for anything carrying information. A progress
 * bar carries two: the fill against the track, which says what the value is, and the track against
 * the page, which says what the value is a fraction OF. The fills were solved against the track and
 * clear it; the track was never solved against anything, and on the 2026-08-01 palette it measures
 * between 1.19 and 1.55 against every ground a bar renders on, so the extent was invisible and the
 * fill read as a floating dash.
 *
 * The fix is a hairline ring rather than a darker track, and `noSolidTrackCanClearBothEdges` below
 * is the reason: pushing the track far enough from the page to be seen pushes it into the fills.
 * That test is the argument; the rest hold the ring that follows from it.
 *
 * Nothing here restates a token name typed beside a figure. The ring class is read out of
 * `ProgressBar.tsx` and every ratio is recomputed from `index.css`, so swapping the token fails
 * here instead of quietly reverting the fix.
 */

const ROOT = join(import.meta.dirname, '..');
const SOURCE = readFileSync(join(ROOT, 'client', 'src', 'components', 'balance', 'ProgressBar.tsx'), 'utf8');

/** WCAG 1.4.11 for a non-text component boundary. Not a house preference. */
const MIN_BOUNDARY = 3;

/**
 * The grounds a bar can land on.
 *
 * Deliberately a superset of the five the component note names: the four neutral surfaces plus the
 * hover wash, the rail, and the three tinted panels a bar could be dropped into later. A boundary
 * that only clears where bars happen to sit today is one the next screen breaks.
 */
const BAR_GROUNDS = [
  'paper', 'card', 'card-alt', 'card-white', 'rail', 'well',
  'pill-muted-bg', 'sage-tint', 'review-bg',
] as const;

/** Every tone `tones`, `SignedBar` and the zero rule can paint inside the track. */
const BAR_FILLS = ['sage-deep', 'gold', 'clay', 'muted', 'ink-soft'] as const;

/** The ring colour the component actually ships, spelled as its palette token. */
function ringToken(): string {
  const matches = [...SOURCE.matchAll(/\bring-((?!\d|inset|offset)[a-z0-9-]+)/g)].map((m) => m[1]);
  assert.ok(matches.length > 0, 'ProgressBar.tsx declares no ring colour: the bar has no boundary');
  const unique = [...new Set(matches)];
  assert.equal(
    unique.length,
    1,
    `ProgressBar and SignedBar must draw the same boundary; found ${unique.join(', ')}`
  );
  return unique[0];
}

test('both bars declare a boundary, and the same one', () => {
  // Two tracks in this file, and both must carry it. SignedBar is the one that needs it most: a
  // value at zero draws no fill at all, so without a boundary the row is blank.
  const tracks = [...SOURCE.matchAll(/className=\{`[^`]*\bbg-track\b[^`]*`\}/g)].map((m) => m[0]);
  assert.equal(tracks.length, 2, 'ProgressBar and SignedBar are the two tracks in this file');
  for (const track of tracks) {
    assert.match(track, /\bring-1\b/, `a track with no ring has no readable extent: ${track}`);
    assert.match(track, new RegExp(`\\bring-${ringToken()}\\b`), track);
  }
});

test('the boundary clears 3:1 on every ground a bar can land on, in both themes', () => {
  const token = ringToken();
  const failures: string[] = [];
  for (const theme of THEMES) {
    for (const ground of BAR_GROUNDS) {
      const measured = ratio(token, ground, theme);
      if (measured < MIN_BOUNDARY) failures.push(`${token} on ${ground} ${theme}: ${measured}`);
    }
  }
  assert.deepEqual(failures, [], `the ring is the bar's extent and must be visible against the page`);
});

test('the boundary also separates from the track it encloses', () => {
  // Otherwise the ring is not an edge, it is a slightly wider track, and the bar gains nothing.
  const token = ringToken();
  for (const theme of THEMES) {
    assert.ok(
      ratio(token, 'track', theme) >= MIN_BOUNDARY,
      `${token} on track ${theme} is ${ratio(token, 'track', theme)}`
    );
  }
});

test('the fills still clear the track, which is the edge the ring does not replace', () => {
  // The healthy half. The ring says how long the bar is; the fill still has to say how full it is,
  // and a change that solved the extent by darkening the track would break this instead.
  const failures: string[] = [];
  for (const theme of THEMES) {
    for (const fill of BAR_FILLS) {
      const measured = ratio(fill, 'track', theme);
      if (measured < MIN_BOUNDARY) failures.push(`${fill} on track ${theme}: ${measured}`);
    }
  }
  assert.deepEqual(failures, [], 'the value inside the bar has to stay readable');
});

/**
 * Why the palette was left alone, stated as arithmetic rather than as taste.
 *
 * Exhaustive over the 256 achromatic values. That was once the whole family `track` belongs to,
 * back when every neutral in index.css was chroma 0.000; the Jade & Ink palette gives the neutrals
 * a slight cool cast, so the scan is now a lower bound rather than a survey of the family. It is
 * still the right bound: adding chroma to a track moves it toward one fill and away from another,
 * so no tinted value beats the best achromatic one at clearing FIVE fills at once. If any candidate
 * cleared both edges, a one-line token change would be the smaller fix and this ring would be
 * unjustified.
 */
function bestSolidTrack(theme: Theme): { value: number; againstPage: number } | null {
  const page = triplet('paper', theme);
  const fills = BAR_FILLS.map((f) => triplet(f, theme));
  let best: { value: number; againstPage: number } | null = null;
  for (let v = 0; v <= 255; v += 1) {
    const candidate: Rgb = [v, v, v];
    if (!fills.every((fill) => contrast(fill, candidate) >= MIN_BOUNDARY)) continue;
    const againstPage = contrast(candidate, page);
    if (!best || againstPage > best.againstPage) best = { value: v, againstPage };
  }
  return best;
}

test('no solid track colour can clear both edges, which is why the ring exists', () => {
  for (const theme of THEMES) {
    const best = bestSolidTrack(theme);
    assert.ok(best, `${theme}: no achromatic value keeps every fill at 3:1 at all`);
    assert.ok(
      best.againstPage < MIN_BOUNDARY,
      `${theme}: rgb(${best.value}) clears both edges at ${best.againstPage.toFixed(2)}, so the ` +
        'ring is no longer the minimum fix and ProgressBar.tsx should say so'
    );
  }
});

/**
 * The two figures the component's comment states for that scan, re-derived rather than remembered.
 *
 * `tests/contrastClaims.test.ts` re-derives every token-pair ratio written under `client/src`, but
 * these two are not a pair of tokens: they name a hypothetical colour and what it would buy. So they
 * are the kind of figure that rots silently, and they are the load-bearing part of the argument for
 * the ring. They are pinned here, read out of the prose that states them.
 */
test('the figures the component states for that scan are the ones the scan produces', () => {
  const stated = new Map<Theme, { value: number; againstPage: number }>();
  for (const m of SOURCE.matchAll(
    /BEST-SOLID-TRACK (light|dark) rgb\((\d{1,3}) (\d{1,3}) (\d{1,3})\) (\d+\.\d{2}) to 1/g
  )) {
    const [r, g, b] = [Number(m[2]), Number(m[3]), Number(m[4])];
    assert.equal(r, g, 'the stated value is achromatic');
    assert.equal(g, b, 'the stated value is achromatic');
    stated.set(m[1] as Theme, { value: r, againstPage: Number(m[5]) });
  }
  assert.deepEqual([...stated.keys()].sort(), ['dark', 'light'], 'both themes are stated');

  for (const theme of THEMES) {
    const claim = stated.get(theme);
    const best = bestSolidTrack(theme);
    assert.ok(claim && best);
    assert.equal(claim.value, best.value, `${theme}: the stated best solid track value`);
    assert.equal(
      claim.againstPage,
      Number(best.againstPage.toFixed(2)),
      `${theme}: what the stated value separates from the page by`
    );
  }
});

test('track is still a track, not a second fill', () => {
  // This used to pin `track` achromatic, and the reason it gave was that the owner was deciding
  // the visual direction separately and a legibility fix must not pre-empt it. That decision has
  // been taken: the Jade & Ink palette gives every neutral a slight cool cast on purpose, so the
  // pin now guards nothing and would only block the direction it was protecting.
  //
  // What was load-bearing survives. `track` is a GROUND for the fills, and the property that makes
  // it one is that it sits nearer the page than any fill does. A track that drifted past a fill
  // would read as a second bar, and the whole boundary argument in this file would be about the
  // wrong pair. Chroma was a proxy for that; this is the thing itself.
  for (const theme of THEMES) {
    const [r, g, b] = triplet('track', theme);
    const spread = Math.max(r, g, b) - Math.min(r, g, b);
    assert.ok(spread <= 12, `track ${theme} has a channel spread of ${spread}; it is a tint, not a hue`);
  }
  // And still nearer the page than the fills are, i.e. still a track and not a second fill.
  for (const theme of THEMES) {
    const page = relativeLuminance(triplet('paper', theme));
    const track = relativeLuminance(triplet('track', theme));
    for (const fill of BAR_FILLS) {
      const f = relativeLuminance(triplet(fill, theme));
      assert.ok(
        Math.abs(track - page) < Math.abs(f - page),
        `${fill} ${theme}: track must sit between the page and every fill`
      );
    }
  }
});
