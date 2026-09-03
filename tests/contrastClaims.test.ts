import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { paletteTokens, ratioOf, utilityTokens, type Theme } from './helpers/palette';

/**
 * Every contrast figure written into a comment under `client/src`, re-derived from the palette.
 *
 * WHY THIS FILE EXISTS. Contrast figures live in prose all over `client/src`, and until now three
 * files pinned a handful of them with bespoke regexes (`cardElevation`, `railGround`,
 * `accountsRowContrast`) while everything else drifted in silence. The 2026-08-01 palette proved
 * how far: it moved the light ground to pure white and re-solved every ink against it, and roughly
 * sixty figures with no test behind them were left stating what the previous triplets measured.
 * Several of them now argue the reverse of the truth while being the stated reason for a decision
 * in the code, which is exactly what rule 2 of this codebase forbids: never a claim, in code or in
 * copy, that the code did not check.
 *
 * Per-file regex pinning does not scale and is itself what rotted. This walks instead.
 *
 * WHAT A CLAIM IS. A ratio figure stated near one or more token names, in one of the shapes this
 * codebase actually writes. The shapes are enumerated in PATTERNS below, each with a real example
 * from the tree. Two decimals are required (`4.93`, not `4.5` or `1.072`), which is both the house
 * style for a measured ratio and what keeps the 3:1 and 4.5:1 THRESHOLDS out of the claim set.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It misses claims rather than inventing them. A figure whose
 * subject or ground is carried by an English pronoun ("21.00:1 ... on it"), a figure whose token is
 * named only as "the second", and a composite through an `opacity-*` veil are all left alone: they
 * are ratios, but nothing in the sentence says which two triplets produced them. Every ratio-shaped
 * figure the walker declines to parse is counted and printed in the coverage report, so a reader
 * can see where it is blind instead of reading silence as completeness.
 *
 * THE OPT-OUT, AND IT LIVES IN THE SOURCE, NOT HERE. This repo legitimately records what a defect
 * measured at the time, and that figure must not be "corrected" into agreeing with today's palette.
 * Mark it in the comment itself:
 *
 *     `muted-2` on `rail` read 3.67:1 before the 2026-08-01 palette   [historical]
 *
 * `[historical]` on the same line as the figure exempts every claim on that line. `[historical]` on
 * the first line of a comment paragraph exempts the whole paragraph. There is no allowlist in this
 * test file, on purpose: a reader of the comment has to be able to see that it is exempt. A figure
 * written as superseded inline (`3.97 -> 4.08`) is skipped without a marker, because the arrow says
 * the same thing.
 *
 * If this file flags prose it misread, that is a bug in the walker and not a licence to delete the
 * test: narrow the pattern, or mark the line, and say which in the commit.
 */

const ROOT = join(import.meta.dirname, '..');
const SRC = join(ROOT, 'client', 'src');

/* ── vocabulary ───────────────────────────────────────────────────────────── */

/**
 * `text`, `border`, `background` and `surface` are legacy Tailwind aliases whose names are also
 * ordinary English. Reading "the border carries the chip" as a colour claim is the false positive
 * that would get this test switched off, so they are not in the vocabulary. Nothing is lost: every
 * one of them aliases a token that IS in it (`border` -> `line-2`, `text` -> `ink`).
 */
const AMBIGUOUS = new Set(['text', 'border', 'background', 'surface']);

/** Utility or token name -> `--mz-<token>-c`. Read from tailwind.config.js and index.css. */
const VOCAB: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  for (const [util, token] of Object.entries(utilityTokens())) if (!AMBIGUOUS.has(util)) out[util] = token;
  for (const token of paletteTokens()) if (!AMBIGUOUS.has(token) && !(token in out)) out[token] = token;
  return out;
})();

const NAMES = Object.keys(VOCAB)
  .sort((a, b) => b.length - a.length || a.localeCompare(b))
  .join('|');

/** A token name, optionally spelled as the Tailwind utility that carries it. */
const TOK = `(?<![\\w-])(?:(?:text|bg|border|ring|fill|stroke|divide)-)?(${NAMES})(?![\\w-])`;
/** A measured ratio: two decimals exactly. Excludes `3:1`, `4.5:1` and the old `1.072:1` figures. */
const R = `(\\d{1,2}\\.\\d{2})(?!\\d)`;
const TH = `(light|dark)`;
const VERB = `(?:is|are|was|were|reads?|measures?|measured|sits? at|clears? at|clears?|at|of)`;
/** A gap that may not cross a sentence boundary. A period followed by a digit is a decimal point. */
const gap = (n: number) => `(?:[^.]|\\.(?=\\d)){0,${n}}?`;

/* ── comment extraction ───────────────────────────────────────────────────── */

/**
 * Blank out everything that is not comment text, preserving every column and newline.
 *
 * Column-exact because two of the shapes below are aligned tables and the ground a cell belongs to
 * is decided by which header column it sits under. A real scanner rather than a regex sweep, because
 * this tree is full of template literals holding class strings, and `{\`.. // ..\`}` inside one is
 * not a comment.
 */
