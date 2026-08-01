import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The palette arithmetic, in one place.
 *
 * `cardElevation`, `railGround`, `accountsRowContrast`, `edgeToken` and `seriesPalette` each carried
 * their own copy of `triplet` / `relativeLuminance` / `contrast`. Five copies of one formula is five
 * chances for one of them to drift, which is the same failure mode as five copies of a token list.
 * New colour tests import from here.
 *
 * Everything below reads `client/src/index.css` and `tailwind.config.js` at call time. Nothing is
 * a remembered number.
 */

const ROOT = join(import.meta.dirname, '..', '..');

export const PALETTE_CSS_PATH = join(ROOT, 'client', 'src', 'index.css');
export const TAILWIND_CONFIG_PATH = join(ROOT, 'tailwind.config.js');

const CSS = readFileSync(PALETTE_CSS_PATH, 'utf8');
const TAILWIND = readFileSync(TAILWIND_CONFIG_PATH, 'utf8');

export type Theme = 'light' | 'dark';
export type Rgb = readonly [number, number, number];

export const THEMES: readonly Theme[] = ['light', 'dark'];

/**
 * Token triplets by theme. The light block is first in the file and the `[data-theme='dark']` block
 * is last, so first/last occurrence selects the theme without brace matching.
 */
export function triplet(name: string, theme: Theme): Rgb {
  const all = [...CSS.matchAll(new RegExp(`--mz-${name}-c:\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)\\s*;`, 'g'))];
  assert.ok(all.length > 0, `--mz-${name}-c is not declared in index.css`);
  const m = theme === 'light' ? all[0] : all[all.length - 1];
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** WCAG 2.1 relative luminance, sRGB. */
export function relativeLuminance([r, g, b]: Rgb): number {
  const channel = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 2.1 contrast between two opaque colours, unrounded. */
export function contrast(a: Rgb, b: Rgb): number {
  const [x, y] = [relativeLuminance(a), relativeLuminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** Contrast between two named tokens in one theme, unrounded. Round at the call site. */
export function ratioOf(fg: string, bg: string, theme: Theme): number {
  return contrast(triplet(fg, theme), triplet(bg, theme));
}

/** The same, rounded to the two decimals every comment in this repo states. */
export function ratio(fg: string, bg: string, theme: Theme): number {
  return Number(ratioOf(fg, bg, theme).toFixed(2));
}

/** CIE L*, the axis the neutral ladder is written in. */
export function lstar(name: string, theme: Theme): number {
  const y = relativeLuminance(triplet(name, theme));
  return Number((y <= 216 / 24389 ? (y * 24389) / 27 : Math.cbrt(y) * 116 - 16).toFixed(1));
}

/** Source-over composite of `fg` at `alpha` onto an opaque `bg`. */
export function composite(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  return [0, 1, 2].map((i) => alpha * fg[i] + (1 - alpha) * bg[i]) as unknown as Rgb;
}

/** Every `--mz-*-c` token declared in index.css. */
export function paletteTokens(): string[] {
  return [...new Set([...CSS.matchAll(/--mz-([a-z0-9-]+)-c:/g)].map((m) => m[1]))].sort();
}

/**
 * Tailwind utility name to palette token, read out of `tailwind.config.js` rather than typed.
 *
 * The two families do not share a spelling: `text-sage-text` is `--mz-pill-text-c`, `bg-pill-bg` is
 * `--mz-pill-muted-bg-c`, and the legacy `--color-*` aliases resolve onto tokens that already exist.
 * Any hand-written version of this map is a second list to keep in sync, which is how four copies of
 * the autonomy set happened.
 */
export function utilityTokens(): Record<string, string> {
  const start = TAILWIND.indexOf('colors: {');
  assert.ok(start > 0, 'tailwind.config.js no longer declares a colors block');
  const out: Record<string, string> = {};
  const stack: string[] = [];
  let depth = 0;

  for (const raw of TAILWIND.slice(start).split('\n')) {
    const line = raw.trim();
    const open = /^'?([\w-]+)'?:\s*\{$/.exec(line);
    const leaf = /^'?([\w-]+)'?:\s*(mz|legacy)\('([^']+)'\)/.exec(line);
    if (leaf) {
      const [, key, kind, name] = leaf;
      const path = [...stack, key].filter((k) => k !== 'DEFAULT');
      out[path.join('-')] = kind === 'mz' ? name : legacyTarget(name);
      continue;
    }
    if (open) {
      if (depth > 0) stack.push(open[1]);
      depth += 1;
      continue;
    }
    if (line.startsWith('}')) {
      depth -= 1;
      if (depth <= 0) break;
      stack.pop();
    }
  }
  assert.ok(Object.keys(out).length > 20, 'the tailwind colour walk found almost nothing');
  return out;
}

/** `--color-negative-c: var(--mz-clay-c)` -> `clay`. */
function legacyTarget(name: string): string {
  const alias = CSS.match(new RegExp(`--color-${name}-c:\\s*var\\(--mz-([a-z0-9-]+)-c\\)`));
  assert.ok(alias, `--color-${name}-c is not an alias of an --mz token`);
  return alias[1];
}
