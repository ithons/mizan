import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INSTRUMENT_WINDOWS } from '../client/src/views/instrumentReadings';
import { SPENDING, render } from './helpers/instrumentHarness';

const ROOT = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/**
 * A figure that names a category, and the rows it is made of.
 *
 * Phase 14 of `.claude/plans/rebuild-part-3.md` specifies "drill-down from a chart to a filtered
 * ledger". The whole stack already filtered by category, every layer of it: `TransactionFilters`,
 * the Zod query schema, the service, `transactionsApi.list`, and the Ledger's own `CategoryPicker`.
 * The only missing piece was a way to ask for it from anywhere else, so a category figure on `/`
 * was a dead end and acting on it meant coming to the ledger and re-selecting the category by hand.
 *
 * This is the same move `LedgerIntegrityPanel` already makes for a flow-conservation finding, and
 * the reason is the one recorded there: a detector that names a thing and does not hand over its
 * rows leaves the owner to go and find them.
 *
 * VERIFIED that the link's implied claim holds, which is the part a structural test cannot reach.
 * A link from a figure to a filtered list says "these are the rows behind that number", and the
 * ledger's default filter admits transfer and duplicate candidates that `excludedFromTotalsSql`
 * keeps out of the report, so the two could legitimately disagree. Driven against the running app
 * on a copy of `.mizan/mizan.db` on 2026-09-01: over the six-month window all 10 categories agree
 * to the cent, and over the whole ledger (2000-01-01 to 2026-12-31, paginated past the 500-row
 * cap) every category agrees to the cent, the largest being Food & Drink at 21,108.05 across 849
 * rows. Zero rows in any category carry an excluding status today, which is WHY they agree; if one
 * ever does, this claim weakens and the link should say which population it opened.
 */
test('every window on the instrument has an exact counterpart range on the ledger', () => {
  // THE CORRECTNESS PROPERTY, and the reason `six-months` was added to the ledger rather than
  // mapped onto `three-months`. A drill-down that narrows the window shows a SUBSET of the rows
  // behind the figure it was opened from, and the two totals then disagree with nothing on screen
  // saying why. That is the "never a claim the code did not check" rule with the claim implied by
  // a link rather than written in a sentence.
  const ledger = read('client/src/views/Ledger.tsx');
  const ranges = [...ledger.matchAll(/\{ id: '([\w-]+)', label: '[^']*' \}/g)].map((m) => m[1]);
  assert.ok(ranges.length >= 5, `only found ${ranges.length} ledger ranges; the parse is wrong`);
  for (const w of INSTRUMENT_WINDOWS) {
    assert.ok(ranges.includes(w.id), `the ledger has no range named '${w.id}'`);
  }
});

test('each window id computes the same dates on both screens', () => {
  // Same name is not the same window. Both files compute from `date-fns` over the same anchors, so
  // the check is that the expressions match rather than that the strings do.
  const ledger = read('client/src/views/Ledger.tsx');
  const readings = read('client/src/views/instrumentReadings.ts');
  for (const [id, shape] of [
    ['this-month', /startOfMonth\(now\)/],
    ['last-month', /startOfMonth\(pri?e?v?o?r?\)/],
    ['six-months', /startOfMonth\(subMonths\(now, 5\)\)/],
  ] as const) {
    const l = ledger.slice(ledger.indexOf(`case '${id}'`), ledger.indexOf(`case '${id}'`) + 220);
    const r = readings.slice(readings.indexOf(`case '${id}'`), readings.indexOf(`case '${id}'`) + 220);
    assert.match(l, shape, `the ledger's '${id}' is not anchored where the instrument's is`);
    assert.match(r, shape, `the instrument's '${id}' moved`);
  }
});

test('the ledger reads a category from the URL', () => {
  const ledger = read('client/src/views/Ledger.tsx');
  assert.match(ledger, /searchParams\.get\('categoryId'\)/, 'the ledger cannot be asked for a category');
  assert.match(ledger, /setCategoryFilter\(category\)/, 'the ledger reads the param and drops it');
});

test('a category figure carries a link to its own rows, in its own window', () => {
  const html = render('this-month', {});
  const first = SPENDING.categories.find((c) => c.amount > 0);
  assert.ok(first, 'the fixture has no positive category to link');
  const href = `/ledger?categoryId=${encodeURIComponent(first.category_id)}&range=this-month`;
  assert.ok(
    html.includes(href) || html.includes(href.replace(/&/g, '&amp;')),
    `no row links to ${href}; a category figure is a dead end again`
  );
});

test('the row that links is a real link, not a div with a handler', () => {
  // `components/balance/Row.tsx` states the rule for actions: a bare div with `onClick` is not
  // reachable by keyboard and announces nothing. For NAVIGATION the right element is a link, which
  // is what `RailRow` on this same screen already uses: it announces as a link, carries a real
  // href, and opens in a new tab on the modifier the reader already knows.
  const src = read('client/src/views/Instrument.tsx');
  const bar = src.slice(src.indexOf('function BarRow'), src.indexOf('function BarRow') + 2400);
  assert.match(bar, /<Link\s/, 'BarRow navigates from something that is not a link');
  assert.match(bar, /aria-label=/, 'the link says nothing about where it goes');
  assert.ok(!/(<div[^>]*onClick)/.test(bar), 'BarRow puts a click handler on a div');
});

test('a row with nowhere to go is not interactive', () => {
  // The silence half. Not every BarRow has rows behind it: "What moved it" ranks accounts, and a
  // row that renders as a button the keyboard can reach but that does nothing is worse than a
  // plain row.
  const src = read('client/src/views/Instrument.tsx');
  const bar = src.slice(src.indexOf('function BarRow'), src.indexOf('function BarRow') + 2400);
  assert.match(bar, /if \(!to\) return <div/, 'BarRow is always a button, even with no destination');
});
