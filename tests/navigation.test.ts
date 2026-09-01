import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NavRail, NAV_ITEMS, SETTINGS_ITEM, ALL_NAV_ITEMS } from '../client/src/components/NavRail';
import { SHORTCUTS, chordOf, shortcut } from '../client/src/lib/keyboard';
import { NotFound } from '../client/src/views/NotFound';
import type { SyncHealth } from '../shared/types';

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

/**
 * The rail reads the last successful sync from the server, so it needs a query client.
 *
 * `retry: false` matters: these assertions are about markup, and a rail rendered with the query
 * still pending is the exact state a real first paint is in, so the sync line under test here is
 * the fallback wording. What the rail does once the query resolves is asserted separately, in
 * `the sync line prefers the server's answer to an empty session store`.
 */
function railMarkup(path: string): string {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(MemoryRouter, { initialEntries: [path] }, createElement(NavRail))
    )
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
  assert.equal(ratio('dot', 'rail', 'light'), '2.74');
  assert.equal(ratio('dot', 'rail', 'dark'), '3.88');
  assert.match(RAIL_SOURCE, /\*\*2\.74:1 light and 3\.88:1 dark\*\*/);
  // Below AA in both themes, and below the 3:1 floor a non-text mark would need on light, which is
  // why the marks are gone rather than recoloured: twelve of them said the same thing in a value
  // nobody can see. Both halves of that sentence are asserted, not just the light one.
  assert.ok(Number(ratio('dot', 'rail', 'light')) < 3, 'the light dot now clears the 3:1 floor');
  assert.ok(Number(ratio('dot', 'rail', 'dark')) < 4.5, 'the dark dot now clears AA');
});

test('the other three figures in the rail reproduce too', () => {
  assert.equal(ratio('line', 'rail', 'light'), '1.20');
  assert.match(RAIL_SOURCE, /`line` on `rail` is 1\.20:1 light/);

  assert.equal(ratio('muted', 'rail', 'light'), '7.01');
  assert.equal(ratio('muted', 'rail', 'dark'), '9.03');
  assert.match(RAIL_SOURCE, /`muted` on `rail`, 7\.01:1 light \/ 9\.03:1 dark/);

  assert.equal(ratio('clay', 'rail', 'light'), '12.05');
  assert.equal(ratio('clay', 'rail', 'dark'), '14.18');
  assert.equal(ratio('ink', 'rail', 'light'), '19.43');
  assert.match(RAIL_SOURCE, /`clay` on `rail` measures\n\s+12\.05:1 light \/ 14\.18:1 dark/);
  assert.match(RAIL_SOURCE, /`ink` on `rail` is 19\.43:1 against\n\s+`muted`'s 7\.01:1/);
});

test('the sync failure is a step in value, and the rail no longer claims clay could not be read', () => {
  // Delisted: `clay` on `rail` was 4.43:1 and the rail justified `ink` by saying a colour that
  // cannot be read is not a warning. It measures 12.05:1 light / 14.18:1 dark now, so that
  // justification is not available and the file must not still be making it.
  assert.ok(Number(ratio('clay', 'rail', 'light')) >= 4.5);
  assert.ok(Number(ratio('clay', 'rail', 'dark')) >= 4.5);
  assert.doesNotMatch(RAIL_SOURCE, /under AA at this size/);
  // The choice itself still has to be stated as a choice.
  assert.match(RAIL_SOURCE, /steps up in value rather than changing hue/);
});

test('every tone the rail sets as text clears AA on the ground it is set on', () => {
  // Enumerated from the rail's own class lists rather than named here, because the failure this
  // guards against is a tone added to the rail and never measured. 17px is below the large-text
  // threshold, so 4.5:1 applies to inactive labels as well as active.
  const tones = [...new Set([...RAIL_SOURCE.matchAll(/(?:^|[\s"'`:!])text-([a-z0-9-]+)/g)].map((m) => m[1]))]
    .filter((name) => CSS.includes(`--mz-${name}-c:`))
    .sort();
  assert.deepEqual(tones, ['ink', 'muted', 'paper'], 'the rail sets a tone this test has not measured');

  for (const theme of ['light', 'dark'] as const) {
    for (const tone of ['ink', 'muted']) {
      assert.ok(Number(ratio(tone, 'rail', theme)) >= 4.5, `${tone} on rail, ${theme}`);
    }
    // `paper` is the wordmark chip only, which is `bg-ink`, so it is measured on ink and not rail.
    assert.ok(Number(ratio('paper', 'ink', theme)) >= 4.5, `paper on ink, ${theme}`);
  }

  // `faint` is the one text token still under AA on this ground on light, at 3.56:1; it clears on
  // dark at 4.88:1, and is non-text by contract either way. `muted-2` used to be listed beside it as a
  // 3.67:1 pair; it is 5.56:1 light / 7.30:1 dark now, so it is delisted rather than left recorded
  // as a failure, and the enumeration above is what keeps the rail honest instead.
  assert.ok(Number(ratio('faint', 'rail', 'light')) < 4.5, 'faint clears AA on rail now; delist it');
  assert.ok(Number(ratio('muted-2', 'rail', 'light')) >= 4.5);
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

/**
 * The sync line answers from the ledger, not from what this browser tab happened to witness.
 *
 * `lastSynced` in the Zustand store is written only by an SSE `sync_complete` arriving in this
 * tab, and it starts null. So the rail read "Not synced yet" on every page load, on a ledger whose
 * latest completed run is a column in the database, and held that claim until a sync happened to
 * finish while the tab was open. `syncApi.health()` already returned the answer and had no caller.
 */
function railMarkupWithHealth(lastSyncedAt: string | null): string {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  queryClient.setQueryData(['sync', 'health'], { last_synced_at: lastSyncedAt } as SyncHealth);
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(MemoryRouter, { initialEntries: ['/'] }, createElement(NavRail))
    )
  );
}

test('the sync line prefers the server answer to an empty session store', () => {
  const justNow = new Date(Date.now() - 5 * 60_000).toISOString();
  const markup = railMarkupWithHealth(justNow);

  assert.match(markup, /5m ago/, 'the rail ignored the last sync the server reported');
  assert.doesNotMatch(
    markup,
    /Not synced yet/,
    'a ledger with a recorded sync was described as never synced'
  );
});

test('HEALTHY: a genuinely never-synced ledger still says so', () => {
  // The wording is not wrong, it was only reached wrongly. A fresh install has no run to report
  // and must keep saying that rather than inventing a time.
  const markup = railMarkupWithHealth(null);
  assert.match(markup, /Not synced yet/);
});
