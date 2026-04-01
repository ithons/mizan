import React, { useEffect } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import {
  Home,
  CreditCard,
  ArrowLeftRight,
  BarChart2,
  PieChart,
  Settings,
  TrendingUp,
  RefreshCw,
  Loader2,
  AlertTriangle,
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { networthApi, plaidApi } from '../lib/api';
import { formatCurrency, formatRelativeTime } from '../lib/formatters';
import { useAppStore } from '../store';

const navItems = [
  { to: '/', label: 'Dashboard', icon: Home, shortcut: '1' },
  { to: '/accounts', label: 'Accounts', icon: CreditCard, shortcut: '2' },
  { to: '/transactions', label: 'Transactions', icon: ArrowLeftRight, shortcut: '3' },
  { to: '/cashflow', label: 'Cash Flow', icon: BarChart2, shortcut: '4' },
  { to: '/budget', label: 'Budget', icon: PieChart, shortcut: '5' },
  { to: '/reports', label: 'Reports', icon: TrendingUp, shortcut: '6' },
  { to: '/settings', label: 'Settings', icon: Settings, shortcut: '7' },
];

export function Sidebar() {
  const navigate = useNavigate();
  const { syncStatus, lastSynced } = useAppStore();

  const { data: netWorthData } = useQuery({
    queryKey: ['networth', 'latest'],
    queryFn: () => networthApi.snapshot(),
    retry: false,
  });

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;

      const key = e.key;
      if (key >= '1' && key <= '7') {
        e.preventDefault();
        const index = parseInt(key, 10) - 1;
        navigate(navItems[index].to);
      }
      if (key === 's') {
        e.preventDefault();
        plaidApi.syncAll().catch(() => {});
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [navigate]);

  const netWorth = netWorthData?.net_worth ?? 0;

  return (
    <aside
      className="flex flex-col bg-surface border-r border-border h-screen overflow-hidden"
      style={{ width: 220, minWidth: 220 }}
    >
      {/* Logo */}
      <div className="px-5 py-5 border-b border-border">
        <span
          className="text-xl font-semibold text-text tracking-wide"
          style={{ fontFamily: 'serif' }}
        >
          Mizān
        </span>
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto py-3">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            className={({ isActive }) =>
              `flex items-center gap-3 px-4 py-2.5 text-sm transition-colors relative group ${
                isActive
                  ? 'text-text bg-[#1e1e22] border-l-2 border-l-[#4ecba3] pl-[14px]'
                  : 'text-muted hover:text-text hover:bg-white/5 border-l-2 border-l-transparent'
              }`
            }
          >
            {({ isActive }) => (
              <>
                <item.icon size={16} className={isActive ? 'text-[#4ecba3]' : ''} />
                <span className="flex-1">{item.label}</span>
                <span className="text-xs text-muted/50 font-mono hidden group-hover:block">
                  ⌘{item.shortcut}
                </span>
              </>
            )}
          </NavLink>
        ))}
      </nav>

      {/* Footer */}
      <div className="px-4 py-4 border-t border-border space-y-3">
        {/* Net Worth */}
        <div>
          <p className="text-xs text-muted mb-0.5">Net Worth</p>
          <p
            className="font-mono text-sm font-medium"
            style={{ color: netWorth >= 0 ? '#4ecba3' : '#e07070' }}
          >
            {formatCurrency(netWorth)}
          </p>
        </div>

        {/* Sync Status */}
        <div className="flex items-center gap-2">
          {syncStatus === 'syncing' && (
            <>
              <Loader2 size={12} className="text-[#4ecba3] animate-spin" />
              <span className="text-xs text-muted">Syncing…</span>
            </>
          )}
          {syncStatus === 'error' && (
            <>
              <AlertTriangle size={12} className="text-[#e07070]" />
              <span className="text-xs text-[#e07070]">Sync error</span>
            </>
          )}
          {syncStatus === 'idle' && (
            <>
              <RefreshCw size={12} className="text-muted" />
              <span className="text-xs text-muted">
                {lastSynced ? formatRelativeTime(lastSynced) : 'Never synced'}
              </span>
            </>
          )}
        </div>
      </div>
    </aside>
  );
}
