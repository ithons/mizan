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
 * e1 and e2 both border `line-2`. The table said the ladder stepped surface and border together at
 * every rung while the shipped one alternates.
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

  // e1 to e2 holds the border and raises the surface; e2 to e3 holds the surface and steps the
  // border. That is the alternation the docstring now describes.
  assert.equal(step(1).border, step(2).border);
  assert.notEqual(step(1).surface, step(2).surface);
  assert.equal(step(2).surface, step(3).surface);
  assert.notEqual(step(2).border, step(3).border);
});

test('every L* in the docstring reproduces from the palette, for the token the step really uses', () => {
  const rows: Array<[Elevation, Theme, number, number]> = [
    // step  theme     surface L*  border L*
    [1, 'light', 96.0, 76.8],
    [2, 'light', 98.6, 76.8],
    [3, 'light', 98.6, 72.8],
    [1, 'dark', 19.3, 33.9],
    [2, 'dark', 21.9, 33.9],
    [3, 'dark', 21.9, 40.2],
  ];
  for (const [elevation, theme, surface, border] of rows) {
    const { surface: s, border: b } = step(elevation);
    assert.equal(lstar(s, theme), surface, `e${elevation} surface, ${theme}`);
    assert.equal(lstar(b, theme), border, `e${elevation} border, ${theme}`);
    assert.match(SOURCE, new RegExp(`${s} ${surface.toFixed(1)}`), `e${elevation} ${theme} surface is not stated`);
    assert.match(SOURCE, new RegExp(`${b} ${border.toFixed(1)}`), `e${elevation} ${theme} border is not stated`);
  }
  assert.equal(lstar('paper', 'light'), 87.8);
  assert.equal(lstar('paper', 'dark'), 13.0);
  assert.match(SOURCE, /light \(paper L\* 87\.8\)/);
  assert.match(SOURCE, /dark \(paper L\* 13\.0\)/);
});

test('the two step sizes the docstring names are the two the tokens produce', () => {
  for (const theme of ['light', 'dark'] as const) {
    assert.equal(
      Number((lstar(step(2).surface, theme) - lstar(step(1).surface, theme)).toFixed(1)),
      2.6,
      `the e1 to e2 surface step is not +2.6 L* on ${theme}`
    );
  }
  assert.equal(Number((lstar(step(3).border, 'light') - lstar(step(2).border, 'light')).toFixed(1)), -4.0);
  assert.equal(Number((lstar(step(3).border, 'dark') - lstar(step(2).border, 'dark')).toFixed(1)), 6.3);
  assert.match(SOURCE, /\+2\.6 L\* in\n \* both themes/);
  assert.match(SOURCE, /-4\.0 L\* light, \+6\.3 dark/);
});

test('both halves of every step run away from their own ground, in both themes', () => {
  // The property the ladder is for: on light a surface rises and a border darkens, on dark both
  // rise, and in each theme the same word means further from the page.
  for (const elevation of [1, 2, 3] as const) {
    const { surface, border } = step(elevation);
    assert.ok(lstar(surface, 'light') > lstar('paper', 'light'), `e${elevation} surface sinks on light`);
    assert.ok(lstar(border, 'light') < lstar('paper', 'light'), `e${elevation} border rises on light`);
    assert.ok(lstar(surface, 'dark') > lstar('paper', 'dark'), `e${elevation} surface sinks on dark`);
    assert.ok(lstar(border, 'dark') > lstar('paper', 'dark'), `e${elevation} border sinks on dark`);
  }
});

test('e3 stops raising the surface for the reason it states', () => {
  // card-white is the next rung and it is where a dialog's own text stops clearing AA on dark.
  assert.equal(lstar('card-white', 'dark'), 31.3);
  assert.equal(ratio('clay', 'card-white', 'dark'), 3.41);
  assert.equal(ratio('muted-2', 'card-white', 'dark'), 3.3);
  assert.ok(!step(3).surface.includes('white'), 'e3 raised onto card-white');
  assert.match(SOURCE, /L\* 31\.3, where `clay` measures 3\.41:1 and `muted-2` 3\.30:1/);
});

test('the docstring no longer claims the ladder a single class cannot express', () => {
  // The exact shape of the old claim: e1 bordering `line`, and e2 bordering `line-3`.
  assert.ok(!/e1\s+card 96\.0\s+· line-2 76\.8\s+card 19\.3\s+· line 27\.9/.test(SOURCE));
  assert.ok(!/e2\s+card-alt 98\.6 · line-3 72\.8/.test(SOURCE));
});
