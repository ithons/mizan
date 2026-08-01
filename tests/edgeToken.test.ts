import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The elevation edge, and the money numerals, checked against the shipped token file rather than
 * against a number somebody typed into a comment.
 *
 * `shadow-e1|e2|e3` compose as `var(--mz-edge), var(--mz-e*)`, so `--mz-edge` lands on every raised
 * surface AND on `InkButton`, which is `bg-ink shadow-e1`. A lit white edge is the mechanism that
 * separates a raised object from a dark ground; on a light ground it is invisible on the surfaces
 * it was meant for and a hard value band across the top of the one near-black control.
 *
 * The grounds it lands on are read out of `client/src` rather than listed here. This test used to
 * name `paper` as one of them and measure the dark edge against it, and no element in the app has
 * ever declared `bg-paper` with a `shadow-e*`: the reading was of a pairing that does not render.
 */

const ROOT = join(import.meta.dirname, '..');
const CSS = readFileSync(join(ROOT, 'client', 'src', 'index.css'), 'utf8');

type Rgb = readonly [number, number, number];

function relativeLuminance([r, g, b]: Rgb): number {
  const channel = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [x, y] = [relativeLuminance(a), relativeLuminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** Source-over composite of `fg` at `alpha` onto an opaque `bg`. */
function composite(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  return [0, 1, 2].map((i) => alpha * fg[i] + (1 - alpha) * bg[i]) as unknown as Rgb;
}

const WHITE: Rgb = [255, 255, 255];

/**
 * Token triplets by theme. The light block is first in the file and the `[data-theme='dark']`
 * block is last, so first/last occurrence selects the theme without brace matching.
 */
function triplet(name: string, theme: 'light' | 'dark'): Rgb {
  const matches = [...CSS.matchAll(new RegExp(`--mz-${name}-c:\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)\\s*;`, 'g'))];
  assert.ok(matches.length > 0, `--mz-${name}-c is not declared in index.css`);
  const m = theme === 'light' ? matches[0] : matches[matches.length - 1];
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** A `--mz-*` token name, resolving the legacy `--color-*` aliases to the one they point at. */
function resolveGround(name: string): string {
  if (CSS.includes(`--mz-${name}-c:`)) return name;
  const alias = CSS.match(new RegExp(`--color-${name}-c:\\s*var\\(--mz-([a-z0-9-]+)-c\\)`));
  assert.ok(alias, `bg-${name} is neither a --mz token nor a --color alias of one`);
  return alias[1];
}

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return tsFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

/**
 * Every ground a `shadow-e*` element declares for itself, derived from the class strings in
 * `client/src`. A line that carries a shadow must carry exactly one `bg-`, or the pairing has been
 * split across lines and this walk would silently under-report it, so that case fails loudly. The
 * `hover:`/`active:` shadow variants declare no ground of their own and are not grounds.
 */
function edgeGrounds(): string[] {
  const grounds = new Set<string>();
  for (const file of tsFiles(join(ROOT, 'client', 'src'))) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!/\bshadow-e[123]\b/.test(line)) continue;
      const bare = /(?<![:\w-])shadow-e[123]\b/.test(line);
      const backgrounds = [...line.matchAll(/(?<![:\w-])bg-([a-z0-9-]+)/g)].map((m) => m[1]);
      if (!bare && backgrounds.length === 0) continue;
      assert.equal(backgrounds.length, 1, `one bg- per shadow-e line, got ${backgrounds.length}: ${file}\n${line}`);
      grounds.add(resolveGround(backgrounds[0]));
    }
  }
  return [...grounds].sort();
}

/** Alpha of the single `rgb(r g b / a)` in a `--mz-edge` declaration. */
function edgeAlpha(declaration: string): number {
  const m = declaration.match(/rgb\(\s*[\d\s]+\/\s*([\d.]+)\s*\)/);
  assert.ok(m, `no rgb(... / alpha) found in --mz-edge value: ${declaration}`);
  return Number(m[1]);
}

