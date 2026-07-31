import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { NavRail, NAV_ITEMS, SETTINGS_ITEM, ALL_NAV_ITEMS } from '../client/src/components/NavRail';
import { SHORTCUTS, chordOf, shortcut } from '../client/src/lib/keyboard';
import { NotFound } from '../client/src/views/NotFound';

/**
 * The navigation, rendered, at the width the labels used to disappear at.
 *
 * The defect this replaces was invisible to every test in the repo because it was a Tailwind
 * variant: every label carried `xl:block` on a `hidden` span, so below 1280px the whole navigation
 * was twelve identical 7px dots. `renderToStaticMarkup` emits the class list, so the assertion that
 * catches it is that no label is behind a responsive variant at all.
 */

const ROOT = join(import.meta.dirname, '..');
const RAIL_SOURCE = readFileSync(join(ROOT, 'client/src/components/NavRail.tsx'), 'utf8');

function railMarkup(path: string): string {
  return renderToStaticMarkup(
    createElement(MemoryRouter, { initialEntries: [path] }, createElement(NavRail))
  );
}

test('there are six destinations and they are six single words', () => {
  assert.equal(ALL_NAV_ITEMS.length, 6);
  assert.deepEqual(
    ALL_NAV_ITEMS.map((i) => i.label),
    ['Balance', 'Ledger', 'Accounts', 'Investments', 'Plan', 'Settings']
  );
  for (const item of ALL_NAV_ITEMS) {
    assert.ok(!item.label.includes(' '), `${item.label} is not one word`);
  }
});

test('every destination is one of the six routes the router mounts', () => {
  const app = readFileSync(join(ROOT, 'client/src/App.tsx'), 'utf8');
  for (const item of ALL_NAV_ITEMS) {
    assert.match(app, new RegExp(`path="${item.to}"`), `App.tsx mounts no route for ${item.to}`);
  }
});

