import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The account row's grounds, and every tone it sets on them.
 *
 * The defect: the selected row was filled with `rail` and then carried a money numeral, a
 * secondary line and a caption on it. `rail` is chrome in this palette (the navigation's own fill,
 * a track, a code chip, an input well); `index.css` said so and `NavRail.tsx` measures against it
 * for exactly that reason. On the light theme three of the five tones the row can carry were below
 * AA on it, two of them money.
 *
 * Nothing here is a hand-copied list. The tones and the grounds are read out of `Accounts.tsx`, and
 * every ratio is recomputed from the triplets in `index.css`, so a tone added to the row or a token
 * moved in the palette fails this file rather than shipping.
 */

const ROOT = join(import.meta.dirname, '..');
const CSS = readFileSync(join(ROOT, 'client/src/index.css'), 'utf8');
const SOURCE = readFileSync(join(ROOT, 'client/src/views/accounts/Accounts.tsx'), 'utf8');
/** The docstrings with their line furniture out of the way, so a claim can be matched as a sentence. */
const PROSE = SOURCE.replace(/\n\s*\*\/?\s?/g, ' ');
/** The other half: source with block comments gone, so prose about a call site is not counted as one. */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '');

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
 * Tailwind utility name to palette token. `bg-pill-bg` is `--mz-pill-muted-bg-c`, so the utility
 * name alone cannot be turned into a token by string surgery; anything not in here is a name this
 * file has never measured and must fail loudly rather than be skipped.
 */
const TOKEN_OF: Record<string, string> = {
  paper: 'paper',
  rail: 'rail',
  card: 'card',
  'card-alt': 'card-alt',
  'card-white': 'card-white',
  well: 'well',
  track: 'track',
  ink: 'ink',
  'ink-soft': 'ink-soft',
  muted: 'muted',
  'muted-2': 'muted-2',
  faint: 'faint',
  estimate: 'estimate',
  clay: 'clay',
  gold: 'gold',
  sage: 'sage',
  'sage-deep': 'sage-deep',
  'pill-bg': 'pill-muted-bg',
  'pill-border': 'pill-muted-border',
  'review-bg': 'review-bg',
  'review-border': 'review-border',
  'review-text': 'review-text',
};

function slice(from: string, to: string): string {
  const start = SOURCE.indexOf(from);
  assert.ok(start > 0, `${from} is gone; this file is measuring nothing`);
  const end = SOURCE.indexOf(to, start);
  assert.ok(end > start, `${from} no longer reaches ${to}`);
  return SOURCE.slice(start, end);
}

/**
 * Everything whose ink the ROW's own ground has to carry: the three money tones `balanceTone`
 * picks between, and the classes on the row's markup. `SyncBadge` is deliberately not in here,
 * because it sets a ground of its own; it is measured against that ground further down.
 */
function rowSource(): string {
  return slice('function balanceTone', '\n}') + slice('const renderRow =', '</Row>');
}

/** Every `text-<token>` in a region, ignoring the type-size steps, which are not colours. */
function tonesIn(region: string): string[] {
  const found = [...region.matchAll(/\btext-([a-z0-9-]+)/g)].map((m) => m[1]).filter((n) => n in TOKEN_OF);
  return [...new Set(found)].sort();
}

test('the row still carries the five tones this file measures, and no sixth', () => {
  // A sixth means every ratio below has to be re-derived, not silently skipped.
  assert.deepEqual(tonesIn(rowSource()), ['clay', 'ink', 'muted', 'muted-2', 'sage-deep']);
});