const edges = [...CSS.matchAll(/--mz-edge:\s*([^;]+);/g)].map((m) => m[1].trim());

describe('elevation edge', () => {
  test('is declared once per theme block: light, dark media query, dark attribute', () => {
    assert.equal(edges.length, 3);
  });

  test('the light theme ships no lit edge', () => {
    assert.equal(edgeAlpha(edges[0]), 0);
  });

  test('the dark theme ships a lit inset edge, identical in both dark blocks', () => {
    assert.equal(edges[1], edges[2]);
    assert.ok(edges[1].startsWith('inset '), `dark edge must be inset: ${edges[1]}`);
    assert.ok(edgeAlpha(edges[1]) > 0);
  });

  test('the grounds the edge lands on are the three the app actually declares', () => {
    // Hand-listed once and wrong once. `paper` is not among them: nothing in the app pairs
    // `bg-paper` with a `shadow-e*`, so a reading of the edge against paper measures a pairing
    // that never renders.
    assert.deepEqual(edgeGrounds(), ['card', 'card-alt', 'ink']);
  });

  test('on dark the edge is a visible step on both raised surfaces it lands on', () => {
    const alpha = edgeAlpha(edges[1]);
    const measured = (name: string): number => {
      const surface = triplet(name, 'dark');
      return contrast(composite(WHITE, alpha, surface), surface);
    };
    assert.equal(measured('card').toFixed(2), '1.18');
    assert.equal(measured('card-alt').toFixed(2), '1.21');
    for (const name of ['card', 'card-alt'] as const) {
      assert.ok(measured(name) > 1.15, `dark edge over ${name} is only ${measured(name).toFixed(2)}:1`);
    }

    // The third ground is `ink`, which on dark IS pure white, so the white edge composites into it
    // and does exactly nothing. That is the benign direction of the same arithmetic that made the
    // light edge a defect: a white button on a black page needs no help separating from it.
    assert.deepEqual(triplet('ink', 'dark'), WHITE);
    assert.equal(measured('ink').toFixed(2), '1.00');

    // And the figure that retired `paper` from this list, kept because it is the reason: dark paper
    // is pure black, and 0.05 of flare in the denominator holds the step under the floor above.
    assert.deepEqual(triplet('paper', 'dark'), [0, 0, 0]);
    assert.equal(measured('paper').toFixed(2), '1.12');
    assert.ok(!edgeGrounds().includes('paper'));
  });

  test('a light-theme lit edge would be a no-op on surfaces and a band across InkButton', () => {
    // Why the light value is 0 rather than merely smaller. At the 0.35 it used to carry, white
    // composites to a ratio against its OWN surface of:
    const measured = (name: 'card' | 'card-alt' | 'ink'): number => {
      const surface = triplet(name, 'light');
      return contrast(composite(WHITE, 0.35, surface), surface);
    };
    // `card` is pure white on light, so white over it is not a small step, it is no step: the
    // composite is the surface, to the channel.
    assert.deepEqual(triplet('card', 'light'), WHITE);
    assert.equal(measured('card').toFixed(2), '1.00');
    assert.equal(measured('card-alt').toFixed(2), '1.02');
    // `bg-ink shadow-e1` is InkButton, and `ink` is pure black on light. Nothing else on the light
    // theme moved by even 1.02:1.
    assert.deepEqual(triplet('ink', 'light'), [0, 0, 0]);
    assert.equal(measured('ink').toFixed(2), '3.01');
  });

  test('the light shadow is a soft cue and not the boundary, at the value index.css states', () => {
    // The `--mz-e*` note next to the declaration says the shadow colour composites over white
    // paper to rgb(242 242 241), 1.12:1, at its densest pixel before blur, which is under the
    // 1.15:1 step floor the dark edge is held to above. Both halves re-derived here.
    const light = CSS.match(/--mz-e1:\s*([^;]+);/);
    assert.ok(light, '--mz-e1 is not declared in index.css');
    const parts = light[1].match(/rgb\((\d+)\s+(\d+)\s+(\d+)\s*\/\s*([\d.]+)\)/);
    assert.ok(parts, `no rgb(r g b / a) in --mz-e1: ${light[1]}`);
    const colour: Rgb = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
    const paper = triplet('paper', 'light');
    const densest = composite(colour, Number(parts[4]), paper);

    assert.deepEqual(densest.map(Math.round), [242, 242, 241]);
    assert.equal(contrast(densest, paper).toFixed(2), '1.12');
    assert.ok(contrast(densest, paper) < 1.15, 'the light shadow now clears the step floor');
    assert.match(CSS, /composites over white\n\s+paper to rgb\(242 242 241\), 1\.12:1/);

    // And on dark the drop shadow falls onto `paper`, which is pure black, in a colour that is
    // also pure black. There is no cue there at all, which is what the lit edge above is for.
    const all = [...CSS.matchAll(/--mz-e1:\s*([^;]+);/g)];
    const dark = all[all.length - 1][1].match(/rgb\((\d+)\s+(\d+)\s+(\d+)\s*\/\s*([\d.]+)\)/);
    assert.ok(dark, `no rgb(r g b / a) in the dark --mz-e1: ${all[all.length - 1][1]}`);
    const darkPaper = triplet('paper', 'dark');
    const onPaper = composite([Number(dark[1]), Number(dark[2]), Number(dark[3])], Number(dark[4]), darkPaper);
    assert.deepEqual(onPaper, darkPaper);
    assert.equal(contrast(onPaper, darkPaper).toFixed(2), '1.00');
    assert.match(CSS, /composites to the page exactly, 1\.00:1/);

    // Card.tsx repeats these figures to say why its ladder is a border ladder, and it states one
    // row per rung. It used to state 1.12:1 for all three, which is e1's figure alone: e2 and e3
    // are denser and their two terms overlap. Deriving every rung is the point, because pinning the
    // sentence while deriving only from `--mz-e1` is what let the wrong scope survive.
    const card = readFileSync(join(ROOT, 'client', 'src', 'components', 'balance', 'Card.tsx'), 'utf8');
    for (const rung of ['e1', 'e2', 'e3'] as const) {
      const decl = CSS.match(new RegExp(`--mz-${rung}:\\s*([^;]+);`));
      assert.ok(decl, `--mz-${rung} is not declared in index.css`);
      const terms = [...decl[1].matchAll(/rgb\((\d+)\s+(\d+)\s+(\d+)\s*\/\s*([\d.]+)\)/g)];
      assert.ok(terms.length > 0, `no rgb(r g b / a) term in --mz-${rung}`);

      const alphas = terms.map((t) => Number(t[4]));
      const rgb: Rgb = [Number(terms[0][1]), Number(terms[0][2]), Number(terms[0][3])];
      const single = composite(rgb, Math.max(...alphas), paper);
      // Where the terms overlap they composite in sequence, which is the densest pixel the rung
      // can actually put on the page.
      const stacked = alphas.reduce<Rgb>((acc, a) => composite(rgb, a, acc), paper);

      const row = new RegExp(
        `\\*\\s+${rung}\\s+a [\\d.]+(?: over a [\\d.]+)?\\s+rgb\\(${single.map(Math.round).join(' ')}\\)\\s+` +
        `${contrast(single, paper).toFixed(2)}:1\\s+${contrast(stacked, paper).toFixed(2)}:1`,
      );
      assert.match(card, row, `Card.tsx's ${rung} row does not state what --mz-${rung} composites to`);
    }
    // The claim the table supports is that no rung reaches the 3:1 a boundary needs, NOT that every
    // rung is under the 1.15 step floor. e3 stacks to 1.67:1, which is over it.
    const e3 = CSS.match(/--mz-e3:\s*([^;]+);/);
    assert.ok(e3, '--mz-e3 is not declared in index.css');
    const e3Terms = [...e3[1].matchAll(/rgb\((\d+)\s+(\d+)\s+(\d+)\s*\/\s*([\d.]+)\)/g)];
    const e3Rgb: Rgb = [Number(e3Terms[0][1]), Number(e3Terms[0][2]), Number(e3Terms[0][3])];
    const e3Stacked = e3Terms.reduce<Rgb>((acc, t) => composite(e3Rgb, Number(t[4]), acc), paper);
    assert.ok(contrast(e3Stacked, paper) > 1.15, 'e3 no longer clears the step floor, so re-argue the table');
    assert.ok(contrast(e3Stacked, paper) < 3, 'e3 now reaches a real boundary, which the ladder does not account for');
  });

  test('InkButton is still the ink-on-shadow-e1 pairing that made the light edge a defect', () => {
    const buttons = readFileSync(
      join(import.meta.dirname, '..', 'client', 'src', 'components', 'balance', 'buttons.tsx'),
      'utf8'
    );
    const inkButton = buttons.slice(buttons.indexOf('export function InkButton'));
    assert.match(inkButton, /bg-ink\b/);
    assert.match(inkButton, /shadow-e1\b/);
  });

  test('the shipped light edge moves nothing, including InkButton', () => {
    const alpha = edgeAlpha(edges[0]);
    for (const name of edgeGrounds()) {
      const surface = triplet(name, 'light');
      const ratio = contrast(composite(WHITE, alpha, surface), surface);
      assert.equal(ratio, 1, `light edge over ${name} is ${ratio.toFixed(2)}:1, expected exactly 1`);
    }
  });
});

