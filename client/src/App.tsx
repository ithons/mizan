import { lazy, Suspense, useEffect, type ReactNode } from 'react';
import { Routes, Route } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Layout } from './components/Layout';
import { ToastContainer } from './components/Toast';
import { useSyncStatus } from './hooks/useSyncStatus';
import { useAppStore } from './store';
import { plaidApi } from './lib/api';
import { loadPlaidLink } from './lib/plaidLink';
import { invalidateFinancialData } from './lib/queryInvalidation';

const Dashboard = lazy(() => import('./views/Dashboard').then((module) => ({ default: module.Dashboard })));
const Accounts = lazy(() => import('./views/Accounts').then((module) => ({ default: module.Accounts })));
const Transactions = lazy(() => import('./views/Transactions').then((module) => ({ default: module.Transactions })));
const CashFlow = lazy(() => import('./views/CashFlow').then((module) => ({ default: module.CashFlow })));
const Budget = lazy(() => import('./views/Budget').then((module) => ({ default: module.Budget })));
const Investments = lazy(() => import('./views/Investments').then((module) => ({ default: module.Investments })));
const Reports = lazy(() => import('./views/Reports').then((module) => ({ default: module.Reports })));
const Settings = lazy(() => import('./views/Settings').then((module) => ({ default: module.Settings })));
const Advisor = lazy(() => import('./views/Advisor').then((module) => ({ default: module.Advisor })));

function errorMessage(err: unknown, fallback: string) {
  return err instanceof Error && err.message ? err.message : fallback;
}

function ViewFallback() {
  return (
    <div className="p-6 space-y-4">
      <div className="h-8 w-48 rounded bg-white/5 animate-pulse" />
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="h-28 rounded border border-border bg-white/[0.02] animate-pulse" />
        <div className="h-28 rounded border border-border bg-white/[0.02] animate-pulse" />
        <div className="h-28 rounded border border-border bg-white/[0.02] animate-pulse" />
      </div>
    </div>
  );
}

function lazyView(view: ReactNode) {
  return <Suspense fallback={<ViewFallback />}>{view}</Suspense>;
}

function AppRoutes() {
  useSyncStatus();
  const qc = useQueryClient();
  const { addToast } = useAppStore();

  // Handle Plaid OAuth return (Chase, Wells Fargo, etc.)
  // After the user authenticates with their bank, Plaid redirects back to
  // the registered redirect URI with ?oauth_state_id=<id>. We must resume
  // the Link session by passing receivedRedirectUri to Plaid.create().
  useEffect(() => {
    const oauthParams = new URLSearchParams(window.location.search);
    if (!oauthParams.has('oauth_state_id')) return;

    const receivedRedirectUri = window.location.href;

    (async () => {
      try {
        const plaid = await loadPlaidLink();
        const storedToken = sessionStorage.getItem('plaid_link_token');
        const link_token = storedToken ?? (await plaidApi.createLinkToken()).link_token;
        sessionStorage.removeItem('plaid_link_token');
        const handler = plaid.create({
          token: link_token,
          receivedRedirectUri,
          onSuccess: async (publicToken: string, metadata: unknown) => {
            await plaidApi.exchangeToken(publicToken, metadata);
            invalidateFinancialData(qc);
            addToast({ type: 'success', message: 'Bank connected successfully' });
            window.history.replaceState({}, '', window.location.pathname);
          },
          onExit: () => {
            window.history.replaceState({}, '', window.location.pathname);
          },
        });
        handler.open();
      } catch (err: unknown) {
        addToast({ type: 'error', message: errorMessage(err, 'Failed to resume Plaid OAuth') });
        window.history.replaceState({}, '', window.location.pathname);
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={lazyView(<Dashboard />)} />
          <Route path="/accounts" element={lazyView(<Accounts />)} />
          <Route path="/transactions" element={lazyView(<Transactions />)} />
          <Route path="/cashflow" element={lazyView(<CashFlow />)} />
          <Route path="/budget" element={lazyView(<Budget />)} />
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
