import { lazy, Suspense, type ReactNode } from 'react';
import { Routes, Route } from 'react-router-dom';
import { Layout } from './components/Layout';
import { ToastContainer } from './components/Toast';
import { useSyncStatus } from './hooks/useSyncStatus';
import { useAppStore } from './store';

const Dashboard = lazy(() => import('./views/Dashboard').then((module) => ({ default: module.Dashboard })));
const Onboarding = lazy(() => import('./views/Onboarding').then((module) => ({ default: module.Onboarding })));
const Accounts = lazy(() => import('./views/accounts/Accounts').then((module) => ({ default: module.Accounts })));
const Transactions = lazy(() => import('./views/Transactions').then((module) => ({ default: module.Transactions })));
const ReviewInbox = lazy(() => import('./views/ReviewInbox').then((module) => ({ default: module.ReviewInbox })));
const CashFlow = lazy(() => import('./views/CashFlow').then((module) => ({ default: module.CashFlow })));
const Bills = lazy(() => import('./views/Bills').then((module) => ({ default: module.Bills })));
const Budget = lazy(() => import('./views/Budget').then((module) => ({ default: module.Budget })));
const Goals = lazy(() => import('./views/Goals').then((module) => ({ default: module.Goals })));
const Investments = lazy(() => import('./views/Investments').then((module) => ({ default: module.Investments })));
const Reports = lazy(() => import('./views/Reports').then((module) => ({ default: module.Reports })));
const Settings = lazy(() => import('./views/settings/Settings').then((module) => ({ default: module.Settings })));
const Advisor = lazy(() => import('./views/Advisor').then((module) => ({ default: module.Advisor })));

function ViewFallback() {
  return (
    <div className="p-6 space-y-4">
      <div className="h-8 w-48 rounded bg-border/60 animate-pulse" />
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="h-28 rounded border border-border bg-surface animate-pulse" />
        <div className="h-28 rounded border border-border bg-surface animate-pulse" />
        <div className="h-28 rounded border border-border bg-surface animate-pulse" />
      </div>
    </div>
  );
}

function lazyView(view: ReactNode) {
  return <Suspense fallback={<ViewFallback />}>{view}</Suspense>;
}

function AppRoutes() {
  useSyncStatus();

  return (
    <>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={lazyView(<Dashboard />)} />
          <Route path="/onboarding" element={lazyView(<Onboarding />)} />
          <Route path="/accounts" element={lazyView(<Accounts />)} />
          <Route path="/review" element={lazyView(<ReviewInbox />)} />
          <Route path="/transactions" element={lazyView(<Transactions />)} />
          <Route path="/cashflow" element={lazyView(<CashFlow />)} />
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
