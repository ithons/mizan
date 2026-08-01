import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * What is actually set on `rail`, everywhere, measured rather than asserted.
 *
 * `index.css` used to say of `rail`: "Only two tones clear AA on it, and only those two may be set
 * on it". The first half is arithmetic and was right. The second half was a claim about the whole
 * app that nothing checked and that shipping code broke in nine places, including inside the very
 * call site the same sentence enumerated (the selected row in the sync panel, whose status label
 * takes its colour from `statusTone` and lands on sage-deep, gold or clay). The two tests that were
 * named as enforcing it read one component's source and one view's source; neither could see any
 * of the nine.
 *
 * So this file walks instead of trusting. Every `bg-rail` under `client/src`, the element it grounds
 * and the tones inside it, with descendants that declare a ground of their own left out. The
 * allowance is derived from the palette, not typed in; the exceptions are named individually, so a
 * tenth fails here and a fix that clears one has to delete its line.
 */

const ROOT = join(import.meta.dirname, '..');
const SRC = join(ROOT, 'client/src');
const CSS = readFileSync(join(SRC, 'index.css'), 'utf8');
const TW = readFileSync(join(ROOT, 'tailwind.config.js'), 'utf8');

type Theme = 'light' | 'dark';

function triplet(name: string, theme: Theme): [number, number, number] {
  const all = [...CSS.matchAll(new RegExp(`--mz-${name}-c:\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)\\s*;`, 'g'))];
  assert.ok(all.length > 0, `--mz-${name}-c is not declared in index.css`);
  const m = theme === 'light' ? all[0] : all[all.length - 1];
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function luminanceOf([r, g, b]: [number, number, number]): number {
  const ch = (c: number) => (c / 255 <= 0.03928 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

function ratio(fg: string, bg: string, theme: Theme): number {
  const [a, b] = [luminanceOf(triplet(fg, theme)), luminanceOf(triplet(bg, theme))];
  return Number((((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05))).toFixed(2));
}

/**
 * Tailwind text utility to palette token. The two families do not share a spelling (`text-sage-text`
 * is `--mz-pill-text-c`), and the legacy aliases resolve onto tokens that already exist, so this
 * cannot be string surgery. Anything a rail subtree carries that is in neither this map nor the type
 * steps fails the walk rather than being skipped.
 */
const TEXT_TOKEN: Record<string, string> = {
  ink: 'ink',
  'ink-soft': 'ink-soft',
  muted: 'muted',
  'muted-2': 'muted-2',
  faint: 'faint',
  estimate: 'estimate',
  clay: 'clay',
  'clay-scale': 'clay-scale',
  gold: 'gold',
  sage: 'sage',
  'sage-deep': 'sage-deep',
  'sage-soft': 'sage-soft',
  'sage-text': 'pill-text',
  'review-text': 'review-text',
  paper: 'paper',
  rail: 'rail',
  card: 'card',
  tan: 'tan',
  info: 'info',
  // Legacy aliases (`--color-*` in index.css), each pointing at a token declared above it.
  warning: 'gold',
  negative: 'clay',
  positive: 'sage-deep',
};

/** `text-body-lg` and `text-left` are not colours. Steps come from the config, not from memory. */
const TYPE_STEPS = new Set([
  ...[...TW.matchAll(/^\s{8}'?([a-z-]+)'?:\s*\['?\d/gm)].map((m) => m[1]),
  'left', 'right', 'center', 'justify', 'start', 'end',
  'wrap', 'nowrap', 'balance', 'pretty', 'clip', 'ellipsis',
]);

/* ── The walk ─────────────────────────────────────────────────────────────── */

export interface RailSite {
  file: string;
  line: number;
  tag: string;
  /** `text-<token>` set inside the element and not inside a descendant with its own ground. */
  tones: string[];
  /** The element sets a colour through a `style` prop, so the tone is not in the class string. */
  indirect: boolean;
}

/** Blank comments out in place, so prose ABOUT a token is never counted as a call site. */
function stripComments(src: string): string {
  const out = src.split('');
  const blank = (a: number, b: number) => {
    for (let i = a; i < b; i++) if (out[i] !== '\n') out[i] = ' ';
  };
  for (const m of src.matchAll(/\/\*[\s\S]*?\*\//g)) blank(m.index!, m.index! + m[0].length);
  for (const m of src.matchAll(/^[ \t]*\/\/[^\n]*/gm)) blank(m.index!, m.index! + m[0].length);
  return out.join('');
}

/** End of an opening tag: the first `>` outside a `{...}` expression. */
function openingTagEnd(src: string, from: number): number {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0) return i;
  }
  return -1;
}

function elementRange(src: string, at: number): { tag: string; from: number; to: number } | null {
  let start = -1;
  for (let i = at; i >= 0; i--) {
    if (src[i] === '<' && /[A-Za-z]/.test(src[i + 1] ?? '')) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  const tag = /^<([A-Za-z][\w.]*)/.exec(src.slice(start))?.[1];
  if (!tag) return null;
  const end = openingTagEnd(src, start + 1 + tag.length);
  // `at` past the opening tag means the match was in a plain string, not in an attribute.
  if (end < 0 || at > end) return null;
  if (src[end - 1] === '/') return { tag, from: start, to: end + 1 };

  const esc = tag.replace('.', '\\.');
  let depth = 1;
  let i = end + 1;
  while (i < src.length) {
    const open = new RegExp(`<${esc}[\\s/>]`, 'g');
    const close = new RegExp(`</${esc}\\s*>`, 'g');
    open.lastIndex = i;
    close.lastIndex = i;
    const o = open.exec(src);
    const c = close.exec(src);
    if (!c) break;
    if (o && o.index < c.index) {
      depth++;
      i = o.index + 1;
      continue;
    }
    depth--;
    i = c.index + 1;
    if (depth === 0) return { tag, from: start, to: c.index + c[0].length };
  }
  return { tag, from: start, to: src.length };
}

export function scanRailGrounds(raw: string, file = '(fixture)'): RailSite[] {
  const src = stripComments(raw);
  const sites: RailSite[] = [];
  for (const m of src.matchAll(/bg-rail\b/g)) {
    const at = m.index!;
    const line = src.slice(0, at).split('\n').length;
    const el = elementRange(src, at);
    if (!el) {
      // A class string that is not attached to a tag here (AskPanel's prose block). It has no
      // subtree to read, so it is reported with no tones and has to be accounted for by name.
      sites.push({ file, line, tag: '(class string)', tones: [], indirect: false });
      continue;
    }
    let sub = src.slice(el.from, el.to);
    const railAt = sub.indexOf('bg-rail');
    for (const g of [...sub.matchAll(/\bbg-[a-z0-9-]+/g)]) {
      if (g.index === railAt) continue;
      const nested = elementRange(src, el.from + g.index!);
      if (!nested || nested.from <= el.from) continue;
      // A descendant that declares its own `bg-` stands on that ground, not on rail.
      const [a, b] = [nested.from - el.from, nested.to - el.from];
      sub = sub.slice(0, a) + ' '.repeat(b - a) + sub.slice(b);
    }
    const named = [...new Set([...sub.matchAll(/\btext-([a-z0-9-]+)\b/g)].map((x) => x[1]))];
    for (const name of named) {
      assert.ok(
        name in TEXT_TOKEN || TYPE_STEPS.has(name),
        `${file}:${line} sets text-${name} on rail, which is neither a palette token nor a type step`
      );
    }
    sites.push({
      file,
      line,
      tag: el.tag,
      tones: named.filter((n) => n in TEXT_TOKEN).sort(),
      indirect: /style=\{\{[^}]*\bcolor:/.test(sub),
    });
  }
  return sites;
}

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...tsxFiles(p));
    else if (p.endsWith('.tsx')) out.push(p);
  }
  return out.sort();
}

function allSites(): RailSite[] {
  return tsxFiles(SRC).flatMap((f) => scanRailGrounds(readFileSync(f, 'utf8'), f.slice(SRC.length + 1)));
}

/* ── The allowance, derived ───────────────────────────────────────────────── */

/** Not a list: the tones that clear 4.5:1 on `rail` in BOTH themes, computed from the palette. */
function allowedOnRail(): string[] {
  return Object.keys(TEXT_TOKEN)
    .filter((name) => ratio(TEXT_TOKEN[name], 'rail', 'light') >= 4.5 && ratio(TEXT_TOKEN[name], 'rail', 'dark') >= 4.5)
    .sort();
}

/**
 * Every call site that sets a tone `rail` cannot carry on the light theme, by file and by tone.
 *
 * This is a record of what ships, not a permission slip. Each entry is a real AA failure at 11.5px
 * to 13.5px; the fix in every case is either a different ground (what the accounts list did) or a
 * tone off the allowance. Clearing one means deleting its line here, which this file requires.
 */
const RECORDED_SUB_AA: Record<string, string[]> = {
  // The selected run row sets its status label with `style={{ color: tone.color }}`, and
  // `statusTone` resolves to sage-deep, gold or clay for three of its four states; the `Issue`
  // panel inside a run's detail sets `text-clay` on a rail card.
  'components/SyncActivityPanel.tsx': ['clay'],
  // The memory editor and the composer, both `text-muted-2` for the hint line and `text-warning`
  // (gold) for the error line.
  'views/settings/AdvisorMemorySection.tsx': ['muted-2', 'warning'],
  // The CSV preview grid and the backup preview grid: sage-deep for valid, clay for invalid, gold
  // for duplicates. Four rail cards, three sub-AA tones between them.
  'views/settings/DataSection.tsx': ['clay', 'gold', 'sage-deep'],
  // The selected model's caching note.
  'views/settings/Settings.tsx': ['muted-2'],
};

/** Sites whose colour is set through a `style` prop, where the class string cannot show it. */
const RECORDED_INDIRECT: Record<string, string[]> = {
  'components/SyncActivityPanel.tsx': ['muted', 'sage-deep', 'gold', 'clay'],
};

/* ── The detector, on cases whose answer is known ─────────────────────────── */

test('HEALTHY: a rail element carrying only allowed tones reports nothing', () => {
  const src = `
    export function A() {
      return (
        <div className="rounded-lg bg-rail p-3">
          <p className="text-note text-ink">Owed</p>
          <p className="text-body text-muted">Chase</p>
        </div>
      );
    }`;
  assert.deepEqual(scanRailGrounds(src)[0].tones, ['ink', 'muted']);
  for (const tone of scanRailGrounds(src)[0].tones) assert.ok(allowedOnRail().includes(tone));
});

test('a sub-AA tone inside a rail element is reported', () => {
  const src = `<div className="bg-rail p-3"><p className="text-note text-clay">Issue</p></div>`;
  assert.deepEqual(scanRailGrounds(src)[0].tones, ['clay']);
  assert.ok(!allowedOnRail().includes('clay'));
});

test('HEALTHY: a descendant with its own ground is not standing on rail', () => {
  // NavRail's wordmark badge is `bg-ink text-paper` inside the `bg-rail` nav. Reading `text-paper`
  // as a tone on rail would report 1.23:1 and be wrong about which ground it sits on.
  const src = `
    <nav className="bg-rail py-6">
      <span className="bg-ink text-body-lg text-paper">M</span>
      <a className="text-body text-ink">Balance</a>
    </nav>`;
  assert.deepEqual(scanRailGrounds(src)[0].tones, ['ink']);
});

test('HEALTHY: prose about rail is not a call site', () => {
  const src = `
    /* It was \`bg-rail\` and set \`text-clay\` on it. */
    // bg-rail text-sage-deep
    export const NOTE = 1;`;
  assert.deepEqual(scanRailGrounds(src), []);
});

test('a colour set through a style prop is flagged rather than read as absent', () => {
  const src = `<button className="bg-rail"><span style={{ color: tone.color }}>Partial</span></button>`;
  const [site] = scanRailGrounds(src);
  assert.deepEqual(site.tones, []);
  assert.equal(site.indirect, true, 'an indirect colour must not read as a clean element');
});

/* ── The allowance, and the ledger of what breaks it ──────────────────────── */

test('the allowance is what the palette says it is, in both themes', () => {
  assert.deepEqual(allowedOnRail(), ['estimate', 'ink', 'ink-soft', 'muted']);
  const printed: Array<[string, number, number]> = [
    ['ink', 9.45, 14.6],
    ['ink-soft', 6.13, 10.2],
    ['muted', 4.6, 7.6],
    ['estimate', 5.32, 8.9],
    ['muted-2', 3.67, 6.46],
    ['sage-deep', 3.99, 9.18],
    ['clay', 4.43, 6.68],
    ['gold', 3.71, 8.1],
  ];
  for (const [tone, light, dark] of printed) {
    assert.equal(ratio(TEXT_TOKEN[tone], 'rail', 'light'), light, `${tone} on rail, light`);
    assert.equal(ratio(TEXT_TOKEN[tone], 'rail', 'dark'), dark, `${tone} on rail, dark`);
    const shown = `${tone} ${light.toFixed(2)} / ${dark.toFixed(2)}`.replace(/[./]/g, (c) => `\\${c}`);
    assert.match(CSS, new RegExp(shown.replace(/ /g, '\\s*')), `${tone} on rail is not stated in index.css`);
  }
});

test('every tone on every rail ground is allowed or is one of the recorded exceptions', () => {
  const allowed = allowedOnRail();
  for (const site of allSites()) {
    const recorded = RECORDED_SUB_AA[site.file] ?? [];
    for (const tone of site.tones) {
      assert.ok(
        allowed.includes(tone) || recorded.includes(tone),
        `${site.file}:${site.line} sets text-${tone} on rail ` +
          `(${ratio(TEXT_TOKEN[tone], 'rail', 'light')} light / ${ratio(TEXT_TOKEN[tone], 'rail', 'dark')} dark). ` +
          `Use one of ${allowed.join(', ')}, change the ground, or record it in RECORDED_SUB_AA.`
      );
    }
    if (site.indirect) {
      assert.ok(
        site.file in RECORDED_INDIRECT,
        `${site.file}:${site.line} sets a colour on rail through a style prop and is not recorded`
      );
    }
  }
});

test('no recorded exception is stale: each one is still set on a rail ground in its file', () => {
  const found = new Map<string, Set<string>>();
  for (const site of allSites()) {
    if (!found.has(site.file)) found.set(site.file, new Set());
    for (const tone of site.tones) found.get(site.file)!.add(tone);
  }
  for (const [file, tones] of Object.entries(RECORDED_SUB_AA)) {
    for (const tone of tones) {
      assert.ok(
        found.get(file)?.has(tone),
        `${file} no longer sets text-${tone} on rail. Delete it from RECORDED_SUB_AA.`
      );
    }
  }
  for (const file of Object.keys(RECORDED_INDIRECT)) {
    assert.ok(allSites().some((s) => s.file === file && s.indirect), `${file} no longer sets a rail colour indirectly`);
  }
});

test('the indirect site resolves to the tones it is recorded with, not to a guess', () => {
  const src = readFileSync(join(SRC, 'components/SyncActivityPanel.tsx'), 'utf8');
  const block = src.slice(src.indexOf('const statusTone'), src.indexOf('satisfies Record<SyncRunStatus'));
  const tokens = [...new Set([...block.matchAll(/var\(--mz-([a-z0-9-]+)\)/g)].map((m) => m[1]))];
  assert.deepEqual(tokens.sort(), ['clay', 'gold', 'muted', 'sage-deep']);
  assert.deepEqual([...RECORDED_INDIRECT['components/SyncActivityPanel.tsx']].sort(), tokens.sort());
  // Three of the four are under AA on a light rail, which is the whole reason the old universal
  // claim was false at the call site its own sentence named.
  const under = tokens.filter((t) => ratio(t, 'rail', 'light') < 4.5);
  assert.deepEqual(under.sort(), ['clay', 'gold', 'sage-deep']);
});

test('index.css states the inventory it now claims, and no longer states the universal it broke', () => {
  const sites = allSites();
  const offenders = new Set<string>();
  for (const site of sites) {
    if (site.tones.some((t) => !allowedOnRail().includes(t)) || site.indirect) offenders.add(`${site.file}:${site.line}`);
  }
  // The total is a dated reading and a new `bg-rail text-ink` is not a defect, so only a floor is
  // held on it. The nine is the number the paragraph rests on, and it is exact: a tenth means the
  // sentence is wrong, and that is the failure this file exists to produce.
  assert.ok(sites.length >= 20, `only ${sites.length} bg-rail call sites; re-derive the dated figure in index.css`);
  assert.equal(offenders.size, 9, 'the number of sub-AA rail sites moved; re-derive the figure in index.css');
  assert.match(CSS, /22 call\s*\n?\s*\*?\s*sites that day, and 9 OF THEM set one of those four on a light rail/);
  assert.doesNotMatch(CSS, /only those\s*\n?\s*\*?\s*two may be set on it/);
  // `rail` was called a bar track; the bar track is its own token and always was.
  assert.doesNotMatch(CSS, /an input well and a bar track/);
  const bar = readFileSync(join(SRC, 'components/balance/ProgressBar.tsx'), 'utf8');
  assert.ok(bar.includes('bg-track'), 'ProgressBar no longer uses track');
  assert.ok(!bar.includes('bg-rail'), 'ProgressBar now grounds a bar on rail');
});

test('pill-bg is stated as what it measures, not implied to be clean', () => {
  assert.equal(ratio('muted-2', 'pill-muted-bg', 'light'), 3.92);
  assert.equal(ratio('muted-2', 'pill-muted-bg', 'dark'), 4.77);
  assert.equal(ratio('sage-deep', 'pill-muted-bg', 'light'), 4.27);
  assert.equal(ratio('sage-deep', 'pill-muted-bg', 'dark'), 6.78);
  assert.equal(ratio('clay', 'pill-muted-bg', 'light'), 4.74);
  assert.equal(ratio('muted', 'pill-muted-bg', 'light'), 4.92);
  assert.match(CSS, /`muted-2` is 3\.92 \/ 4\.77/);
  assert.match(CSS, /`sage-deep` 4\.27 \/ 6\.78/);
  // The two call sites the figures are about, so the sentence cannot outlive them.
  const pill = readFileSync(join(SRC, 'components/balance/CategoryPill.tsx'), 'utf8');
  assert.match(pill, /bg-pill-bg text-muted-2/);
  const cats = readFileSync(join(SRC, 'views/settings/CategoriesSection.tsx'), 'utf8');
  assert.match(cats, /bg-pill-bg/);
  assert.match(cats, /tone === 'sage' \? 'text-sage-deep'/);
});
