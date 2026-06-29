import { useEffect } from 'react';
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
import { Investments } from './views/Investments';
import { Reports } from './views/Reports';
import { Settings } from './views/Settings';
import { Advisor } from './views/Advisor';

interface PlaidHandler {
  open: () => void;
}

interface PlaidCreateOptions {
  token: string;
  receivedRedirectUri?: string;
  onSuccess: (publicToken: string, metadata: unknown) => void | Promise<void>;
  onExit?: () => void;
}

declare global {
  interface Window {
    Plaid?: {
      create: (options: PlaidCreateOptions) => PlaidHandler;
    };
  }
}

function errorMessage(err: unknown, fallback: string) {
  return err instanceof Error && err.message ? err.message : fallback;
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
        if (!window.Plaid) {
          addToast({ type: 'error', message: 'Plaid SDK failed to load. Check your network connection.' });
          window.history.replaceState({}, '', window.location.pathname);
          return;
        }
        const storedToken = sessionStorage.getItem('plaid_link_token');
        const link_token = storedToken ?? (await plaidApi.createLinkToken()).link_token;
        sessionStorage.removeItem('plaid_link_token');
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
          <Route path="/" element={<Dashboard />} />
          <Route path="/accounts" element={<Accounts />} />
          <Route path="/transactions" element={<Transactions />} />
          <Route path="/cashflow" element={<CashFlow />} />
          <Route path="/budget" element={<Budget />} />
          <Route path="/investments" element={<Investments />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/advisor" element={<Advisor />} />
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
