import { lazy, Suspense, type ReactNode } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { Layout } from './components/Layout';
import { ToastContainer } from './components/Toast';
import { ErrorBoundary } from './components/ErrorBoundary';
import { useSyncStatus } from './hooks/useSyncStatus';

const Today = lazy(() => import('./views/Today').then((module) => ({ default: module.Today })));
const Onboarding = lazy(() => import('./views/Onboarding').then((module) => ({ default: module.Onboarding })));
const Accounts = lazy(() => import('./views/accounts/Accounts').then((module) => ({ default: module.Accounts })));
const AccountDetail = lazy(() => import('./views/accounts/AccountDetail').then((module) => ({ default: module.AccountDetail })));
const Transactions = lazy(() => import('./views/Transactions').then((module) => ({ default: module.Transactions })));
const Reports = lazy(() => import('./views/Reports').then((module) => ({ default: module.Reports })));
const CashFlow = lazy(() => import('./views/CashFlow').then((module) => ({ default: module.CashFlow })));
const Bills = lazy(() => import('./views/Bills').then((module) => ({ default: module.Bills })));
const Budget = lazy(() => import('./views/Budget').then((module) => ({ default: module.Budget })));
const Goals = lazy(() => import('./views/Goals').then((module) => ({ default: module.Goals })));
const Investments = lazy(() => import('./views/Investments').then((module) => ({ default: module.Investments })));
const Settings = lazy(() => import('./views/settings/Settings').then((module) => ({ default: module.Settings })));
const Advisor = lazy(() => import('./views/Advisor').then((module) => ({ default: module.Advisor })));
const ReviewInbox = lazy(() => import('./components/ReviewInbox').then((module) => ({ default: module.ReviewInbox })));

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

function AppRoutes() {
  useSyncStatus();

  return (
    <>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={lazyView(<Today />)} />
          <Route path="/onboarding" element={lazyView(<Onboarding />)} />
          <Route path="/accounts" element={lazyView(<Accounts />)} />
          <Route path="/accounts/:id" element={lazyView(<AccountDetail />)} />
          <Route path="/review" element={lazyView(<ReviewInbox />)} />
          <Route path="/transactions" element={lazyView(<Transactions />)} />
          <Route path="/cash-flow" element={lazyView(<CashFlow />)} />
          <Route path="/cashflow" element={<Navigate to="/cash-flow" replace />} />
          <Route path="/bills" element={lazyView(<Bills />)} />
          <Route path="/budget" element={lazyView(<Budget />)} />
          <Route path="/goals" element={lazyView(<Goals />)} />
          <Route path="/investments" element={lazyView(<Investments />)} />
          <Route path="/reports" element={lazyView(<Reports />)} />
          <Route path="/advisor" element={lazyView(<Advisor />)} />
          <Route path="/settings" element={lazyView(<Settings />)} />
        </Route>
      </Routes>
      <ToastContainer />
    </>
  );
}

export default function App() {
  return <AppRoutes />;
}
