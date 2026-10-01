// Lives in shared/ because both sides need it: the client router redirects through it, and the
// server canonicalizes routes the advisor model writes, so a draft never names a retired screen.

/**
 * Where the twelve old paths land, and why each one lands there.
 *
 * Bookmarks and cross-screen links outlive a consolidation, so none of these 404s. Each target is
 * the reading the retired screen was pointing at, which is what its shim file recorded before the
 * shims were deleted:
 *
 *   /cash-flow, /cashflow   the same query set as `/` over a longer stretch, so the window it
 *                           defaulted to travels with the redirect
 *   /reports                the same query set over the month, plus balance-sheet readings `/`
 *                           already owned
 *   /transactions, /bills,  all three were predicates over one table. Bills died because a bill is
 *   /review                 a transaction that has not happened yet, and giving future money its
 *                           own screen is how a forecast gets read as a fact. The search string is
 *                           carried through, because `/transactions?uncategorized=1&range=all` is
 *                           a live deep link and `Ledger` still answers it.
 *   /budget, /goals         one claim sheet: a budget claims money for a month, a goal claims it
 *                           toward a target
 *   /onboarding             folded into Settings as a Setup row, which is where the connections it
 *                           walks you through already live. Nothing ever linked to the screen, and
 *                           an always-logged-in single-owner app has no moment where a welcome is
 *                           the thing to show. What it read is a status, not a welcome, and a
 *                           status is asked more than once: a connection can lapse in month six.
 *   /advisor                deleted, not moved. See `AdvisorRedirect`.
 */
export interface LegacyTarget {
  from: string;
  to: string;
  /** Set only where the target screen reads the same search params the old path carried. */
  carrySearch?: boolean;
}

export const LEGACY_TARGETS: readonly LegacyTarget[] = [
  { from: '/cash-flow', to: '/?window=six-months' },
  { from: '/cashflow', to: '/?window=six-months' },
  { from: '/reports', to: '/?window=this-month' },
  { from: '/transactions', to: '/ledger', carrySearch: true },
  { from: '/bills', to: '/ledger' },
  { from: '/review', to: '/ledger?uncategorized=1' },
  { from: '/budget', to: '/plan' },
  { from: '/goals', to: '/plan' },
  { from: '/onboarding', to: '/settings?section=setup' },
];

/**
 * Where a legacy path actually lands, given the search string it was opened with.
 *
 * Pure and exported so the query-carry can be tested without a DOM: `/transactions?uncategorized=1`
 * has to reach `/ledger?uncategorized=1`, and a target that already carries its own query must not
 * gain a second `?`.
 */
export function legacyDestination(target: LegacyTarget, search: string): string {
  if (!target.carrySearch || !search) return target.to;
  return `${target.to}${target.to.includes('?') ? search.replace('?', '&') : search}`;
}

/**
 * The route a link should name: a retired path becomes the destination its redirect would give,
 * search carried exactly as the redirect carries it, and every other route is returned unchanged.
 */
export function canonicalRoute(route: string): string {
  const queryAt = route.indexOf('?');
  const path = queryAt === -1 ? route : route.slice(0, queryAt);
  const search = queryAt === -1 ? '' : route.slice(queryAt);
  const target = LEGACY_TARGETS.find((t) => t.from === path);
  return target ? legacyDestination(target, search) : route;
}
