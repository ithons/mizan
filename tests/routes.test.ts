import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LEGACY_TARGETS, legacyDestination } from '../client/src/App';
import { ALL_NAV_ITEMS } from '../client/src/components/NavRail';

/**
 * Twelve screens became six, and no bookmark 404s on the way.
 *
 * The twelve paths below are a historical fact, taken from the nav rail and the router as they
 * stood before this consolidation, so they are written down rather than derived. Everything else
 * here is derived from the shipped router.
 */

const APP = readFileSync(join(import.meta.dirname, '..', 'client/src/App.tsx'), 'utf8');

/** Every `path="..."` the router mounts, wildcard excluded. */
const MOUNTED = new Set(
  [...APP.matchAll(/path="([^"]+)"/g)].map((m) => m[1]).filter((p) => p !== '*')
);

const OLD_PATHS = [
  '/', '/onboarding', '/accounts', '/accounts/:id', '/review', '/transactions',
  '/cash-flow', '/cashflow', '/bills', '/budget', '/goals', '/investments',
  '/reports', '/advisor', '/settings',
];

test('the router mounts exactly six screens plus the account detail beneath one of them', () => {
  const screens = [...MOUNTED].filter(
    (p) => !LEGACY_TARGETS.some((l) => l.from === p) && p !== '/advisor' && p !== '/accounts/:id'
  );
  assert.deepEqual(
    screens.sort(),
    ['/', '/accounts', '/investments', '/ledger', '/plan', '/settings']
  );
  assert.deepEqual(
    ALL_NAV_ITEMS.map((i) => i.to).sort(),
    screens.sort(),
    'the nav and the router disagree about what the six screens are'
  );
});

test('every path that used to exist still resolves', () => {
  for (const old of OLD_PATHS) {
    const stillMounted = MOUNTED.has(old);
    const redirected = LEGACY_TARGETS.some((l) => l.from === old) || old === '/advisor';
    assert.ok(stillMounted || redirected, `${old} resolves to nothing`);
  }
});

test('every legacy redirect points at a path the router mounts', () => {
  for (const target of LEGACY_TARGETS) {
    const path = target.to.split('?')[0];
    assert.ok(MOUNTED.has(path), `${target.from} redirects to ${path}, which is not mounted`);
  }
});

/**
 * The window each retired screen was a window ON travels with the redirect.
 *
 * Cash Flow and Reports were the same query set over different stretches of time, which is the
 * whole argument for folding them into one selector. A redirect that dropped the window would land
 * a Reports bookmark on a six-month reading and call it the same screen.
 */
test('the two window redirects carry the window their screen defaulted to', () => {
  const by = (from: string) => LEGACY_TARGETS.find((l) => l.from === from);
  assert.equal(by('/cash-flow')?.to, '/?window=six-months');
  assert.equal(by('/cashflow')?.to, '/?window=six-months');
  assert.equal(by('/reports')?.to, '/?window=this-month');
});

test('a review bookmark lands on the ledger filtered to what review was', () => {
  assert.equal(LEGACY_TARGETS.find((l) => l.from === '/review')?.to, '/ledger?uncategorized=1');
});

test('a transactions deep link keeps its query string', () => {
  const target = LEGACY_TARGETS.find((l) => l.from === '/transactions');
  assert.ok(target);
  assert.equal(
    legacyDestination(target, '?uncategorized=1&range=all'),
    '/ledger?uncategorized=1&range=all'
  );
  assert.equal(legacyDestination(target, ''), '/ledger');
});

test('carrying a query onto a target that already has one does not mint a second question mark', () => {
  const destination = legacyDestination(
    { from: '/x', to: '/ledger?uncategorized=1', carrySearch: true },
    '?range=all'
  );
  assert.equal(destination, '/ledger?uncategorized=1&range=all');
  assert.equal((destination.match(/\?/g) ?? []).length, 1);
});

test('a redirect that is not declared to carry a query does not silently carry one', () => {
  const target = LEGACY_TARGETS.find((l) => l.from === '/budget');
  assert.ok(target);
  assert.equal(legacyDestination(target, '?anything=1'), '/plan');
});

test('there is a catch-all, so a typo is not a blank page', () => {
  assert.match(APP, /path="\*"/);
});

/**
 * The advisor tab is deleted rather than moved, so its bookmark has no path to go to: the
 * conversation is a sheet over whatever screen you are on. It lands on `/` and opens the sheet.
 */
test('/advisor opens the sheet instead of resolving to a screen', () => {
  assert.ok(!MOUNTED.has('/ledger?uncategorized=1'));
  assert.match(APP, /path="\/advisor" element=\{<AdvisorRedirect \/>\}/);
  assert.match(APP, /mizan:open-palette/);
  assert.ok(!/const Advisor = lazy/.test(APP), 'the advisor view is still imported');
});