export function commentMask(src: string, css = false): string {
  const out = src.split('');
  const blank = (from: number, to: number) => {
    for (let i = from; i < to; i += 1) if (out[i] !== '\n') out[i] = ' ';
  };
  const keepOnly = (from: number, to: number) => {
    // Delimiters are not content; the text between them is.
    blank(from, Math.min(to, src.length));
  };

  let i = 0;
  const tplStack: number[] = [];
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '*') {
      let end = src.indexOf('*/', i + 2);
      end = end < 0 ? src.length : end + 2;
      keepOnly(i, i + 2);
      keepOnly(end - 2, end);
      i = end;
      continue;
    }
    if (!css && c === '/' && next === '/') {
      let end = src.indexOf('\n', i);
      if (end < 0) end = src.length;
      keepOnly(i, i + 2);
      i = end;
      continue;
    }
    if (css) {
      blank(i, i + 1);
      i += 1;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      blank(i, Math.min(j + 1, src.length));
      i = j + 1;
      continue;
    }
    if (c === '`') {
      tplStack.push(1);
      blank(i, i + 1);
      i += 1;
      let j = i;
      while (j < src.length) {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === '`') break;
        if (src[j] === '$' && src[j + 1] === '{') break;
        j += 1;
      }
      blank(i, Math.min(j, src.length));
      if (src[j] === '`') {
        blank(j, j + 1);
        tplStack.pop();
        i = j + 1;
      } else {
        blank(j, j + 2);
        i = j + 2;
      }
      continue;
    }
    if (c === '}' && tplStack.length > 0) {
      blank(i, i + 1);
      i += 1;
      // Resume the template literal that this `${...}` interrupted.
      let j = i;
      while (j < src.length) {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === '`' || (src[j] === '$' && src[j + 1] === '{')) break;
        j += 1;
      }
      blank(i, Math.min(j, src.length));
      if (src[j] === '`') {
        blank(j, j + 1);
        tplStack.pop();
        i = j + 1;
      } else {
        blank(j, j + 2);
        i = j + 2;
      }
      continue;
    }
    blank(i, i + 1);
    i += 1;
  }
  return out.join('');
}

export interface Para {
  /** 1-indexed source line of the paragraph's first line. */
  start: number;
  /** Comment text with columns preserved; one entry per source line. */
  lines: string[];
}

/**
 * Comment text split into paragraphs. A blank line ends a paragraph, which is what stops a ground
 * mentioned four paragraphs up from being carried onto a figure that is not about it.
 */
