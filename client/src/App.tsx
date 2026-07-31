import { lazy, Suspense, useEffect, type ReactNode } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { Layout } from './components/Layout';
import { ToastContainer } from './components/Toast';
import { ErrorBoundary } from './components/ErrorBoundary';
import { useSyncStatus } from './hooks/useSyncStatus';

const Instrument = lazy(() => import('./views/Instrument').then((module) => ({ default: module.Instrument })));
const Ledger = lazy(() => import('./views/Ledger').then((module) => ({ default: module.Ledger })));
const Accounts = lazy(() => import('./views/accounts/Accounts').then((module) => ({ default: module.Accounts })));
const AccountDetail = lazy(() => import('./views/accounts/AccountDetail').then((module) => ({ default: module.AccountDetail })));
const Investments = lazy(() => import('./views/Investments').then((module) => ({ default: module.Investments })));
const Plan = lazy(() => import('./views/Plan').then((module) => ({ default: module.Plan })));
const Settings = lazy(() => import('./views/settings/Settings').then((module) => ({ default: module.Settings })));
const NotFound = lazy(() => import('./views/NotFound').then((module) => ({ default: module.NotFound })));

function ViewFallback() {
  return (
    <div className="space-y-4 px-12 py-9">
      <div className="h-8 w-48 animate-pulse rounded bg-line" />
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <div className="h-28 animate-pulse rounded-xl border border-line-2 bg-card shadow-e1" />
        <div className="h-28 animate-pulse rounded-xl border border-line-2 bg-card shadow-e1" />
        <div className="h-28 animate-pulse rounded-xl border border-line-2 bg-card shadow-e1" />
      </div>
    </div>
  );
}

// Each view gets its own boundary so a render throw is contained to that screen: the nav rail
// stays usable and the user can navigate away instead of facing a blank page.
function lazyView(view: ReactNode) {
  return (
    <ErrorBoundary>
      <Suspense fallback={<ViewFallback />}>{view}</Suspense>
    </ErrorBoundary>
  );
}

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

function LegacyRedirect({ target }: { target: LegacyTarget }) {
  const { search } = useLocation();
  return <Navigate to={legacyDestination(target, search)} replace />;
}

/**
 * `/advisor` is deleted, and this is where its bookmark goes.
 *
 * The conversation moved into ⌘K, which is a sheet over the current screen rather than a screen of
 * its own, so there is no path to send this to. It goes to `/` and opens the sheet, which is both
 * the honest destination and the one arrival that teaches where the advisor now lives.
 */
function AdvisorRedirect() {
  useEffect(() => {
    window.dispatchEvent(new Event('mizan:open-palette'));
  }, []);
  return <Navigate to="/" replace />;
}

function AppRoutes() {
  useSyncStatus();

  return (
    <>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={lazyView(<Instrument />)} />
          <Route path="/ledger" element={lazyView(<Ledger />)} />
          <Route path="/accounts" element={lazyView(<Accounts />)} />
          <Route path="/accounts/:id" element={lazyView(<AccountDetail />)} />
          <Route path="/investments" element={lazyView(<Investments />)} />
          <Route path="/plan" element={lazyView(<Plan />)} />
          <Route path="/settings" element={lazyView(<Settings />)} />

          {LEGACY_TARGETS.map((legacy) => (
            <Route key={legacy.from} path={legacy.from} element={<LegacyRedirect target={legacy} />} />
          ))}
          <Route path="/advisor" element={<AdvisorRedirect />} />

          <Route path="*" element={lazyView(<NotFound />)} />
        </Route>
      </Routes>
      <ToastContainer />
    </>
  );
}

export default function App() {
  return <AppRoutes />;
}