test('the ratios the row comment prints are the ratios the palette produces', () => {
  const expected: Array<[string, string, number, number]> = [
    // tone            ground   light   dark
    ['ink', 'rail', 9.45, 14.6],
    ['muted', 'rail', 4.6, 7.6],
    ['muted-2', 'rail', 3.67, 6.46],
    ['sage-deep', 'rail', 3.99, 9.18],
    ['clay', 'rail', 4.43, 6.68],
    ['ink', 'card', 14.46, 11.21],
    ['muted', 'card', 7.04, 5.84],
    ['muted-2', 'card', 5.61, 4.96],
    ['sage-deep', 'card', 6.11, 7.05],
    ['clay', 'card', 6.78, 5.13],
    ['ink', 'paper', 11.66, 13.34],
    ['muted', 'paper', 5.67, 6.95],
    ['muted-2', 'paper', 4.52, 5.9],
    ['sage-deep', 'paper', 4.93, 8.38],
    ['clay', 'paper', 5.47, 6.1],
  ];
  for (const [tone, ground, light, dark] of expected) {
    assert.equal(ratio(tone, ground, 'light'), light, `${tone} on ${ground}, light`);
    assert.equal(ratio(tone, ground, 'dark'), dark, `${tone} on ${ground}, dark`);
    const printed = `${light.toFixed(2)} / ${dark.toFixed(2)}`.replace(/\//g, '\\/').replace(/\./g, '\\.');
    assert.match(SOURCE, new RegExp(printed.replace(/ /g, '\\s*')), `${tone} on ${ground} is not stated in the file`);
  }
});

test('rail was the wrong ground for this row, which is why it is no longer used as one', () => {
  // The three that failed on light, and the reason the fix is a different ground rather than a
  // different colour: `clay` and `sage-deep` ARE the money tones, and `muted-2` is the line under
  // every account name.
  for (const tone of ['muted-2', 'sage-deep', 'clay']) {
    assert.ok(ratio(tone, 'rail', 'light') < 4.5, `${tone} on rail unexpectedly clears AA now`);
  }
  assert.ok(!/selectedId === a\.id \? 'bg-rail'/.test(SOURCE), 'the selected row fills with rail again');
});

test('the grounds are read off the row, so a new one cannot slip past this file', () => {
  const grounds = [...new Set([...slice('const renderRow =', '</Row>').matchAll(/\bbg-([a-z0-9-]+)/g)].map((m) => m[1]))];
  for (const ground of grounds) {
    assert.ok(ground in TOKEN_OF, `bg-${ground} is a ground this file has never measured`);
  }
  // `card` is the selected fill; `rail` is the 34px initial disc, which sets its own ground and is
  // measured for its own single tone below. `paper` is the screen under an unselected row and is
  // written nowhere in the row's classes, so it is added rather than derived.
  assert.deepEqual(grounds.sort(), ['card', 'rail']);
});

test('every tone the row carries clears AA on both grounds the row itself can rest on', () => {
  for (const ground of ['card', 'paper']) {
    for (const tone of tonesIn(rowSource())) {
      for (const theme of ['light', 'dark'] as const) {
        // 4.5:1 throughout: the numeral is `text-sub` and everything else in the row is smaller,
        // so no part of it qualifies for the large-text exemption.
        assert.ok(
          ratio(TOKEN_OF[tone], TOKEN_OF[ground], theme) >= 4.5,
          `text-${tone} on bg-${ground} is ${ratio(TOKEN_OF[tone], TOKEN_OF[ground], theme)}:1 in ${theme}`
        );
      }
    }
  }
});

test('the initial disc is the one place the row still sets rail, and it sets a tone rail can carry', () => {
  const disc = slice('bg-rail font-serif', '>');
  assert.deepEqual(tonesIn(disc), ['muted']);
  assert.ok(ratio('muted', 'rail', 'light') >= 4.5);
  assert.ok(ratio('muted', 'rail', 'dark') >= 4.5);
});

test('selection reads as an edge as well as a surface, because the surface step alone is 1.24:1', () => {
  assert.match(SOURCE, /selectedId === a\.id \? 'bg-card ring-1 ring-inset ring-sage'/);
  assert.equal(ratio('card', 'paper', 'light'), 1.24);
  assert.equal(ratio('card', 'paper', 'dark'), 1.19);
  // A non-text boundary needs 3:1, and the ring clears it in both themes.
  assert.ok(ratio('sage', 'card', 'light') >= 3, 'the selection edge is invisible on light');
  assert.ok(ratio('sage', 'card', 'dark') >= 3, 'the selection edge is invisible on dark');
  assert.equal(ratio('sage', 'card', 'light'), 4.85);
  assert.equal(ratio('sage', 'card', 'dark'), 5.85);
});

test('the sync badge is measured against its own ground, not against the row', () => {
  // It carries `bg-pill-bg` or `bg-review-bg`, so the row's ground never reaches its text.
  assert.equal(ratio('clay', 'pill-muted-bg', 'light'), 4.74);
  assert.equal(ratio('clay', 'pill-muted-bg', 'dark'), 4.93);
  // What the two caution pills used to be. `text-rule` is 11px, so 4.5:1 applies.
  assert.equal(ratio('gold', 'pill-muted-bg', 'light'), 3.97);
  assert.ok(ratio('gold', 'pill-muted-bg', 'light') < 4.5);
  assert.ok(
    !/bg-pill-bg[^'`]*\btext-gold\b|\btext-gold\b[^'`]*bg-pill-bg/.test(SOURCE.replace(/\/\*[\s\S]*?\*\//g, '')),
    'gold is back on the pill'
  );
  // Where they went: the pair the palette already declares for a caution state.
  assert.equal(ratio('review-text', 'review-bg', 'light'), 4.93);
  assert.equal(ratio('review-text', 'review-bg', 'dark'), 5.53);
  assert.match(SOURCE, /border-review-border bg-review-bg text-review-text/);
});

test('the review pair means an open question, which is what the badge note says it means', () => {
  // The pair is shared with the ledger, so the note has to be right about what it is shared WITH.
  // Two of its five call sites are AI copy; three are the ledger's own review state, and the one
  // state that is settled rather than open is deliberately outside it.
  const ROWS = readFileSync(join(ROOT, 'client/src/views/ledger/rows.tsx'), 'utf8');
  const LEDGER = readFileSync(join(ROOT, 'client/src/views/Ledger.tsx'), 'utf8');
  const SPINE = readFileSync(join(ROOT, 'client/src/views/ledger/spine.ts'), 'utf8');

  assert.match(ROWS, /flag === 'set_aside'\s*\n?\s*\? 'border border-line-3 text-muted'\s*\n?\s*: 'border border-review-border bg-review-bg text-review-text'/);
  assert.match(LEDGER, /filter === chip\.id \? 'bg-review-bg text-review-text'/);
  // The flags that DO land on the pair, read off the label map rather than typed in here.
  const labels = SPINE.slice(SPINE.indexOf('export const FLAG_LABEL'), SPINE.indexOf('};', SPINE.indexOf('export const FLAG_LABEL')));
  for (const flag of ['duplicate', 'transfer', 'pending']) {
    assert.ok(labels.includes(`${flag}:`), `${flag} is no longer a row flag`);
    assert.match(PROSE, new RegExp(`"${labels.match(new RegExp(`${flag}: '([^']+)'`))![1]}"`));
  }
  assert.match(PROSE, /`set_aside` deliberately does NOT take it/);
});

test('the badge note says why gold moved, and it is not "gold is fine elsewhere"', () => {
  // The sentence that used to sit here was "measures fine on every ground but this one". `pill-bg`
  // is the fourth ground it fails on light, not the only one, and `rail` is one of the other three
  // WITH a live `text-gold` call site on it. Every figure the note prints is recomputed here.
  const grounds: Array<[string, number]> = [
    ['rail', 3.71],
    ['track', 3.09],
    ['well', 4.07],
  ];
  for (const [ground, light] of grounds) {
    assert.equal(ratio('gold', ground, 'light'), light, `gold on ${ground}, light`);
    assert.ok(light < 4.5);
    assert.match(PROSE, new RegExp(`${light.toFixed(2).replace('.', '\\.')} on \`${ground}\``));
  }
  // And the two grounds where it does clear, so the note is not the opposite overstatement.
  assert.equal(ratio('gold', 'paper', 'light'), 4.57);
  assert.equal(ratio('gold', 'card', 'light'), 5.67);
});

