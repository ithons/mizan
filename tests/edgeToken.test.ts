import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The elevation edge, and the money numerals, checked against the shipped token file rather than
 * against a number somebody typed into a comment.
 *
 * `shadow-e1|e2|e3` compose as `var(--mz-edge), var(--mz-e*)`, so `--mz-edge` lands on every raised
 * surface AND on `InkButton`, which is `bg-ink shadow-e1`. A lit white edge is the mechanism that
 * separates a raised object from a dark ground; on a light ground it is invisible on the surfaces
 * it was meant for and a hard value band across the top of the one near-black control.
 */

const CSS = readFileSync(join(import.meta.dirname, '..', 'client', 'src', 'index.css'), 'utf8');

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

  test('on dark the edge is a visible step on every surface it lands on', () => {
    const alpha = edgeAlpha(edges[1]);
    for (const name of ['card', 'card-alt', 'paper'] as const) {
      const surface = triplet(name, 'dark');
      const ratio = contrast(composite(WHITE, alpha, surface), surface);
      assert.ok(ratio > 1.15, `dark edge over ${name} is only ${ratio.toFixed(2)}:1`);
    }
  });

  test('a light-theme lit edge would be a no-op on surfaces and a band across InkButton', () => {
    // Why the light value is 0 rather than merely smaller. At the 0.35 it used to carry, white
    // composites to a ratio against its OWN surface of:
    const measured = (name: 'card' | 'card-alt' | 'paper' | 'ink'): number => {
      const surface = triplet(name, 'light');
      return contrast(composite(WHITE, 0.35, surface), surface);
    };
    assert.equal(measured('card').toFixed(2), '1.04');
    assert.equal(measured('card-alt').toFixed(2), '1.01');
    assert.equal(measured('paper').toFixed(2), '1.12');
    // `bg-ink shadow-e1` is InkButton. Nothing else on the light theme moved by even 1.12:1.
    assert.equal(measured('ink').toFixed(2), '3.18');
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
    for (const name of ['card', 'card-alt', 'paper', 'ink'] as const) {
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