describe('money numerals clear WCAG AA on both grounds in both themes', () => {
  // The tones `Figure` can render a money numeral in, plus the ink it defaults to.
  const NUMERAL_TONES = ['ink', 'sage-deep', 'clay', 'estimate'] as const;
  const AA = 4.5;

  for (const theme of ['light', 'dark'] as const) {
    for (const ground of ['paper', 'card'] as const) {
      for (const tone of NUMERAL_TONES) {
        test(`${tone} on ${ground}, ${theme}`, () => {
          const ratio = contrast(triplet(tone, theme), triplet(ground, theme));
          assert.ok(ratio >= AA, `${ratio.toFixed(2)}:1 is below AA ${AA}:1`);
        });
      }
    }
  }

  test('the two theme blocks are actually different values', () => {
    assert.notDeepEqual(triplet('ink', 'light'), triplet('ink', 'dark'));
    assert.notDeepEqual(triplet('paper', 'light'), triplet('paper', 'dark'));
  });
});

describe('token channel discipline', () => {
  const CONFIG = readFileSync(join(import.meta.dirname, '..', 'tailwind.config.js'), 'utf8');

  test('no base colour token is a bare var(), which parseColor() drops silently', () => {
    // A bare `var(--mz-x)` makes Tailwind 3's withAlphaValue return null and delete every
    // `/alpha` utility built on that colour, with no warning and no build failure. The only
    // tolerated bare vars are the legacy `--color-<name>-5|10` aliases, which are already
    // composed at a fixed alpha and are therefore never a base for an `/alpha` modifier.
    const bare = [...CONFIG.matchAll(/['"`]var\((--[a-z0-9-]+)\)['"`]/g)].map((m) => m[1]);
    const offenders = bare.filter((name) => !/^--color-[a-z]+-(?:5|10)$/.test(name));
    assert.deepEqual(offenders, []);
  });

  test('every token consumed through the mz()/legacy() helpers keeps the channel form', () => {
    assert.match(CONFIG, /const mz = \(name\) => `rgb\(var\(--mz-\$\{name\}-c\) \/ <alpha-value>\)`/);
    assert.match(CONFIG, /const legacy = \(name\) => `rgb\(var\(--color-\$\{name\}-c\) \/ <alpha-value>\)`/);
  });

  test('every --mz-*-c channel token tailwind references is declared in index.css', () => {
    for (const [, name] of CONFIG.matchAll(/mz\('([a-z0-9-]+)'\)/g)) {
      assert.ok(CSS.includes(`--mz-${name}-c:`), `tailwind references --mz-${name}-c, index.css does not declare it`);
    }
  });
});
