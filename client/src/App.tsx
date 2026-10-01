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

import { LEGACY_TARGETS, legacyDestination, type LegacyTarget } from '../../shared/routes';

export { LEGACY_TARGETS, legacyDestination, type LegacyTarget };

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
