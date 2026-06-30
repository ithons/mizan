import React, { useEffect } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import {
  Home,
  CreditCard,
  ArrowLeftRight,
  ListChecks,
  BarChart2,
  PieChart,
  WalletCards,
  Target,
  CalendarDays,
  Settings,
  TrendingUp,
  BrainCircuit,
  RefreshCw,
  Loader2,
  AlertTriangle,
  PanelLeftClose,
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { networthApi, syncApi } from '../lib/api';
import { formatCurrency, formatRelativeTime } from '../lib/formatters';
import { useAppStore } from '../store';

function compactCurrency(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}k`;
  return `$${n.toFixed(0)}`;
}

const navItems = [
  { to: '/', label: 'Dashboard', icon: Home, shortcut: '1' },
  { to: '/accounts', label: 'Accounts', icon: CreditCard, shortcut: '2' },
  { to: '/review', label: 'Review', icon: ListChecks, shortcut: '3' },
  { to: '/transactions', label: 'Transactions', icon: ArrowLeftRight, shortcut: '4' },
  { to: '/cashflow', label: 'Cash Flow', icon: BarChart2, shortcut: '5' },
  { to: '/bills', label: 'Bills', icon: CalendarDays, shortcut: '6' },
  { to: '/budget', label: 'Budget', icon: WalletCards, shortcut: '7' },
  { to: '/goals', label: 'Goals', icon: Target, shortcut: '8' },
  { to: '/investments', label: 'Investments', icon: TrendingUp, shortcut: '9' },
  { to: '/reports', label: 'Reports', icon: PieChart },
  { to: '/advisor', label: 'AI Advisor', icon: BrainCircuit },
  { to: '/settings', label: 'Settings', icon: Settings, shortcut: '0', separator: true },
];

interface SidebarProps {
  collapsed?: boolean;
  onToggle?: () => void;
}

export function Sidebar({ collapsed = false, onToggle }: SidebarProps) {
  const navigate = useNavigate();
  const { syncStatus, lastSynced, addToast } = useAppStore();

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
      const shortcutItem = navItems.find((item) => item.shortcut === key);
      if (shortcutItem) {
        e.preventDefault();
        navigate(shortcutItem.to);
      }
      if (key === 's') {
        e.preventDefault();
        syncApi.run().catch((err: unknown) => {
          addToast({ type: 'error', message: err instanceof Error ? err.message : 'Sync failed' });
        });
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [addToast, navigate]);

  const netWorth = netWorthData?.net_worth ?? 0;
  const totalAssets = netWorthData?.total_assets ?? 0;
  const totalLiabilities = netWorthData?.total_liabilities ?? 0;

  return (
    <aside className="flex flex-col bg-background border-r border-border h-full w-full overflow-hidden ">
      {/* Logo + collapse toggle */}
      <div className="px-4 py-4 border-b border-border flex items-center justify-between gap-2 flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="w-6 h-6 rounded bg-text text-surface flex items-center justify-center font-bold flex-shrink-0 shadow-sm">
            م
          </span>
          <span
            className="text-lg font-semibold text-text tracking-wide truncate"
            style={{ fontFamily: 'ui-sans-serif, system-ui, sans-serif', letterSpacing: '-0.02em', fontWeight: 600 }}
          >
            Mizān
          </span>
        </div>
        {onToggle && (
          <button
            onClick={onToggle}
            className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded text-muted hover:text-text hover:bg-blue/10 transition-colors"
            title="Hide sidebar (drag handle to resize)"
          >
            <PanelLeftClose size={14} />
          </button>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto py-3">
        {navItems.map((item) => (
          <React.Fragment key={item.to}>
            {item.separator && <div className="border-t border-border mx-4 my-1" />}
            <NavLink
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                `flex items-center gap-3 px-4 py-2.5 text-sm transition-colors relative group ${
                  isActive
                    ? 'text-text bg-black/5 font-medium'
                    : 'text-muted hover:text-text hover:bg-black/5'
                }`
              }
            >
              {({ isActive }) => (
                <>
                  <item.icon size={16} className={isActive ? 'text-text' : ''} />
                  <span className="flex-1 truncate">{item.label}</span>
                  {item.shortcut && (
                    <span className="text-xs text-muted/50 font-mono hidden group-hover:block flex-shrink-0">
                      ⌘{item.shortcut}
                    </span>
                  )}
                </>
              )}
            </NavLink>
          </React.Fragment>
        ))}
      </nav>

      {/* Footer */}
      <div className="px-4 py-4 border-t border-border space-y-3 flex-shrink-0">
        {/* Net Worth */}
        <div>
          <p className="text-xs text-muted mb-0.5">Net Worth</p>
          <p className="font-mono text-sm font-medium truncate text-text">
            {formatCurrency(netWorth)}
          </p>
          {totalAssets > 0 && (
            <p className="text-[10px] text-muted mt-0.5 truncate">
              ↑ {compactCurrency(totalAssets)} assets
              {totalLiabilities > 0 && <> · ↓ {compactCurrency(totalLiabilities)} liab</>}
            </p>
          )}
        </div>
        {/* Sync Status */}
        <div className="flex items-center gap-2">
          {syncStatus === 'syncing' && (
            <>
              <Loader2 size={12} className="text-green animate-spin flex-shrink-0" />
              <span className="text-xs text-muted truncate">Syncing...</span>
            </>
          )}
          {syncStatus === 'error' && (
            <>
              <AlertTriangle size={12} className="text-rose flex-shrink-0" />
              <span className="text-xs text-rose truncate">Sync error</span>
            </>
          )}
          {syncStatus === 'idle' && (
            <>
              <RefreshCw size={12} className="text-muted flex-shrink-0" />
              <span className="text-xs text-muted truncate">
                {lastSynced ? formatRelativeTime(lastSynced) : 'Never synced'}
              </span>
            </>
          )}
        </div>
      </div>
    </aside>
  );
}