export function paragraphs(src: string, css = false): Para[] {
  const masked = commentMask(src, css)
    .split('\n')
    // The `*` that continues a block comment is furniture, and so are the backticks around a token
    // name. Both are replaced by a space so the column of everything after them is unchanged.
    .map((l) => l.replace(/^(\s*)\*(?!\/)/, (_, s: string) => `${s} `).replace(/`/g, ' '));
  const out: Para[] = [];
  let current: Para | null = null;
  masked.forEach((line, idx) => {
    if (line.trim() === '') {
      current = null;
      return;
    }
    if (!current) {
      current = { start: idx + 1, lines: [] };
      out.push(current);
    }
    current.lines.push(line);
  });
  return out;
}

/* ── claims ───────────────────────────────────────────────────────────────── */

export interface Claim {
  file: string;
  line: number;
  shape: string;
  quote: string;
  /** Token names as written, for the failure message. */
  fgName: string;
  bgName: string;
  fg: string;
  bg: string;
  /** `null` when the prose does not say which theme; then the claim must hold in at least one. */
  theme: Theme | null;
  claimed: number;
}

const rx = (body: string) => new RegExp(body, 'gi');

interface Ctx {
  text: string;
  fgAt: (pos: number) => string | null;
  bgAt: (pos: number) => string | null;
  groundPair: (pos: number) => [string, string] | null;
}

interface Pattern {
  name: string;
  re: RegExp;
  build: (m: RegExpExecArray, ctx: Ctx) => Array<Omit<Claim, 'file' | 'line' | 'shape' | 'quote'>> | null;
}

const themeOf = (word: string | undefined): Theme | null =>
  word ? (word.toLowerCase() as Theme) : null;

/** `A / B` with no theme words is light / dark; this codebase writes the pair no other way. */
const pairThemes = (a: string | undefined, b: string | undefined): [Theme, Theme] => [
  themeOf(a) ?? 'light',
  themeOf(b) ?? 'dark',
];

/**
 * The shapes, most specific first. Each carries a real example, because a pattern with no example
 * in the tree is a pattern nobody can check.
 */
const PATTERNS: Pattern[] = [
  {
    // "`muted` on `rail`, 6.67:1 light / 7.38:1 dark"   "clay on rail measures 5.85:1 light / 7.85:1 dark"
    name: 'fg-on-bg, both themes',
    re: rx(`${TOK}\\s+(?:on|against)\\s+${TOK}${gap(45)}${R}(?::1)?\\s*(?:in\\s+|on\\s+)?${TH}\\s*(?:/|and|,)\\s*${R}(?::1)?\\s*(?:in\\s+|on\\s+)?${TH}`),
    build: (m) => {
      const [t1, t2] = [themeOf(m[4]), themeOf(m[6])];
      if (!t1 || !t2 || t1 === t2) return null;
      return [
        { fgName: m[1], bgName: m[2], fg: VOCAB[m[1]], bg: VOCAB[m[2]], theme: t1, claimed: Number(m[3]) },
        { fgName: m[1], bgName: m[2], fg: VOCAB[m[1]], bg: VOCAB[m[2]], theme: t2, claimed: Number(m[5]) },
      ];
    },
  },
  {
    // "clay on pill-bg           11.43 / 12.21"  (a table row: whitespace only between the two)
    name: 'fg-on-bg, slash pair',
    re: rx(`${TOK}\\s+(?:on|against)\\s+${TOK}\\s+(?:${VERB}\\s+)?${R}(?::1)?\\s*/\\s*${R}(?::1)?`),
    build: (m) => {
      const [t1, t2] = pairThemes(undefined, undefined);
      return [
        { fgName: m[1], bgName: m[2], fg: VOCAB[m[1]], bg: VOCAB[m[2]], theme: t1, claimed: Number(m[3]) },
        { fgName: m[1], bgName: m[2], fg: VOCAB[m[1]], bg: VOCAB[m[2]], theme: t2, claimed: Number(m[4]) },
      ];
    },
  },
  {
    // "`sage` is 3.18:1 light and 3.14:1 dark against `track`"
    name: 'fg, both themes, then bg',
    re: rx(`${TOK}\\s+(?:${VERB}\\s+)?${R}(?::1)?\\s*${TH}\\s*(?:and|/)\\s*${R}(?::1)?\\s*${TH}\\s+(?:against|on)\\s+${TOK}`),
    build: (m) => {
      const [t1, t2] = [themeOf(m[3]), themeOf(m[5])];
      if (!t1 || !t2 || t1 === t2) return null;
      return [
        { fgName: m[1], bgName: m[6], fg: VOCAB[m[1]], bg: VOCAB[m[6]], theme: t1, claimed: Number(m[2]) },
        { fgName: m[1], bgName: m[6], fg: VOCAB[m[1]], bg: VOCAB[m[6]], theme: t2, claimed: Number(m[4]) },
      ];
    },
  },
  {
    // "line-3 is 1.54:1 on light paper"   "`sage-deep`, the positive-money token, reads 4.38:1 on light `well`"
    name: 'fg, one ratio, themed bg',
    re: rx(`${TOK}${gap(40)}\\s${VERB}\\s+${R}(?::1)?\\s+on\\s+${TH}\\s+${TOK}`),
    build: (m) => {
      const theme = themeOf(m[3]);
      if (!theme) return null;
      return [{ fgName: m[1], bgName: m[4], fg: VOCAB[m[1]], bg: VOCAB[m[4]], theme, claimed: Number(m[2]) }];
    },
  },
  {
    // "On `card` it reads 6.11:1 light and 7.05:1 dark"  (subject carried from the sentence before)
    name: 'carried fg, "on <bg> it reads"',
    re: rx(`\\bon\\s+${TOK}\\s+it\\s+(?:${VERB}\\s+)?${R}(?::1)?\\s*(?:in\\s+)?${TH}(?:\\s*(?:and|/)\\s*${R}(?::1)?\\s*(?:in\\s+)?${TH})?`),
    build: (m, ctx) => {
      const fg = ctx.fgAt(m.index);
      if (!fg) return null;
      const first = themeOf(m[3]);
      if (!first) return null;
      const claims = [{ fgName: fg, bgName: m[1], fg: VOCAB[fg], bg: VOCAB[m[1]], theme: first, claimed: Number(m[2]) }];
      const second = themeOf(m[5]);
      if (m[4] && second && second !== first) {
        claims.push({ fgName: fg, bgName: m[1], fg: VOCAB[fg], bg: VOCAB[m[1]], theme: second, claimed: Number(m[4]) });
      }
      return claims;
    },
  },
  {
    // "review-text on review-active measures 4.44:1 in light"   "`card` on `paper` measures 1.00:1"
    name: 'fg-on-bg, one ratio',
    re: rx(`${TOK}\\s+(?:on|against)\\s+${TOK}${gap(35)}${R}(?::1)(?:\\s*(?:in|on)\\s+${TH})?`),
    build: (m) => [
      { fgName: m[1], bgName: m[2], fg: VOCAB[m[1]], bg: VOCAB[m[2]], theme: themeOf(m[4]), claimed: Number(m[3]) },
    ],
  },
  {
    // "gold      light 4.57 / 5.67   dark 7.40 / 6.22", under a header reading "on paper / on card"
    name: 'two-ground table row',
    re: rx(`${TOK}\\s+light\\s+${R}(?::1)?\\s*/\\s*${R}(?::1)?\\s+dark\\s+${R}(?::1)?\\s*/\\s*${R}(?::1)?`),
    build: (m, ctx) => {
      const pair = ctx.groundPair(m.index);
      if (!pair) return null;
      const [g1, g2] = pair;
      return [
        { fgName: m[1], bgName: g1, fg: VOCAB[m[1]], bg: VOCAB[g1], theme: 'light' as Theme, claimed: Number(m[2]) },
        { fgName: m[1], bgName: g2, fg: VOCAB[m[1]], bg: VOCAB[g2], theme: 'light' as Theme, claimed: Number(m[3]) },
        { fgName: m[1], bgName: g1, fg: VOCAB[m[1]], bg: VOCAB[g1], theme: 'dark' as Theme, claimed: Number(m[4]) },
        { fgName: m[1], bgName: g2, fg: VOCAB[m[1]], bg: VOCAB[g2], theme: 'dark' as Theme, claimed: Number(m[5]) },
      ];
    },
  },
  {
    // "`faint` (3.46 light / 4.29 dark)"   "muted 5.74/6.19"   "`text-ink` is 12.73:1 light and 9.58:1 dark"
    // The ground comes from the "on <bg>" / "against <bg>" that introduced the list.
    name: 'fg pair on the carried ground',
    re: rx(`${TOK}\\s+(?:${VERB}\\s+)?\\(?\\s*${R}(?::1)?\\s*${TH}?\\s*(?:and|/)\\s*${R}(?::1)?\\s*${TH}?`),
    build: (m, ctx) => {
      const bg = ctx.bgAt(m.index);
      if (!bg || bg === m[1]) return null;
      const [t1, t2] = pairThemes(m[3], m[5]);
      if (t1 === t2) return null;
      return [
        { fgName: m[1], bgName: bg, fg: VOCAB[m[1]], bg: VOCAB[bg], theme: t1, claimed: Number(m[2]) },
        { fgName: m[1], bgName: bg, fg: VOCAB[m[1]], bg: VOCAB[bg], theme: t2, claimed: Number(m[4]) },
      ];
    },
  },
  {
    // "(5.67:1 light paper, 7.04:1 light card, ...)": subject carried, ground and theme explicit.
    // `on` has to sit on the ratio's own line: "3.01:1\n On light `card` IS the page" is a new
    // sentence about a composite, not a continuation of the row above it.
    name: 'carried fg, themed ground',
    re: rx(`${R}(?::1)?(?:[ \\t]+on)?[ \\t]*\\n?[ \\t]*${TH}[ \\t]+${TOK}`),
    build: (m, ctx) => {
      const fg = ctx.fgAt(m.index);
      const theme = themeOf(m[2]);
      if (!fg || !theme || fg === m[3]) return null;
      return [{ fgName: fg, bgName: m[3], fg: VOCAB[fg], bg: VOCAB[m[3]], theme, claimed: Number(m[1]) }];
    },
  },
  {
    // "(light 3.26 on paper, dark 4.10)": the same, written theme-first.
    name: 'carried fg, theme then ground',
    re: rx(`${TH}\\s+${R}(?::1)?\\s+on\\s+${TOK}`),
    build: (m, ctx) => {
      const fg = ctx.fgAt(m.index);
      const theme = themeOf(m[1]);
      if (!fg || !theme || fg === m[3]) return null;
      return [{ fgName: fg, bgName: m[3], fg: VOCAB[fg], bg: VOCAB[m[3]], theme, claimed: Number(m[2]) }];
    },
  },
  {
    // "`muted`'s 7.01:1"   "dot is 2.10:1"   "where sage measures 3.91:1"
    // Last, and the loosest. No digit may appear between the token and the ratio, so
    // "over ink (  0   0   0) -> rgb( 89  89  89)   3.01:1" is a composite and not a token pair; and
    // no comma either, so "e3 separates with `line-3`, worth 4.74:1 ... against its own surface" is
    // left to the ground it actually names rather than to whichever one was carried in.
    name: 'fg, one ratio, carried ground',
    re: rx(`${TOK}[^\\d.,]{0,14}${R}:1`),
    build: (m, ctx) => {
      const bg = ctx.bgAt(m.index);
      if (!bg || bg === m[1]) return null;
      return [{ fgName: m[1], bgName: bg, fg: VOCAB[m[1]], bg: VOCAB[bg], theme: null, claimed: Number(m[2]) }];
    },
  },
];

/** `on paper / on card:` is the header that gives a two-ground table row its columns. */
const GROUND_PAIR = rx(`\\bon\\s+${TOK}\\s*/\\s*on\\s+${TOK}`);
/**
 * What makes a token occurrence a GROUND rather than the subject of a claim.
 *
 * The second alternative is load-bearing: in "5.67:1 light paper, 7.04:1 light card" the grounds
 * carry no preposition at all, and without this the `paper` of the first item becomes the subject
 * of the second and the walker reports `paper on card`, which is a pair nothing renders.
 */
const AS_GROUND = new RegExp(
  '(?:' +
    '\\b(?:on|against|over|onto)\\s+(?:the\\s+|a\\s+)?(?:light\\s+|dark\\s+)?' +
    '|\\bground\\s+is\\s+' +
    '|\\d{1,2}\\.\\d{2}(?::1)?\\s+(?:on\\s+)?(?:light|dark)\\s+' +
    ')$',
  'i'
);
/** Wide enough to reach back over a wrapped line's indentation; the match is anchored regardless. */
const GROUND_LOOKBACK = 80;

/* ── aligned tables ───────────────────────────────────────────────────────── */

const CELL = /(?<![\w.\d])(\d{1,2}\.\d{2})(?!\d)(?:\s*\/\s*(\d{1,2}\.\d{2})(?!\d))?|(?<![\w-])-(?![\w-])/g;

interface Header {
  idx: number;
  cols: Array<{ name: string; col: number }>;
}

/** A line whose words are all token names is a column header for the rows under it. */
function groundHeader(line: string): Header['cols'] | null {
  const bare = line.replace(/\([^)]*\)/g, ' ');
  if (/\d/.test(bare)) return null;
  const words = [...bare.matchAll(/[^\s]+/g)];
  if (words.length < 2) return null;
  const cols = words.map((w) => ({ name: w[0], col: w.index! }));
  if (!cols.every((c) => c.name in VOCAB)) return null;
  return cols;
}

/** A line whose words are all LIGHT / DARK is the theme header above a ground header. */
function themeHeader(line: string): Header['cols'] | null {
  const words = [...line.matchAll(/[^\s]+/g)];
  if (words.length < 2) return null;
  if (!words.every((w) => /^(light|dark)$/i.test(w[0]))) return null;
  return words.map((w) => ({ name: w[0].toLowerCase(), col: w.index! }));
}

const nearest = (cols: Header['cols'], col: number) =>
  cols.reduce((best, c) => (Math.abs(c.col - col) < Math.abs(best.col - col) ? c : best));

/**
 * The aligned-table shape: an optional theme header, a ground header, then one row per token.
 *
 * Which ground a cell belongs to is decided by the column it sits in, which is the only thing the
 * table itself says. A row labelled `pill-text on sage-tint` overrides the ground for its own cells.
 */
function tableClaims(para: Para, file: string): { claims: Claim[]; consumed: Set<number> } {
  const claims: Claim[] = [];
  const consumed = new Set<number>();
  for (let i = 0; i < para.lines.length; i += 1) {
    const grounds = groundHeader(para.lines[i]);
    if (!grounds) continue;
    const themes = i > 0 ? themeHeader(para.lines[i - 1]) : null;

    let rows = 0;
    for (let j = i + 1; j < para.lines.length; j += 1) {
      const line = para.lines[j];
      const label = /^\s*([a-z][\w-]*)(?:\s+on\s+([a-z][\w-]*))?\s\s+/i.exec(line);
      if (!label || !(label[1] in VOCAB)) break;
      const cells = [...line.slice(label[0].length - 1).matchAll(CELL)].map((m) => ({
        value: m[1] ? Number(m[1]) : null,
        pair: m[2] ? Number(m[2]) : null,
        col: m.index! + label[0].length - 1,
      }));
      if (cells.length === 0) break;

      for (const cell of cells) {
        if (cell.value === null) continue;
        const ground = label[2] ?? nearest(grounds, cell.col).name;
        if (!(ground in VOCAB)) continue;
        if (label[2] === undefined && Math.abs(nearest(grounds, cell.col).col - cell.col) > 8) continue;
        const push = (theme: Theme, claimed: number) =>
          claims.push({
            file,
            line: para.start + j,
            shape: 'aligned table',
            quote: line.trim(),
            fgName: label[1],
            bgName: ground,
            fg: VOCAB[label[1]],
            bg: VOCAB[ground],
            theme,
            claimed,
          });
        if (cell.pair !== null) {
          push('light', cell.value);
          push('dark', cell.pair);
        } else if (themes) {
          push(nearest(themes, cell.col).name as Theme, cell.value);
        }
      }
      consumed.add(j);
      rows += 1;
    }
    if (rows > 0) consumed.add(i);
  }
  return { claims, consumed };
}

/* ── the walk ─────────────────────────────────────────────────────────────── */

const HISTORICAL = /\[historical\]/i;

export function claimsIn(src: string, file = '(fixture)', css = false): Claim[] {
  const out: Claim[] = [];
  for (const para of paragraphs(src, css)) {
    if (HISTORICAL.test(para.lines[0])) continue;

    const table = tableClaims(para, file);
    out.push(...table.claims.filter((c) => !HISTORICAL.test(para.lines[c.line - para.start])));

    const kept = para.lines.map((l, idx) => (table.consumed.has(idx) ? ' '.repeat(l.length) : l));
    const text = kept.join('\n');
    const lineAt = (pos: number) => para.start + text.slice(0, pos).split('\n').length - 1;

    const hits = [...text.matchAll(new RegExp(TOK, 'gi'))].map((m) => ({
      name: m[1],
      index: m.index!,
      ground: AS_GROUND.test(text.slice(Math.max(0, m.index! - GROUND_LOOKBACK), m.index!)),
    }));
    const pairs = [...text.matchAll(GROUND_PAIR)].map((m) => ({ index: m.index!, pair: [m[1], m[2]] as [string, string] }));
    const ctx: Ctx = {
      text,
      fgAt: (pos) => [...hits].reverse().find((h) => h.index < pos && !h.ground)?.name ?? null,
      bgAt: (pos) => [...hits].reverse().find((h) => h.index < pos && h.ground)?.name ?? null,
      groundPair: (pos) => [...pairs].reverse().find((p) => p.index < pos)?.pair ?? null,
    };

    const taken = new Array<boolean>(text.length).fill(false);
    for (const pattern of PATTERNS) {
      pattern.re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = pattern.re.exec(text)) !== null) {
        const [from, to] = [m.index, m.index + m[0].length];
        if (m[0].length === 0) break;
        if (taken.slice(from, to).some(Boolean)) continue;
        // "3.97 -> 4.08" writes the superseded figure inline; the arrow says so and needs no marker.
        if (/^\s*(?:->|→)/.test(text.slice(to, to + 4))) continue;
        const line = lineAt(from);
        if (HISTORICAL.test(para.lines[line - para.start])) continue;
        const built = pattern.build(m, ctx);
        if (!built) continue;
        for (let k = from; k < to; k += 1) taken[k] = true;
        for (const c of built) {
          out.push({ ...c, file, line, shape: pattern.name, quote: m[0].replace(/\s+/g, ' ').trim() });
        }
      }
    }
  }
  // Stable, so a table row's cells stay in the order the row prints them.
  return out.sort((a, b) => a.line - b.line);
}

/** Ratio-shaped figures in comments that no pattern claimed, so the blind spots are visible. */
export function unparsedFigures(src: string, css = false): number {
  let total = 0;
  for (const para of paragraphs(src, css)) {
    const text = para.lines.join('\n');
    total += [...text.matchAll(/(?<![\w.\d])\d{1,2}\.\d{2}(?!\d)\s*(?::1|\/\s*\d{1,2}\.\d{2})/g)].length;
  }
  return total;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|tsx|css)$/.test(p)) out.push(p);
  }
  return out.sort();
}

interface Checked extends Claim {
  real: number;
  ok: boolean;
  alt: number | null;
}

const TOLERANCE = 0.01;

function check(claim: Claim): Checked {
  if (claim.theme) {
    const real = ratioOf(claim.fg, claim.bg, claim.theme);
    return { ...claim, real, alt: null, ok: Math.abs(real - claim.claimed) <= TOLERANCE };
  }
  // The prose does not say which theme, so the strongest honest reading is that SOME theme measures
  // it. Both are reported when neither does.
  const [light, dark] = [ratioOf(claim.fg, claim.bg, 'light'), ratioOf(claim.fg, claim.bg, 'dark')];
  const ok = Math.abs(light - claim.claimed) <= TOLERANCE || Math.abs(dark - claim.claimed) <= TOLERANCE;
  return { ...claim, real: light, alt: dark, ok };
}

function collect(): Checked[] {
  const out: Checked[] = [];
  for (const path of sourceFiles(SRC)) {
    const file = relative(SRC, path).split(sep).join('/');
    const src = readFileSync(path, 'utf8');
    for (const claim of claimsIn(src, file, path.endsWith('.css'))) out.push(check(claim));
  }
  return out;
}

/* ── the detector, on cases whose answer is known ─────────────────────────── */

test('HEALTHY: prose with no ratio in it is not a claim', () => {
  const src = `
    /* A rule, because Settings is a different kind of destination. The border carries the chip and
       the text carries the contrast, as well as the weight. */
    export const A = 1;`;
  assert.deepEqual(claimsIn(src), []);
});

test('HEALTHY: a threshold is not a measurement', () => {
  // "needs 3:1", "4.5:1 is the bar" and an L* figure are all numbers beside token names, and none of
  // them is a claim about what two triplets measure.
  const src = `
    /* A bar fill is a component under WCAG 1.4.11 and needs 3:1 against \`track\`; \`text-rule\` is
       11px, so 4.5:1 is the bar. \`card\` sits at L* 98.3 and \`line-2\` at 60.2. */
    export const A = 1;`;
  assert.deepEqual(claimsIn(src), []);
});

test('HEALTHY: a class string that mentions tokens is not a comment', () => {
  const src = "const P = `text-muted bg-rail ${x ? 'text-clay' : 'text-ink'} 4.50`;";
  assert.deepEqual(claimsIn(src), []);
});

test('a stated pair is parsed with both themes and checked against the palette', () => {
  const src = '/* `muted` on `rail`, 6.67:1 light / 7.38:1 dark. */';
  const found = claimsIn(src).map((c) => [c.fg, c.bg, c.theme, c.claimed]);
  assert.deepEqual(found, [
    ['muted', 'rail', 'light', 6.67],
    ['muted', 'rail', 'dark', 7.38],
  ]);
  assert.ok(found.every((_, i) => check(claimsIn(src)[i]).ok), 'the shipped figures for muted on rail no longer hold');
});

test('a stale figure fails, and the failure names the real value', () => {
  // Deliberately wrong figures. A previous mechanical re-derivation "fixed" this fixture and
  // quietly turned the test that proves staleness is caught into a test that proves nothing.
  const src = '/* `muted` on `rail` is 3.67:1 light and 3.99:1 dark. */';
  const checked = claimsIn(src).map(check);
  assert.equal(checked.length, 2);
  assert.ok(checked.every((c) => !c.ok));
  assert.equal(Number(checked[0].real.toFixed(2)), 6.67);
});

test('the light / dark convention is applied to a bare pair, not guessed per figure', () => {
  const src = '/*   clay on pill-bg            5.70 /  6.99   the "Reconnect" pill */';
  const checked = claimsIn(src).map(check);
  assert.deepEqual(checked.map((c) => c.theme), ['light', 'dark']);
  assert.ok(checked.every((c) => c.ok), 'clay on pill-bg moved');
});

test('an unthemed figure is held to matching at least one theme, which is all the prose says', () => {
  // `card` on `paper` is 1.05 light and 1.10 dark, and the sentence names neither.
  assert.ok(claimsIn('/* `card` on `paper` measures 1.05:1. */').map(check)[0].ok);
  assert.ok(claimsIn('/* `card` on `paper` measures 1.10:1. */').map(check)[0].ok);
  assert.ok(!claimsIn('/* `card` on `paper` measures 1.20:1. */').map(check)[0].ok);
});

test('a ground is carried within a paragraph and dropped at the paragraph break', () => {
  const carried = claimsIn(`
    /* Both columns need 3:1 against the paper they sit on: \`muted\` reads 7.01:1 light and 7.76:1
       dark, \`sage-deep\` 4.87:1 and 6.89:1. */`);
  assert.deepEqual(
    carried.map((c) => [c.fg, c.bg, c.theme, c.claimed]),
    [
      ['muted', 'paper', 'light', 7.01],
      ['muted', 'paper', 'dark', 7.76],
      ['sage-deep', 'paper', 'light', 4.87],
      ['sage-deep', 'paper', 'dark', 6.89],
    ]
  );
  assert.ok(carried.map(check).every((c) => c.ok));

  // The same list, one paragraph below the ground it was about, claims nothing.
  const dropped = claimsIn(`
    /* Both columns need 3:1 against the paper they sit on.
     *
     * \`sage-deep\` 5.16:1 and 6.20:1.
     */`);
  assert.deepEqual(dropped, []);
});

test('HEALTHY: a composite through a veil has no subject, so it is not read as a token pair', () => {
  // Two real shapes that must stay unparsed: an `opacity-*` composite, and a token named only as
  // "the second". Both are ratios; neither says which two triplets produced it.
  const veil = claimsIn(`
    // A skipped row used to be the whole row at \`opacity-50\`, which took the amount to 2.26:1 on
    // light paper and 2.86:1 on dark card.`);
  assert.deepEqual(veil, []);

  const pronoun = claimsIn('/* `text-muted`, not `text-muted-2`: on `rail` the second reads 3.67:1 in light. */');
  assert.deepEqual(pronoun, []);
});

test('a figure the source marks [historical] is not held to the current palette', () => {
  // Figures that are NOT the current ones, which is the whole premise: the marker has to be what
  // exempts the sentence, not the sentence happening to be true. The Jade & Ink palette landed on
  // 5.63 / 6.71 for this exact pair, which is what the fixture used to say, so it was silently
  // testing nothing until this was changed.
  const marked = '/* `muted-2` on `rail` read 4.21:1 light and 5.02:1 dark before 2026-08-01 [historical] */';
  assert.deepEqual(claimsIn(marked), []);
  // Without the marker the same sentence is a live claim and fails, so the marker is doing the work
  // rather than the shape of the sentence.
  const bare = marked.replace(' [historical]', '');
  assert.equal(claimsIn(bare).length, 2);
  assert.ok(claimsIn(bare).map(check).every((c) => !c.ok));
});

test('[historical] on a paragraph opener exempts the paragraph', () => {
  const src = `
    /* [historical] What the previous triplets measured, kept as the record of what the defect cost:
     *   \`muted-2\` on \`rail\`   3.67 / 4.11
     *   \`sage-deep\` on \`rail\` 3.99 / 5.02
     */`;
  assert.deepEqual(claimsIn(src), []);
});

test('a superseded figure written with an arrow needs no marker', () => {
  const src = '/* `gold` on `pill-bg` went 3.97 -> 4.08 on light. */';
  assert.deepEqual(claimsIn(src), []);
});

test('an aligned table is read by column, and a dash is not a figure', () => {
  const src = `
    /* MEASURED CONTRAST
     *
     *                        LIGHT              DARK
     *                     paper   card       paper   card
     *   ink              16.91   17.74      16.57   15.08
     *   sage                -     4.13         -     4.82
     *   pill-text on sage-tint  4.91                 6.45
     */`;
  const checked = claimsIn(src).map(check);
  assert.deepEqual(
    checked.map((c) => [c.fgName, c.bgName, c.theme, c.claimed]),
    [
      ['ink', 'paper', 'light', 16.91],
      ['ink', 'card', 'light', 17.74],
      ['ink', 'paper', 'dark', 16.57],
      ['ink', 'card', 'dark', 15.08],
      ['sage', 'card', 'light', 4.13],
      ['sage', 'card', 'dark', 4.82],
      ['pill-text', 'sage-tint', 'light', 4.91],
      ['pill-text', 'sage-tint', 'dark', 6.45],
    ]
  );
  assert.ok(checked.every((c) => c.ok), 'a hand-computed table row disagrees with the palette');
});

/* ── coverage, and the standing check ─────────────────────────────────────── */

test('the walker still sees the claims this repo writes', () => {
  const all = collect();
  const files = new Set(all.map((c) => c.file));

  // A floor, not a target. Fixing a figure keeps it, and deleting prose is sometimes the right fix,
  // so an exact count would fail on honest edits. What the floor has to stop is the other way out:
  // deleting the failing claims until the file passes. On 2026-08-01 the walk read 162 claims of
  // which 85 disagreed with the palette, so deleting every failure leaves 77. Anything at or above
  // that count and below 162 makes "delete the failures" a failure in itself; 100 is that, with
  // room for real pruning. Re-derive both numbers from the coverage report before moving it.
  assert.ok(all.length >= 100, `only ${all.length} contrast claims parsed; the walker has gone blind`);
  assert.ok(files.size >= 10, `claims found in only ${files.size} files (${[...files].join(', ')})`);
  // The three files that already pin their own figures must still be inside the walk, because they
  // are the proof that the shapes this understands are the shapes the repo writes.
  for (const f of ['index.css', 'components/balance/Card.tsx', 'views/accounts/Accounts.tsx']) {
    assert.ok(files.has(f), `${f} carries no parsed claim any more`);
  }
});

test('every contrast figure stated in a comment is the figure the palette produces', () => {
  const all = collect();
  const bad = all.filter((c) => !c.ok);

  const byFile = new Map<string, Checked[]>();
  for (const c of bad) byFile.set(c.file, [...(byFile.get(c.file) ?? []), c]);

  const report = [...byFile.entries()]
    .map(([file, rows]) => {
      const lines = rows.map((r) => {
        const real =
          r.theme === null
            ? `light ${r.real.toFixed(2)} / dark ${(r.alt ?? 0).toFixed(2)}`
            : `${r.theme} ${r.real.toFixed(2)}`;
        return (
          `  ${file}:${r.line}  ${r.fgName} on ${r.bgName} ` +
          `[${r.theme ?? 'unspecified'}] claims ${r.claimed.toFixed(2)}, palette measures ${real}\n` +
          `      via ${r.shape}: "${r.quote}"`
        );
      });
      return `${file}  (${rows.length})\n${lines.join('\n')}`;
    })
    .join('\n\n');

  assert.equal(
    bad.length,
    0,
    `${bad.length} of ${all.length} contrast claims under client/src no longer match the palette.\n` +
      'Re-derive each from client/src/index.css, or mark it [historical] if it is deliberately a\n' +
      'record of a past state.\n\n' +
      report
  );
});

test('COVERAGE: what the walker found, and what it could not read', () => {
  const all = collect();
  const rows = new Map<string, { parsed: number; unparsed: number }>();
  for (const path of sourceFiles(SRC)) {
    const file = relative(SRC, path).split(sep).join('/');
    const unparsed = unparsedFigures(readFileSync(path, 'utf8'), path.endsWith('.css'));
    const parsed = all.filter((c) => c.file === file).length;
    if (parsed + unparsed > 0) rows.set(file, { parsed, unparsed });
  }
  const printed = [...rows.entries()]
    .sort((a, b) => b[1].parsed - a[1].parsed || a[0].localeCompare(b[0]))
    .map(([file, r]) => `  ${String(r.parsed).padStart(3)} checked, ${String(r.unparsed).padStart(3)} figures unread  ${file}`);
  console.log(
    `\ncontrast claims under client/src: ${all.length} checked across ${rows.size} files\n${printed.join('\n')}\n`
  );

  // How to audit a suspected misparse without editing this file:
  //   MIZAN_CONTRAST_CLAIMS=all node --test --import tsx tests/contrastClaims.test.ts
  if (process.env.MIZAN_CONTRAST_CLAIMS === 'all') {
    for (const c of all) {
      console.log(
        `${c.ok ? 'ok  ' : 'STALE'} ${c.file}:${c.line}  ${c.fgName} on ${c.bgName} ` +
          `[${c.theme ?? 'unspecified'}] ${c.claimed.toFixed(2)}  <- ${c.shape}  "${c.quote}"`
      );
    }
  }

  // Unread figures are not a failure: many are composites, thresholds or subjects carried by a
  // pronoun. What would be a failure is the walker reading nothing while the tree is full of them.
  assert.ok(all.length > 0);
});
