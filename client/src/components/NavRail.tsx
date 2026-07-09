import { useEffect } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { syncApi } from '../lib/api';
import { formatCompactRelative } from '../lib/formatters';
import { useAppStore } from '../store';

const navItems = [
  { to: '/', label: 'Today', shortcut: '1' },
  { to: '/accounts', label: 'Accounts', shortcut: '2' },
  { to: '/transactions', label: 'Transactions', shortcut: '3' },
  { to: '/cash-flow', label: 'Cash flow', shortcut: '4' },
  { to: '/budget', label: 'Budget', shortcut: '5' },
  { to: '/bills', label: 'Bills', shortcut: '6' },
  { to: '/goals', label: 'Goals', shortcut: '7' },
  { to: '/investments', label: 'Investments', shortcut: '8' },
  { to: '/advisor', label: 'Advisor', shortcut: '9' },
];

const settingsItem = { to: '/settings', label: 'Settings', shortcut: '0' };

function RailItem({ to, label }: { to: string; label: string }) {
  return (
    <NavLink
      to={to}
      end={to === '/'}
      title={label}
      className="group flex items-center justify-center gap-[11px] px-2 py-[9px] xl:justify-start xl:px-[22px]"
    >
      {({ isActive }) => (
        <>
          <span
            className={`h-[7px] w-[7px] flex-shrink-0 rounded-full transition-colors ${
              isActive ? 'bg-ink' : 'border-[1.5px] border-dot bg-transparent group-hover:border-muted'
            }`}
          />
          <span
            className={`hidden text-sm transition-colors xl:block ${
              isActive ? 'font-medium text-ink' : 'text-muted group-hover:text-ink'
            }`}
          >
            {label}
          </span>
        </>
      )}
    </NavLink>
  );
}

export function NavRail() {
  const navigate = useNavigate();
  const { syncStatus, lastSynced, addToast } = useAppStore();

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      const item = [...navItems, settingsItem].find((i) => i.shortcut === e.key);
      if (item) {
        e.preventDefault();
        navigate(item.to);
      }
      if (e.key === 's') {
        e.preventDefault();
        syncApi.run().catch((err: unknown) => {
          addToast({ type: 'error', message: err instanceof Error ? err.message : 'Sync failed' });
        });
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [addToast, navigate]);

  const syncTitle =
    syncStatus === 'syncing'
      ? 'Syncing…'
      : syncStatus === 'error'
        ? 'Sync error'
        : lastSynced
          ? `Synced ${formatCompactRelative(lastSynced)}`
          : 'Not synced yet';

  return (
    <nav
      aria-label="Primary"
      className="flex h-full w-14 flex-shrink-0 flex-col border-l border-line-2 bg-rail py-[26px] xl:w-[148px]"
    >
      <div className="flex items-center justify-center gap-[9px] px-2 pb-[22px] xl:justify-start xl:px-[22px]">
        <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md bg-ink text-sm font-semibold text-paper">
          م
        </span>
        <span className="hidden font-serif text-[17px] text-ink xl:block">mizān</span>
      </div>

      <div className="flex flex-1 flex-col gap-0.5 overflow-y-auto py-2">
        {navItems.map((item) => (
          <RailItem key={item.to} to={item.to} label={item.label} />
        ))}
      </div>

      <div className="px-2 pt-[18px] xl:px-[22px]">
        <NavLink
          to={settingsItem.to}
          title="Settings"
          className="group mb-3.5 flex items-center justify-center gap-[11px] xl:justify-start"
        >
          {({ isActive }) => (
            <>
              <span
                className={`h-[7px] w-[7px] flex-shrink-0 rounded-full transition-colors ${
                  isActive ? 'bg-ink' : 'border-[1.5px] border-dot bg-transparent group-hover:border-muted'
                }`}
              />
              <span
                className={`hidden text-sm transition-colors xl:block ${
                  isActive ? 'font-medium text-ink' : 'text-muted group-hover:text-ink'
                }`}
              >
                Settings
              </span>
            </>
          )}
        </NavLink>
        <div className="flex items-center justify-center gap-2 text-xs text-muted-2 xl:justify-start" title={syncTitle}>
          <span
            className={`h-[7px] w-[7px] flex-shrink-0 rounded-full ${
              syncStatus === 'error' ? 'bg-clay' : 'bg-sage-soft'
            } ${syncStatus === 'syncing' ? 'animate-pulse' : ''}`}
          />
          <span className="hidden truncate xl:block">{syncTitle}</span>
        </div>
      </div>
    </nav>
  );
}
