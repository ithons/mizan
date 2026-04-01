import React, { useEffect } from 'react';
import { Routes, Route } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Layout } from './components/Layout';
import { ToastContainer } from './components/Toast';
import { useSyncStatus } from './hooks/useSyncStatus';
import { useAppStore } from './store';
import { plaidApi } from './lib/api';
import { Dashboard } from './views/Dashboard';
import { Accounts } from './views/Accounts';
import { Transactions } from './views/Transactions';
import { CashFlow } from './views/CashFlow';
import { Budget } from './views/Budget';
import { Reports } from './views/Reports';
import { Settings } from './views/Settings';

declare global {
  interface Window {
    Plaid: any;
  }
}

function AppRoutes() {
  useSyncStatus();
  const qc = useQueryClient();
  const { addToast } = useAppStore();

  // Handle Plaid OAuth return (Chase, Wells Fargo, etc.)
  // After the user authenticates with their bank, Plaid redirects back to
  // http://localhost:3000?oauth_state_id=<id>. We must resume the Link
  // session by passing receivedRedirectUri to Plaid.create().
  useEffect(() => {
    if (!window.location.href.includes('oauth_state_id')) return;

    const receivedRedirectUri = window.location.href;

    (async () => {
      try {
        const { link_token } = await plaidApi.createLinkToken();
        const handler = window.Plaid.create({
          token: link_token,
          receivedRedirectUri,
          onSuccess: async (publicToken: string, metadata: unknown) => {
            await plaidApi.exchangeToken(publicToken, metadata);
            qc.invalidateQueries({ queryKey: ['accounts'] });
            addToast({ type: 'success', message: 'Bank connected successfully' });
            window.history.replaceState({}, '', window.location.pathname);
          },
          onExit: () => {
            window.history.replaceState({}, '', window.location.pathname);
          },
        });
        handler.open();
      } catch (err: any) {
        addToast({ type: 'error', message: err.message || 'Failed to resume Plaid OAuth' });
        window.history.replaceState({}, '', window.location.pathname);
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/accounts" element={<Accounts />} />
          <Route path="/transactions" element={<Transactions />} />
          <Route path="/cashflow" element={<CashFlow />} />
          <Route path="/budget" element={<Budget />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/settings" element={<Settings />} />
        </Route>
      </Routes>
      <ToastContainer />
    </>
  );
}

export default function App() {
  return <AppRoutes />;
}
