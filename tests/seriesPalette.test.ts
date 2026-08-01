import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The categorical series ramp, measured against both grounds rather than described.
 *
 * `chartColors.ts` used to hold ten literal hexes chosen for warm paper. The allocation bar and
 * legend on Investments painted from them through inline `style` props, so the theme toggle moved
 * every surface, every rule and every numeral around them and left the chart exactly where it was.
 *
 * This re-runs the dataviz method's computable checks (OKLCH lightness band, chroma floor, CVD
 * separation under Machado-Oliveira-Fernandes 2009 at severity 1.0, the normal-vision floor, and
 * WCAG contrast against the ground the chart actually sits on) against the tokens as declared in
 * index.css. It is the reason a re-order or a re-step cannot land quietly: the numbers written in
 * the index.css comment are produced here, not copied there.
 *
 * The pairlist is `adjacent`, which is the one a stacked bar and its legend take. Eight slots
 * cannot clear the all-pairs floors and no eight can, so every legend row ships its label and its
 * percentage beside the swatch and identity is never colour alone.
 */

const root = join(import.meta.dirname, '..');
const read = (p: string): string => readFileSync(join(root, p), 'utf8');

const CSS = read('client/src/index.css');
const CHART_COLORS_SRC = read('client/src/lib/chartColors.ts');

const SLOTS = 8;
const BAND = { light: [0.43, 0.77], dark: [0.48, 0.67] } as const;
const CHROMA_FLOOR = 0.1;
const CVD_TARGET = 8;
const NORMAL_FLOOR = 15;
const CONTRAST_MIN = 3;

/** The ground the allocation bar and its legend sit on: `mz-screen` is paper in both themes. */
const GROUND = { light: '--mz-paper-c', dark: '--mz-paper-c' } as const;

type Rgb = readonly [number, number, number];

/**
 * Token triplets by theme. The light block is first in the file and the `[data-theme='dark']`
 * block is last, so first/last occurrence selects the theme without brace matching. Same
 * mechanism `edgeToken.test.ts` uses.
 */
function triplets(name: string): { light: Rgb; dark: Rgb; count: number } {
  const matches = [...CSS.matchAll(new RegExp(`${name}:\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)\\s*;`, 'g'))];
  assert.ok(matches.length > 0, `${name} is not declared in index.css`);
  const at = (m: RegExpMatchArray): Rgb => [Number(m[1]), Number(m[2]), Number(m[3])];
  return { light: at(matches[0]), dark: at(matches[matches.length - 1]), count: matches.length };
}

// ── colour maths, transcribed from the skill's validator ──────────────────────
const MACHADO = {
  protan: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deutan: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
} as const;

const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linear = ([r, g, b]: Rgb): [number, number, number] => [toLinear(r / 255), toLinear(g / 255), toLinear(b / 255)];

