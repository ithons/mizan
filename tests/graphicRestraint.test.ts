import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const CLIENT = join(ROOT, 'client', 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/**
 * The restraint the graphic layer is bounded by, pinned while it is still true.
 *
 * `.claude/plans/rebuild-part-3.md` Phase 13 lists these as the rules that bound its pass, and says
 * "nothing in this pass ships without its healthy-case test". Most of them are ALREADY true, and an
 * invariant nobody checks is one refactor from being false. So they are pinned here rather than
 * asserted in prose. Where a rule as written measured the wrong thing, the restated form says what
 * it was reaching for and why.
 *
 * These are deliberately structural counts, not renderings. What a screen looks like is Gate 4, and
 * Gate 4 is a person with the app open; this is the half a test can hold.
 */
const VIEWS = [
  'client/src/views/Instrument.tsx',
  'client/src/views/Ledger.tsx',
  'client/src/views/Plan.tsx',
  'client/src/views/Investments.tsx',
  'client/src/views/accounts/Accounts.tsx',
  'client/src/views/settings/Settings.tsx',
];

test('one subject per route, at most', () => {
  // The 44px money numeral is the thing the screen is about. Two of them is no subject.
  for (const view of VIEWS) {
    const n = (read(view).match(/scale="subject"/g) ?? []).length;
    assert.ok(n <= 1, `${view} renders ${n} subject figures`);
  }
  // And the three screens that HAVE a subject still have one, so this cannot pass by deleting them.
  for (const view of ['client/src/views/Instrument.tsx', 'client/src/views/Plan.tsx', 'client/src/views/accounts/Accounts.tsx']) {
    assert.match(read(view), /scale="subject"/, `${view} lost its subject figure`);
  }
});

test('at most two textures in the whole client, and none on a ground', () => {
  // `walk` yields absolute paths; `read` takes a repo-relative one. Not interchangeable.
  const all = walk(CLIENT).map((f) => readFileSync(f, 'utf8')).join('\n');
  const repeating = (all.match(/repeating-linear-gradient/g) ?? []).length;
  const radial = (all.match(/radial-gradient/g) ?? []).length;
  assert.ok(repeating <= 2, `${repeating} repeating-linear-gradient declarations; the cap is 2`);
  assert.ok(radial <= 1, `${radial} radial-gradient declarations; the cap is 1`);

  // Zero texture on a PAGE ground. Every AA figure in edgeToken.test.ts is computed against a flat
  // ground, so a texture behind a money numeral silently invalidates all of them: correct in the
  // tokens, wrong on the screen, and no test can see the composite.
  //
  // `well` is deliberately NOT on this list, and the app's one texture is on it: the balance beam's
  // uncalibrated fill (BalanceScale.tsx). `well` is an inset surface carrying no money numeral, and
  // hatching it is how the beam says the reading is uncalibrated. The forbidden set is exactly the
  // five grounds a figure can sit on.
  //
  // Judged per JSX element rather than over a neighbourhood of characters: the first draft of this
  // test used a 400-character window and flagged the beam, whose hatch and whose `bg-well` are on
  // one element and nowhere near a page ground.
  const PAGE_GROUNDS = ['bg-paper', 'bg-rail', 'bg-card', 'bg-card-alt', 'bg-card-white'];
  for (const file of walk(CLIENT)) {
    const src = readFileSync(file, 'utf8');
    for (const tag of src.matchAll(/<[A-Za-z][^>]*>/g)) {
      if (!/backgroundImage|background-image|HATCH/.test(tag[0])) continue;
      for (const ground of PAGE_GROUNDS) {
        assert.ok(
          !new RegExp(`\\b${ground}\\b`).test(tag[0]),
          `${file.replace(ROOT, '')} textures an element grounded on ${ground}`
        );
      }
    }
  }
});

test('the datum rule is one per screen, and the Ledger has it', () => {
  // `ink-soft` as a full-width hairline is the datum: the Ledger's today rule, "the only thing
  // separating what is expected from what happened". A second one on a screen means neither is it.
  const ledger = read('client/src/views/Ledger.tsx');
  const halves = (ledger.match(/h-px flex-1 bg-ink-soft/g) ?? []).length;
  // Rendered as two halves around a dated label, which is one rule.
  assert.equal(halves, 2, 'the today rule is no longer two halves around its label');
  assert.match(ledger, /Today ·/, 'the datum rule lost the date that says what it separates');

  for (const view of VIEWS.filter((v) => !v.endsWith('Ledger.tsx'))) {
    const n = (read(view).match(/h-px[^"']*bg-ink-soft/g) ?? []).length;
    assert.equal(n, 0, `${view} draws a datum rule; the Ledger's today rule is the app's only one`);
  }
});

test('cards are rationed, and three screens carry none', () => {
  for (const view of VIEWS) {
    const n = (read(view).match(/<Card[\s>]/g) ?? []).length;
    assert.ok(n <= 4, `${view} renders ${n} cards; the cap is 4`);
  }
  // A card is a container for a decision. A list of rows is not a stack of decisions, and boxing
  // one turns the screen into a grid, which is the crowding failure this pass exists to avoid.
  for (const view of ['client/src/views/Ledger.tsx', 'client/src/views/Investments.tsx', 'client/src/views/settings/Settings.tsx']) {
    assert.equal((read(view).match(/<Card[\s>]/g) ?? []).length, 0, `${view} grew a card`);
  }
});

test('the series ramp is positional and reaches no store', () => {
  // The ramp is the one place hue genuinely spreads. It says "these are different slices of this
  // bar", not "this entity is teal": a colour that follows an entity across views becomes an
  // identity, and an identity persisted is a fact the app invented.
  // Matched on the ramp's OWN identifiers, not on the word "series", which also names the
  // net-worth series on the trend chart and has nothing to do with hue. The first draft of this
  // test matched the bare word and flagged TrendChart.tsx, api.ts and Instrument.tsx, none of
  // which touch the ramp.
  const RAMP = /\bseriesColor\s*\(|\bSERIES_OVERFLOW_COLOR\b|['"`]series-/;
  const PERSISTS = /localStorage|sessionStorage|INSERT\s+INTO|UPDATE\s+\w+\s+SET|toCsv/i;
  const persisted = [...walk(CLIENT), ...walk(join(ROOT, 'server', 'src'))]
    .filter((f) => {
      const s = readFileSync(f, 'utf8');
      return RAMP.test(s) && PERSISTS.test(s);
    })
    .map((f) => f.replace(ROOT, ''));
  assert.deepEqual(persisted, [], 'the series ramp reaches something that persists');
});
