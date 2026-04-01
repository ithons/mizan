import React from 'react';
import { Routes, Route } from 'react-router-dom';
import { Layout } from './components/Layout';
import { ToastContainer } from './components/Toast';
import { useSyncStatus } from './hooks/useSyncStatus';
import { Dashboard } from './views/Dashboard';
import { Accounts } from './views/Accounts';
import { Transactions } from './views/Transactions';
import { CashFlow } from './views/CashFlow';
import { Budget } from './views/Budget';
import { Reports } from './views/Reports';
import { Settings } from './views/Settings';

function AppRoutes() {
  useSyncStatus();

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