function oklab([r, g, b]: [number, number, number]): [number, number, number] {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklch(rgb: Rgb): { L: number; C: number } {
  const [L, a, b] = oklab(linear(rgb));
  return { L, C: Math.hypot(a, b) };
}

function simulate(rgb: Rgb, kind: keyof typeof MACHADO): [number, number, number] {
  const [r, g, b] = linear(rgb);
  const m = MACHADO[kind];
  const clamp = (c: number): number => Math.max(0, Math.min(1, c));
  return [
    clamp(m[0][0] * r + m[0][1] * g + m[0][2] * b),
    clamp(m[1][0] * r + m[1][1] * g + m[1][2] * b),
    clamp(m[2][0] * r + m[2][1] * g + m[2][2] * b),
  ];
}

function deltaE(a: Rgb, b: Rgb, kind?: keyof typeof MACHADO): number {
  const x = oklab(kind ? simulate(a, kind) : linear(a));
  const y = oklab(kind ? simulate(b, kind) : linear(b));
  return 100 * Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

function contrast(a: Rgb, b: Rgb): number {
  const lum = (rgb: Rgb): number => {
    const [r, g, bl] = linear(rgb);
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// ── the ramp as declared ──────────────────────────────────────────────────────
const SLOT_NAMES = Array.from({ length: SLOTS }, (_, i) => `--mz-series-${i + 1}-c`);
const RAMP = { light: [] as Rgb[], dark: [] as Rgb[] };
for (const name of SLOT_NAMES) {
  const t = triplets(name);
  RAMP.light.push(t.light);
  RAMP.dark.push(t.dark);
}

describe('the series ramp is declared the way every other token is', () => {
  for (const name of SLOT_NAMES) {
    test(`${name} is declared in all three theme blocks`, () => {
      // light `:root`, the prefers-color-scheme block, and the [data-theme='dark'] block.
      assert.equal(triplets(name).count, 3);
    });
  }

  test('the two dark blocks carry identical values, so the OS and the toggle agree', () => {
    for (const name of SLOT_NAMES) {
      const all = [...CSS.matchAll(new RegExp(`${name}:\\s*([\\d ]+);`, 'g'))].map((m) => m[1].trim());
      assert.equal(all[1], all[2], `${name} disagrees between the media query and the attribute block`);
    }
  });

  test('each composed alias exists exactly once and reads its own channel form', () => {
    for (let slot = 1; slot <= SLOTS; slot++) {
      const alias = [...CSS.matchAll(new RegExp(`--mz-series-${slot}:\\s*([^;]+);`, 'g'))].map((m) => m[1].trim());
      assert.deepEqual(alias, [`rgb(var(--mz-series-${slot}-c))`]);
    }
  });

  test('every theme moves the ramp: no slot is the same colour on both grounds', () => {
    for (let slot = 0; slot < SLOTS; slot++) {
      assert.notDeepEqual(RAMP.light[slot], RAMP.dark[slot], `slot ${slot + 1} never changed for dark`);
    }
  });
});

describe('chartColors.ts consumes the tokens and nothing else', () => {
  test('the exported ramp is the eight tokens, in order', () => {
    const refs = [...CHART_COLORS_SRC.matchAll(/'var\(--mz-series-(\d)\)'/g)].map((m) => Number(m[1]));
    assert.deepEqual(refs, [1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test('no literal hex survives in the chart palette', () => {
    // Hexes here were the defect: they cannot follow the theme. Comments are allowed to quote
    // the ground colours the measurements were taken against, so only code lines are checked.
    const code = CHART_COLORS_SRC.split('\n').filter((line) => !/^\s*(\*|\/\*|\/\/)/.test(line));
    assert.equal(code.join('\n').includes('#'), false);
  });
});

for (const theme of ['light', 'dark'] as const) {
  describe(`the ramp passes the dataviz checks on the ${theme} ground`, () => {
    const ramp = RAMP[theme];
    const ground = triplets(GROUND[theme])[theme];
    const [lo, hi] = BAND[theme];

    test(`every slot sits inside the ${theme} lightness band`, () => {
      for (const [i, rgb] of ramp.entries()) {
        const { L } = oklch(rgb);
        assert.ok(L >= lo && L <= hi, `slot ${i + 1} has L ${L.toFixed(3)}, outside ${lo}-${hi}`);
      }
    });

    test('every slot clears the chroma floor, so no slot reads as grey', () => {
      for (const [i, rgb] of ramp.entries()) {
        const { C } = oklch(rgb);
        assert.ok(C >= CHROMA_FLOOR, `slot ${i + 1} has C ${C.toFixed(3)}, below ${CHROMA_FLOOR}`);
      }
    });

    test('adjacent slots stay apart under protanopia and deuteranopia', () => {
      let worst = { dE: Infinity, pair: '' };
      for (let i = 0; i + 1 < ramp.length; i++) {
        for (const kind of ['protan', 'deutan'] as const) {
          const dE = deltaE(ramp[i], ramp[i + 1], kind);
          if (dE < worst.dE) worst = { dE, pair: `${i + 1}/${i + 2} ${kind}` };
        }
      }
      assert.ok(worst.dE >= CVD_TARGET, `worst adjacent CVD pair ${worst.pair} is ΔE ${worst.dE.toFixed(1)}`);
    });

    test('adjacent slots stay apart for full-colour readers too', () => {
      let worst = { dE: Infinity, pair: '' };
      for (let i = 0; i + 1 < ramp.length; i++) {
        const dE = deltaE(ramp[i], ramp[i + 1]);
        if (dE < worst.dE) worst = { dE, pair: `${i + 1}/${i + 2}` };
      }
      assert.ok(worst.dE >= NORMAL_FLOOR, `worst adjacent pair ${worst.pair} is ΔE ${worst.dE.toFixed(1)}`);
    });

    test('every slot clears 3:1 against the ground it is painted on', () => {
      for (const [i, rgb] of ramp.entries()) {
        const ratio = contrast(rgb, ground);
        assert.ok(ratio >= CONTRAST_MIN, `slot ${i + 1} is ${ratio.toFixed(2)}:1 on ${theme} paper`);
      }
    });
  });
}