test('every label renders at every width, with no responsive variant hiding it', () => {
  const markup = railMarkup('/');
  for (const item of ALL_NAV_ITEMS) {
    assert.ok(markup.includes(`>${item.label}<`), `${item.label} is not in the rendered rail`);
  }
  // The exact mechanism of the defect: `hidden ... xl:block` on the label span.
  assert.ok(!/\bhidden\b[^"]*\bxl:block\b/.test(markup), 'a label is still gated behind xl:block');
  assert.ok(!markup.includes('xl:'), 'the rail still carries a breakpoint variant');
});

/**
 * Every figure the rail writes into a comment, re-derived from the shipped tokens.
 *
 * A number in a source comment that no code reproduces is the failure this codebase keeps catching,
 * so each one is computed here and matched against the text that states it.
 */
const CSS = readFileSync(join(ROOT, 'client/src/index.css'), 'utf8');

function triplet(name: string, theme: 'light' | 'dark'): [number, number, number] {
  const all = [...CSS.matchAll(new RegExp(`--mz-${name}-c:\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)\\s*;`, 'g'))];
  const m = theme === 'light' ? all[0] : all[all.length - 1];
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function ratio(fg: string, bg: string, theme: 'light' | 'dark'): string {
  const luminance = ([r, g, b]: [number, number, number]): number => {
    const ch = (c: number) => (c / 255 <= 0.03928 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
  };
  const [a, b] = [luminance(triplet(fg, theme)), luminance(triplet(bg, theme))];
  return ((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toFixed(2);
}

test('the dot that was the navigation measures what the rail says it measures', () => {
  assert.equal(ratio('dot', 'rail', 'light'), '1.70');
  assert.equal(ratio('dot', 'rail', 'dark'), '3.63');
  assert.match(RAIL_SOURCE, /\*\*1\.70:1 light and 3\.63:1 dark\*\*/);
  // Below AA in both themes, and below any threshold at all on light, which is why the marks are
  // gone rather than recoloured: twelve of them said the same thing in a value nobody can see.
  assert.ok(Number(ratio('dot', 'rail', 'light')) < 3);
});

test('the other three figures in the rail reproduce too', () => {
  assert.equal(ratio('line', 'rail', 'light'), '1.04');
  assert.match(RAIL_SOURCE, /`line` on `rail` is 1\.04:1 light/);

  assert.equal(ratio('muted', 'rail', 'light'), '4.60');
  assert.equal(ratio('muted', 'rail', 'dark'), '7.60');
  assert.match(RAIL_SOURCE, /`muted` on `rail`, 4\.60:1 light \/ 7\.60:1 dark/);

  assert.equal(ratio('clay', 'rail', 'light'), '4.43');
  assert.equal(ratio('ink', 'rail', 'light'), '9.45');
  assert.match(RAIL_SOURCE, /`clay` on `rail` measures\n\s+4\.43:1 light/);
  assert.match(RAIL_SOURCE, /`ink` on `rail` is 9\.45:1 against `muted`'s 4\.60:1/);
});

test('every label the rail renders clears AA on the rail', () => {
  // 17px is below the large-text threshold, so 4.5:1 applies to inactive labels as well as active.
  for (const theme of ['light', 'dark'] as const) {
    for (const tone of ['ink', 'muted']) {
      assert.ok(Number(ratio(tone, 'rail', theme)) >= 4.5, `${tone} on rail, ${theme}`);
    }
  }
  assert.ok(!RAIL_SOURCE.includes('text-muted-2'), 'the rail puts secondary text on a 3.67:1 pair');
  assert.ok(!RAIL_SOURCE.includes('text-faint'), 'the rail uses the non-text token as text');
});

test('the rail carries no dot for a destination, and none for sync status', () => {
  const markup = railMarkup('/');
  // 7px round marks were the whole navigation, plus a sync light that rendered `sage-soft`
  // whenever status was not 'error', including beside the words "Not synced yet".
  assert.ok(!markup.includes('h-[7px]'), 'a 7px dot survived in the rail');
  assert.ok(!markup.includes('sage-soft'), 'the sync dot survived in the rail');
  assert.ok(!markup.includes('border-dot'), 'the inactive dot outline survived in the rail');
});

test('exactly one destination is marked active, and it is the one you are on', () => {
  for (const item of ALL_NAV_ITEMS) {
    const markup = railMarkup(item.to);
    const active = (markup.match(/aria-current="page"/g) ?? []).length;
    assert.equal(active, 1, `${item.to} marks ${active} items active`);
  }
});

test('the active mark is a leader rule in a gutter that is always there', () => {
  const markup = railMarkup('/ledger');
  // Fixed-width gutter column, so the rule appearing does not move the word beside it.
  assert.ok(markup.includes('grid-cols-[18px_1fr]'), 'the leader gutter is not a fixed column');
  assert.equal((markup.match(/bg-ink/g) ?? []).length >= 1, true);
});

test('the sync line says its state in words rather than in a colour', () => {
  const markup = railMarkup('/');
  assert.ok(markup.includes('Not synced yet'), 'the never-synced state is not stated');
});

test('⌘K is advertised once, in the navigation', () => {
  const markup = railMarkup('/');
  assert.equal((markup.match(/⌘K/g) ?? []).length, 1);
});

/**
 * The chord, and why it is a chord.
 *
 * ⌘1 to ⌘9 switch browser tabs, ⌘0 resets zoom, ⌘R reloads, ⌘P prints, ⌘S saves the page. All five
 * were being taken. A prefix key takes nothing.
 *
 * How the chord BEHAVES is `tests/keyboard.test.ts`, which drives the resolver. What is asserted
 * here is the rail's own half: which chord each destination claims, and that the rail claims it by
 * registering an intention rather than by holding a listener of its own. Its listener was one of
 * the three that let `g` `a` navigate and accept an AI draft on the same keystroke.
 */
test('navigation takes no modifier the browser already owns', () => {
  for (const item of ALL_NAV_ITEMS) {
    assert.match(chordOf(item.shortcut), /^g [a-z]$/, `${item.label} does not go through the prefix`);
  }
  const modifiers = SHORTCUTS.filter((s) => s.chord.startsWith('mod+'));
  // ⌘K is the single deliberate hijack in the entire app.
  assert.deepEqual(modifiers.map((s) => s.id), ['palette.toggle']);
});

test('the rail holds no keyboard listener of its own', () => {
  assert.ok(!RAIL_SOURCE.includes('addEventListener'), 'the rail listens for keys itself again');
  assert.match(RAIL_SOURCE, /useShortcuts\('nav-rail'/);
});

test('every chord letter is distinct and is the first letter of its destination', () => {
  const chords = ALL_NAV_ITEMS.map((i) => chordOf(i.shortcut));
  assert.equal(new Set(chords).size, chords.length, 'two destinations share a chord letter');
  for (const item of ALL_NAV_ITEMS) {
    const letter = chordOf(item.shortcut).slice(2);
    assert.equal(letter, item.label[0].toLowerCase(), `${item.label} does not start with ${letter}`);
  }
});

test('the chord is inert while you are typing', () => {
  for (const item of ALL_NAV_ITEMS) {
    assert.equal(shortcut(item.shortcut).focus, 'not-typing', `${item.label} fires into a text field`);
  }
});

/** The catch-all. There was none, so a typo rendered a blank page under a working nav rail. */
test('an unknown path names itself and lists every path there is', () => {
  const markup = renderToStaticMarkup(
    createElement(MemoryRouter, { initialEntries: ['/reprots'] }, createElement(NotFound))
  );
  assert.ok(markup.includes('/reprots'), 'the catch-all does not say which path failed');
  for (const item of [...NAV_ITEMS, SETTINGS_ITEM]) {
    assert.ok(markup.includes(`>${item.label}<`), `${item.label} is missing from the catch-all`);
    assert.ok(markup.includes(`href="${item.to}"`), `${item.to} is not linked from the catch-all`);
  }
});

test('the catch-all does not apologise', () => {
  const markup = renderToStaticMarkup(
    createElement(MemoryRouter, { initialEntries: ['/nope'] }, createElement(NotFound))
  );
  for (const word of ['Sorry', 'sorry', 'Oops', 'oops', 'apolog']) {
    assert.ok(!markup.includes(word), `the catch-all says "${word}"`);
  }
});