test('the call-site count in the badge note is the count the tree has', () => {
  // It said "five other places" and was stale on arrival. Re-derived by walking the tree the same
  // way the note's own grep does, with block-comment prose excluded so this cannot count itself.
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.tsx') || p.endsWith('.ts')) files.push(p);
    }
  };
  walk(join(ROOT, 'client/src'));

  let gold = 0;
  let warning = 0;
  const modules = new Set<string>();
  for (const file of files) {
    const body = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const here = [...body.matchAll(/\btext-gold\b/g)].length;
    const there = [...body.matchAll(/\btext-warning\b/g)].length;
    gold += here;
    warning += there;
    if (here + there > 0) modules.add(file);
  }
  // The note states a DATED reading plus the command that produced it, because this figure moves
  // whenever a view is added and a bare integer in a comment would go stale in silence. What is
  // asserted is the shape the argument rests on: gold is an ink in many modules, not in one place.
  assert.ok(gold + warning >= 12, `gold is a text colour at ${gold + warning} call sites, which no longer supports the note`);
  assert.ok(modules.size >= 8, `gold is an ink in ${modules.size} modules; the note says eight`);
  assert.match(PROSE, /-> \d+ that day, being \d+ `text-gold` and \d+ `text-warning`/);
  assert.match(PROSE, /counted 2026-07-31 with/i);
  assert.match(PROSE, /grep -rnE 'text-\(gold\|warning\)' client\/src \| grep -vE ':\[0-9\]\+: \\\*'/);
  assert.match(PROSE, /gold is an ink across eight modules/);
});

