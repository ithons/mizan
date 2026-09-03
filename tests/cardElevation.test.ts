import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Card, type Elevation } from '../client/src/components/balance/Card';

/**
 * The elevation ladder, as documented against as shipped.
 *
 * The docstring on `Card` described a ladder in which e1 borders `line` on dark and `line-2` on
 * light, and e2 borders `line-2` on dark and `line-3` on light. `className` is one string for both
 * themes, so no arrangement of the three classes below it could produce that, and none ever did:
 * e1 and e2 both border `line-2`. It then said both halves of every rung run away from their own
 * ground. On a pure white page they cannot: `paper` and `card` are the same triplet, so the
 * surface half of the ladder is nominal and the border half carries all of it.
 *
 * Every figure in that docstring is re-derived here from `client/src/index.css`, and the token each
 * step actually uses is read out of the rendered class list, so the two cannot drift apart again.
 */

const ROOT = join(import.meta.dirname, '..');
const CSS = readFileSync(join(ROOT, 'client/src/index.css'), 'utf8');
const SOURCE = readFileSync(join(ROOT, 'client/src/components/balance/Card.tsx'), 'utf8');

type Theme = 'light' | 'dark';

function triplet(name: string, theme: Theme): [number, number, number] {
  const all = [...CSS.matchAll(new RegExp(`--mz-${name}-c:\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)\\s*;`, 'g'))];
  assert.ok(all.length > 0, `--mz-${name}-c is not declared in index.css`);
  const m = theme === 'light' ? all[0] : all[all.length - 1];
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function luminance([r, g, b]: [number, number, number]): number {
  const ch = (c: number) => (c / 255 <= 0.03928 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

/** CIE L*, which is the axis the ladder is written in. */
function lstar(name: string, theme: Theme): number {
  const y = luminance(triplet(name, theme));
  return Number((y <= 216 / 24389 ? (y * 24389) / 27 : Math.cbrt(y) * 116 - 16).toFixed(1));
}

function ratio(fg: string, bg: string, theme: Theme): number {
  const [a, b] = [luminance(triplet(fg, theme)), luminance(triplet(bg, theme))];
  return Number(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toFixed(2));
}

/** The surface and border token each step actually renders with. */
function step(elevation: Elevation): { surface: string; border: string } {
  // `children` goes in the props object, not the variadic third argument: `Card` declares it
  // required, and the variadic form is not folded into the component's own prop type.
  const markup = renderToStaticMarkup(createElement(Card, { elevation, children: 'x' }));
  const classes = (markup.match(/class="([^"]*)"/)?.[1] ?? '').split(/\s+/);
  const surface = classes.find((c) => c.startsWith('bg-'))?.slice(3);
  const border = classes.find((c) => /^border-[a-z]/.test(c))?.slice(7);
  assert.ok(surface, `e${elevation} renders no surface`);
  assert.ok(border, `e${elevation} renders no border`);
  return { surface, border };
}

test('the ladder that ships is surface then border, not both at once', () => {
  assert.deepEqual(step(1), { surface: 'card', border: 'line-2' });
  assert.deepEqual(step(2), { surface: 'card-alt', border: 'line-2' });
  assert.deepEqual(step(3), { surface: 'card-alt', border: 'line-3' });

  // e1 to e2 holds the border and steps the surface; e2 to e3 holds the surface and steps the
  // border. That is the alternation the docstring now describes.
  assert.equal(step(1).border, step(2).border);
  assert.notEqual(step(1).surface, step(2).surface);
  assert.equal(step(2).surface, step(3).surface);
  assert.notEqual(step(2).border, step(3).border);
});

test('every L* and ratio in the docstring reproduces from the palette, for the token the step really uses', () => {
  const rows: Array<[Elevation, Theme, number, number, number]> = [
    // step  theme     surface L*  border L*  border on that surface
    [1, 'light', 100.0, 59.4, 3.23],
    [2, 'light', 99.1, 59.4, 3.16],
    [3, 'light', 99.1, 48.0, 4.71],
    [1, 'dark', 12.4, 47.6, 3.32],
    [2, 'dark', 15.7, 47.6, 3.05],
    [3, 'dark', 15.7, 56.9, 4.25],
  ];
  for (const [elevation, theme, surface, border, edge] of rows) {
    const { surface: s, border: b } = step(elevation);
    assert.equal(lstar(s, theme), surface, `e${elevation} surface, ${theme}`);
    assert.equal(lstar(b, theme), border, `e${elevation} border, ${theme}`);
    assert.equal(ratio(b, s, theme), edge, `e${elevation} border on surface, ${theme}`);
    // The whole row, in the order the table prints it, so a figure cannot be moved onto the wrong
    // rung and still match.
    assert.match(
      SOURCE,
      new RegExp(`${s} ${surface.toFixed(1)} · ${b} ${border.toFixed(1)}\\s+${edge.toFixed(2)}:1`),
      `e${elevation} ${theme} row is not stated as measured`
    );
  }
  assert.equal(lstar('paper', 'light'), 98.1);
  assert.equal(lstar('paper', 'dark'), 8.0);
  assert.match(SOURCE, /light \(paper L\* 98\.1\)/);
  assert.match(SOURCE, /dark \(paper L\* 8\.0\)/);
});

test('the two step sizes the docstring names are the two the tokens produce', () => {
  const surfaceStep = (theme: Theme) =>
    Number((lstar(step(2).surface, theme) - lstar(step(1).surface, theme)).toFixed(1));
  const borderStep = (theme: Theme) =>
    Number((lstar(step(3).border, theme) - lstar(step(2).border, theme)).toFixed(1));

  assert.equal(surfaceStep('light'), -0.9);
  assert.equal(surfaceStep('dark'), 3.3);
  assert.equal(borderStep('light'), -11.4);
  assert.equal(borderStep('dark'), 9.3);
  assert.match(SOURCE, /-0\.9 L\*\n \* light, \+3\.3 L\* dark/);
  assert.match(SOURCE, /-11\.4 L\* light, \+9\.3 L\* dark/);
});

test('the border carries every rung and the surface step does not, in both themes', () => {
  // The property that replaced "both halves run away from the ground", which a pure white page
  // cannot have. Each rung is legible because its border clears the 3:1 non-text floor against
  // its OWN surface, and each border runs away from its own surface in whichever direction that
  // theme leaves open.
  for (const elevation of [1, 2, 3] as const) {
    const { surface, border } = step(elevation);
    assert.ok(ratio(border, surface, 'light') >= 3, `e${elevation} border is under 3:1 on light`);
    assert.ok(ratio(border, surface, 'dark') >= 3, `e${elevation} border is under 3:1 on dark`);
    assert.ok(lstar(border, 'light') < lstar(surface, 'light'), `e${elevation} border does not darken on light`);
    assert.ok(lstar(border, 'dark') > lstar(surface, 'dark'), `e${elevation} border does not lighten on dark`);
  }

  // The surface half is nominal, and the docstring says so rather than claiming a rung it does not
  // deliver. On light it is backwards as well as small: card-alt sits below card, and card itself
  // is the page's own triplet.
  assert.equal(ratio(step(2).surface, step(1).surface, 'light'), 1.02);
  assert.equal(ratio(step(2).surface, step(1).surface, 'dark'), 1.09);
  assert.equal(ratio(step(1).surface, 'paper', 'light'), 1.05);
  assert.ok(lstar(step(2).surface, 'light') < lstar(step(1).surface, 'light'));
  assert.match(SOURCE, /1\.02:1 light and 1\.09:1 dark/);
  assert.match(SOURCE, /`card` on `paper` measures 1\.05:1/);
});

test('e3 stops raising the surface, and the AA reason it used to give is gone', () => {
  // The recorded reason was that card-white on dark broke AA for a dialog's own text. It does not
  // any more, so the docstring may not keep saying it does.
  assert.equal(lstar('card-white', 'dark'), 19.5);
  assert.equal(ratio('clay', 'card-white', 'dark'), 6.17);
  assert.equal(ratio('muted-2', 'card-white', 'dark'), 5.27);
  assert.ok(ratio('clay', 'card-white', 'dark') >= 4.5 && ratio('muted-2', 'card-white', 'dark') >= 4.5);
  assert.match(SOURCE, /`card-white` is L\* 19\.5 on dark now\n \* and those two measure 6\.17:1 and 5\.27:1/);

  // The reason that replaces it: card-white is not a rung. On light it is the page's own triplet.
  // card-white matches `card`, not `paper`: the Jade & Ink page is L* 98.1 and cards are pure
  // white, so the two are no longer one triplet and the old identity would assert a lie.
  assert.equal(lstar('card-white', 'light'), lstar('card', 'light'));
  assert.equal(ratio('card-white', 'paper', 'light'), 1.05);
  assert.equal(ratio('card-white', step(3).surface, 'light'), 1.02);
  assert.equal(ratio('card-white', step(3).surface, 'dark'), 1.12);
  assert.ok(!step(3).surface.includes('white'), 'e3 raised onto card-white');
  assert.match(SOURCE, /L\* 100\.0, 1\.00:1 against it and 1\.05:1 against `paper`/);
  assert.match(SOURCE, /on dark it would buy 1\.12:1/);
});

test('the NEUTRAL LADDER block in index.css is the ladder the triplets under it produce', () => {
  // index.css states the same L* axis in prose. It is the file the numbers come from, which is
  // exactly why nothing re-derived them and they went stale with the palette.
  const heading = 'NEUTRAL LADDER (CIE L*, ascending)';
  assert.ok(CSS.includes(heading), `index.css no longer carries a section headed "${heading}"`);
  const block = CSS.slice(CSS.indexOf(heading));
  const rows: Record<Theme, string> = {
    light: block.slice(block.indexOf('light'), block.indexOf('dark')),
    dark: block.slice(block.indexOf('dark'), block.indexOf('\n *\n')),
  };
  const NEUTRALS = ['line-3', 'line-2', 'track', 'line', 'well', 'rail', 'card-alt', 'card-white', 'card', 'paper'];

  for (const theme of ['light', 'dark'] as const) {
    const stated = [...rows[theme].matchAll(/([A-Za-z][A-Za-z0-9-]*) (\d+\.\d)\b/g)].map(
      ([, name, value]) => [name.toLowerCase(), Number(value)] as const
    );
    assert.deepEqual(
      stated.map(([name]) => name).sort(),
      [...NEUTRALS].sort(),
      `the ${theme} row does not list every neutral exactly once`
    );
    for (const [name, value] of stated) {
      assert.equal(lstar(name, theme), value, `${name} on ${theme} is stated as ${value}`);
    }
    for (let i = 1; i < stated.length; i += 1) {
      assert.ok(stated[i][1] >= stated[i - 1][1], `the ${theme} row is not ascending at ${stated[i][0]}`);
    }
  }

  // The claim the block makes about those numbers: on light the four surfaces are one value, and
  // the hover wash inverts by theme.
  // card-white matches `card`, not `paper`: the Jade & Ink page is L* 98.1 and cards are pure
  // white, so the two are no longer one triplet and the old identity would assert a lie.
  assert.equal(lstar('card-white', 'light'), lstar('card', 'light'));
  assert.equal(Number((lstar('card-alt', 'light') - lstar('paper', 'light')).toFixed(1)), 1.0);
  assert.equal(Number((lstar('card-white', 'dark') - lstar('paper', 'dark')).toFixed(1)), 11.5);
  assert.equal(Number((lstar('well', 'light') - lstar('card', 'light')).toFixed(1)), -5.3);
  assert.equal(Number((lstar('well', 'dark') - lstar('card', 'dark')).toFixed(1)), 4.7);
  assert.match(CSS, /fit inside 1\.9 points/);
  assert.match(CSS, /fit inside 7\.1 points and `card` on `paper` is 1\.10:1/);
  assert.match(CSS, /card \(-5\.3 L\*\) and rises off a dark one \(\+4\.7 L\*\)/);
  assert.equal(ratio('card', 'paper', 'light'), 1.05);
  assert.equal(ratio('card', 'paper', 'dark'), 1.1);
});

test('the docstring no longer claims either ladder the tokens cannot express', () => {
  // The exact shape of the old claim: e1 bordering `line`, and e2 bordering `line-3`.
  assert.ok(!/e1\s+card 96\.0\s+· line-2 76\.8\s+card 19\.3\s+· line 27\.9/.test(SOURCE));
  assert.ok(!/e2\s+card-alt 98\.6 · line-3 72\.8/.test(SOURCE));
  // And the claim the pure white page falsified: that the surface half of every rung runs away
  // from the ground. It does not, and it may not be asserted in the present tense anywhere.
  assert.ok(!/run AWAY from their own ground/.test(SOURCE));
  assert.ok(!/`card-white` is the next rung and on the dark theme it/.test(SOURCE));
});