test('pill-bg is not implied to be clean, because two other call sites still fail on it', () => {
  const CATEGORY_PILL = readFileSync(join(ROOT, 'client/src/components/balance/CategoryPill.tsx'), 'utf8');
  const CATEGORIES = readFileSync(join(ROOT, 'client/src/views/settings/CategoriesSection.tsx'), 'utf8');

  assert.equal(ratio('muted-2', 'pill-muted-bg', 'light'), 3.92);
  assert.equal(ratio('muted-2', 'pill-muted-bg', 'dark'), 4.77);
  assert.equal(ratio('sage-deep', 'pill-muted-bg', 'light'), 4.27);
  assert.equal(ratio('sage-deep', 'pill-muted-bg', 'dark'), 6.78);
  // Both are `text-micro`, 11.5px in tailwind.config.js, so no large-text exemption reaches them.
  assert.match(CATEGORY_PILL, /text-micro[\s\S]{0,200}bg-pill-bg text-muted-2/);
  assert.match(CATEGORIES, /bg-pill-bg[^`]*text-micro/);
  assert.match(CATEGORIES, /tone === 'sage' \? 'text-sage-deep'/);
  // Stated on the badge note with the numbers, rather than left to read as cleared.
  assert.match(PROSE, /`text-muted-2` +3\.92 \/ 4\.77/);
  assert.match(PROSE, /`text-sage-deep` +4\.27 \/ 6\.78/);
});

test('the veil on a closed or hidden row is recorded, not claimed to be fine', () => {
  // `opacity-55` composites the tone against whatever is under it. Nothing in the row survives it,
  // and no smaller veil would: `muted-2` on `paper` is 4.52 at full strength.
  const composite = (fg: string, bg: string, alpha: number): [number, number, number] => {
    const [f, b] = [triplet(fg, 'light'), triplet(bg, 'light')];
    return [0, 1, 2].map((i) => alpha * f[i] + (1 - alpha) * b[i]) as [number, number, number];
  };
  const against = (fg: string): number => {
    const [a, b] = [luminanceOf(composite(fg, 'paper', 0.55)), luminanceOf(triplet('paper', 'light'))];
    return Number(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toFixed(2));
  };
  assert.equal(against('ink'), 3.34);
  assert.equal(against('muted'), 2.32);
  assert.equal(against('muted-2'), 2.1);
  assert.equal(against('sage-deep'), 2.21);
  assert.equal(against('clay'), 2.38);
  assert.match(SOURCE, /ink 3\.34, muted 2\.32, muted-2 2\.10, sage-deep 2\.21, clay 2\.38/);
  assert.match(SOURCE, /`dimmed` is `opacity-55`/);
  assert.ok(SOURCE.includes('opacity-55'), 'the veil is gone but the note about it is not');
});

/**
 * `opacity` on an element applies to its `box-shadow`, so `opacity-55` took the selection ring down
 * with the text. The note above enumerates what the veil does to all five text tones and said
 * nothing about the ring, which is the clean-bill-of-health shape: exhaustive-looking about a case
 * it never examined.
 */
function composite(fg: string, bg: string, alpha: number, theme: Theme): [number, number, number] {
  const [f, b] = [triplet(fg, theme), triplet(bg, theme)];
  return [0, 1, 2].map((i) => alpha * f[i] + (1 - alpha) * b[i]) as [number, number, number];
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
  const [x, y] = [luminanceOf(a), luminanceOf(b)];
  return Number(((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)).toFixed(2));
}

test('the veil nullifies the selection ring, which is why a selected row is not veiled', () => {
  // The ring is the only thing carrying selection: the surface step under it is 1.13 / 1.10 once
  // both terms are composited, so if the ring goes there is nothing left.
  const veiledRing = (theme: Theme) =>
    contrast(composite('sage', 'card', 0.55, theme), composite('card', 'paper', 0.55, theme));
  assert.equal(veiledRing('light'), 1.97);
  assert.equal(veiledRing('dark'), 3.07);
  assert.ok(veiledRing('light') < 3, 'a non-text boundary needs 3:1 and the veiled ring is under it');
  assert.equal(contrast(composite('card', 'paper', 0.55, 'light'), triplet('paper', 'light')), 1.13);
  assert.equal(contrast(composite('card', 'paper', 0.55, 'dark'), triplet('paper', 'dark')), 1.1);

  // The fix, in the write path: the veil is skipped for whichever row is selected.
  assert.match(CODE, /dimmed && selectedId !== a\.id \? 'opacity-55' : ''/);
  assert.ok(
    !/\$\{dimmed \? 'opacity-55' : ''\}/.test(CODE),
    'the veil is applied to every dimmed row again, selected or not'
  );
  // And the note says so with the same figures, rather than leaving the ring out.
  assert.match(PROSE, /1\.97 light and 3\.07 dark/);
  assert.match(PROSE, /1\.13 light and 1\.10 dark/);
});

test('a closed or hidden row can be the selected one, which is what makes that reachable', () => {
  // If `renderRow(a, true)` had no `onClick`, or the closed and hidden sections rendered a
  // different row, the case above would be theoretical. Both call it with the same handler.
  const dimmedCalls = [...CODE.matchAll(/renderRow\(a, true\)/g)];
  assert.equal(dimmedCalls.length, 2, 'the closed and hidden sections no longer share renderRow');
  assert.match(slice('const renderRow =', '</Row>'), /onClick=\{\(\) => setSelectedId\(a\.id === selectedId \? null : a\.id\)\}/);
  assert.match(SOURCE, /showClosed && closed\.map\(\(a\) => renderRow\(a, true\)\)/);
  assert.match(SOURCE, /showHidden && hidden\.map\(\(a\) => renderRow\(a, true\)\)/);
});

test('HEALTHY: an unselected closed or hidden row still carries the veil', () => {
  // The fix is not "delete the veil". A row the owner is not pointed at is still de-emphasised, and
  // the recorded measurement of what that costs still applies to it.
  assert.ok(CODE.includes("dimmed && selectedId !== a.id ? 'opacity-55' : ''"));
  assert.match(CODE, /renderRow = \(a: Account, dimmed = false\)/);
  // At full strength the ring clears 3:1 in both themes, so an unveiled selected row reads.
  assert.ok(ratio('sage', 'card', 'light') >= 3 && ratio('sage', 'card', 'dark') >= 3);
});

test('index.css states what rail may carry, and states it correctly', () => {
  assert.match(CSS, /ink 9\.45 \/ 14\.60/);
  assert.match(CSS, /muted 4\.60 \/ 7\.60/);
  assert.match(CSS, /muted-2 3\.67 \/ 6\.46/);
  assert.match(CSS, /sage-deep 3\.99 \/ 9\.18/);
  assert.match(CSS, /clay 4\.43 \/ 6\.68/);
  assert.match(CSS, /gold 3\.71 \/ 8\.10/);
  assert.equal(ratio('gold', 'rail', 'light'), 3.71);
  assert.equal(ratio('gold', 'rail', 'dark'), 8.1);
  // The hover ground the row inherits from `Row`, recorded rather than claimed to be fixed.
  assert.match(CSS, /`muted-2` on `well` is\n \* 4\.02 light \/ 4\.14 dark/);
  assert.equal(ratio('muted-2', 'well', 'light'), 4.02);
  assert.equal(ratio('muted-2', 'well', 'dark'), 4.14);
});
