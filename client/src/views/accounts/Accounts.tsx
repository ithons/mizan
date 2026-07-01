import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Group, Panel, Separator } from 'react-resizable-panels';
import type { PanelImperativeHandle, PanelSize } from 'react-resizable-panels';
import {
  ChevronDown,
  ChevronUp,
  Plus,
  RefreshCw,
  Eye,
  EyeOff,
  Trash2,
  Edit2,
  MoreHorizontal,
  Link,
  Unlink,
  AlertTriangle,
  CheckCircle2,
  CircleAlert,
  CreditCard,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { accountsApi, coinbaseApi, transactionsApi, investmentsApi, syncApi } from '../../lib/api';
import { formatCurrency, formatDate, formatRelativeTime } from '../../lib/formatters';
import { ACCOUNT_TYPE_LABELS, CATEGORY_COLORS } from '../../lib/constants';
import { useAppStore } from '../../store';
import { Modal } from '../../components/Modal';
import { AmountBadge } from '../../components/AmountBadge';
import { CategoryBadge } from '../../components/CategoryBadge';
import { EmptyState } from '../../components/EmptyState';
import { SkeletonList } from '../../components/SkeletonLoader';
import { ConfirmRemoveModal } from '../../components/ConfirmRemoveModal';
import { SyncActivityPanel } from '../../components/SyncActivityPanel';
import { invalidateFinancialData } from '../../lib/queryInvalidation';
import { parseDecimalInput } from '../../lib/numberInput';
import { advisorRouteState } from '../../lib/advisorRouteState';
import { buildAccountAdvisorPrompt } from '../../lib/advisorPrompts';
import type { Account, Holding, SyncHealth, SyncHealthConnection, SyncRun } from '@shared/types';

import { useOutsideClick, errorMessage } from "./utils";
import { SyncTrustCenter } from './SyncTrustCenter';
import { InstitutionGroup } from './InstitutionGroup';
import { AccountDetail } from './AccountDetail';
import { AddManualAccountModal, EditAccountModal } from './Modals';

export function Accounts() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { addToast } = useAppStore();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [showManualModal, setShowManualModal] = useState(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const handledSetupActionRef = useRef(false);
  useOutsideClick(addMenuRef, addMenuOpen, () => setAddMenuOpen(false));

  // Left panel collapse state (persisted)
  const leftPanelRef = useRef<PanelImperativeHandle | null>(null);
  const [leftCollapsed, setLeftCollapsed] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('mizan:accounts-panel') ?? 'false');
    } catch (err) {
      console.warn('Failed to load account panel preferences', err);
      return false;
    }
  });
  const lastLeftSizeRef = useRef('22');

  const onLeftResize = useCallback((panelSize: PanelSize) => {
    const isNowCollapsed = panelSize.asPercentage === 0;
    setLeftCollapsed(isNowCollapsed);
    if (!isNowCollapsed) {
      lastLeftSizeRef.current = String(Math.round(panelSize.asPercentage));
      localStorage.setItem('mizan:accounts-panel', 'false');
    } else {
      localStorage.setItem('mizan:accounts-panel', 'true');
    }
  }, []);

  const toggleLeft = useCallback(() => {
    if (leftPanelRef.current?.isCollapsed()) {
      leftPanelRef.current.expand();
    } else {
      leftPanelRef.current?.collapse();
    }
  }, []);

  // Edit modal state
  const [editAccount, setEditAccount] = useState<Account | null>(null);

  // Confirm remove modals

  const [confirmDisconnectCoinbase, setConfirmDisconnectCoinbase] = useState(false);
  const [confirmDeleteAccount, setConfirmDeleteAccount] = useState<Account | null>(null);

  const { data: accounts = [], isLoading } = useQuery({
    queryKey: ['accounts'],
    queryFn: accountsApi.list,
  });

  const { data: syncHealth } = useQuery({
    queryKey: ['sync', 'health', 'accounts'],
    queryFn: syncApi.health,
  });

  const { data: syncRuns } = useQuery<SyncRun[]>({
    queryKey: ['sync', 'history', 'accounts'],
    queryFn: () => syncApi.history(2),
  });

  const { data: allHoldings = [] } = useQuery({
    queryKey: ['holdings'],
    queryFn: investmentsApi.holdings,
  });

  // Group holdings by account_id for P&L display in rows
  const holdingsByAccount = allHoldings.reduce<Record<string, Holding[]>>((acc, h) => {
    if (!acc[h.account_id]) acc[h.account_id] = [];
    acc[h.account_id].push(h);
    return acc;
  }, {});

  const hideMutation = useMutation({
    mutationFn: (id: string) => {
      const acc = accounts.find((a) => a.id === id);
      return accountsApi.update(id, { is_hidden: !acc?.is_hidden });
    },
    onSuccess: () => invalidateFinancialData(qc),
  });

  const deleteMutation = useMutation({
    mutationFn: accountsApi.delete,
    onSuccess: () => {
      invalidateFinancialData(qc);
      setSelectedId(null);
      setConfirmDeleteAccount(null);
      addToast({ type: 'success', message: 'Account deleted' });
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const syncAllMutation = useMutation({
    mutationFn: syncApi.run,
    onSuccess: () => {
      invalidateFinancialData(qc);
      addToast({ type: 'success', message: 'Sync complete' });
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const disconnectCoinbaseMutation = useMutation({
    mutationFn: coinbaseApi.disconnect,
    onSuccess: () => {
      invalidateFinancialData(qc);
      setConfirmDisconnectCoinbase(false);
      addToast({ type: 'info', message: 'Coinbase disconnected' });
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const syncCoinbaseMutation = useMutation({
    mutationFn: coinbaseApi.sync,
    onSuccess: (result) => {
      invalidateFinancialData(qc);
      const changes = result.transactionCount + result.staleAccountCount;
      const detail = changes > 0 ? `, ${changes} update(s)` : '';
      addToast({ type: 'success', message: `Coinbase sync complete${detail}` });
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const connectCoinbase = () => {
    setAddMenuOpen(false);
    navigate('/settings?section=coinbase');
  };

  useEffect(() => {
    if (handledSetupActionRef.current) return;

    const connect = searchParams.get('connect');
    const manual = searchParams.get('manual');
    if (connect !== 'bank' && manual !== '1') return;

    handledSetupActionRef.current = true;
    navigate('/accounts', { replace: true });

    if (connect === 'bank') {
      navigate('/settings?section=connections');
      return;
    }

    setShowManualModal(true);
  }, [navigate, searchParams]);

  const handleConnectionAction = (connection: SyncHealthConnection) => {
    if (connection.provider === 'coinbase') {
      if (connection.recommended_action === 'connect' || connection.recommended_action === 'reconnect') {
        connectCoinbase();
        return;
      }
      syncCoinbaseMutation.mutate();
      return;
    }

    if (connection.provider === 'simplefin') {
      if (connection.recommended_action === 'connect' || connection.recommended_action === 'reconnect') {
        navigate(`/settings?section=connections`);
        return;
      }
      if (connection.recommended_action !== 'none') {
        syncAllMutation.mutate();
      }
      return;
    }
  };

  const askAdvisorAboutAccount = (account: Account) => {
    navigate('/advisor', {
      state: advisorRouteState(buildAccountAdvisorPrompt(account)),
    });
  };

  const selectedAccount = accounts.find((a) => a.id === selectedId) ?? null;
  const syncingCoinbaseConnection = syncHealth?.connections.find((connection) => connection.provider === 'coinbase');
  const busyConnectionId = syncCoinbaseMutation.isPending && syncingCoinbaseConnection
      ? `coinbase:${syncingCoinbaseConnection.id}`
      : null;

  const coinbaseAccounts = accounts.filter((a) => a.connection_type === 'coinbase');
  const manualAccounts = accounts.filter((a) => a.is_manual);

  const simplefinAccounts = accounts.filter((a) => a.connection_type === 'simplefin');
  const simplefinGroups = simplefinAccounts.reduce<Record<string, Account[]>>((acc, a) => {
    const key = a.institution_name || 'SimpleFIN';
    if (!acc[key]) acc[key] = [];
    acc[key].push(a);
    return acc;
  }, {});

  const totalAccounts = showHidden ? accounts.length : accounts.filter((a) => !a.is_hidden).length;

  return (
    <Group orientation="horizontal" style={{ width: '100%', height: '100%' }}>
      {/* Left Panel */}
      <Panel
        panelRef={leftPanelRef}
        defaultSize={leftCollapsed ? '0' : lastLeftSizeRef.current}
        minSize="15"
        maxSize="40"
        collapsible
        onResize={onLeftResize}
        style={{ overflow: 'hidden' }}
      >
      <div className="border-r border-border bg-surface flex flex-col h-full overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-text">Accounts</span>
            <button
              onClick={toggleLeft}
              className="w-5 h-5 flex items-center justify-center rounded text-muted hover:text-text hover:bg-black/5 transition-colors"
              title="Hide panel"
            >
              <PanelLeftClose size={13} />
            </button>
          </div>
          <div className="relative" ref={addMenuRef}>
            <button
              className="flex items-center gap-1 text-xs text-green hover:opacity-80"
              onClick={() => setAddMenuOpen((v) => !v)}
            >
              <Plus size={14} /> Add
            </button>
            {addMenuOpen && (
              <div className="absolute right-0 top-6 bg-surface shadow-sm border border-border rounded shadow-lg z-20 w-52 py-1">
                <button
                  className="flex items-center gap-2 w-full px-3 py-2 text-xs text-text hover:bg-black/5"
                  onClick={() => navigate('/settings?section=connections')}
                >
                  <Link size={12} className="text-green" />
                  Connect Bank or Card
                </button>
                <button
                  className="flex items-center gap-2 w-full px-3 py-2 text-xs text-text hover:bg-black/5"
                  onClick={connectCoinbase}
                >
                  <Link size={12} className="text-blue" />
                  Connect Coinbase
                </button>
                <button
                  className="flex items-center gap-2 w-full px-3 py-2 text-xs text-text hover:bg-black/5"
                  onClick={() => { setAddMenuOpen(false); setShowManualModal(true); }}
                >
                  <Plus size={12} className="text-muted" />
                  Add Manual Account
                </button>
              </div>
            )}
          </div>
        </div>

        <SyncTrustCenter
          health={syncHealth}
          onSyncAll={() => syncAllMutation.mutate()}
          onConnectBank={() => navigate('/settings?section=connections')}
          onConnectCoinbase={connectCoinbase}
          onConnectionAction={handleConnectionAction}
          isSyncingAll={syncAllMutation.isPending}
          busyConnectionId={busyConnectionId}
        />

        <div className="px-3 pb-2">
          <SyncActivityPanel runs={syncRuns} title="Recent Sync" />
        </div>

        <div className="flex-1 overflow-y-auto py-2 min-h-0">
          {isLoading ? (
            <div className="px-3 py-2 space-y-2">
              {[...Array(4)].map((_, i) => (
                <div key={i} className="h-3 bg-border/60 rounded animate-pulse" style={{ width: `${55 + (i * 10) % 30}%` }} />
              ))}
            </div>
          ) : (
            <>
              {/* Coinbase group */}
              {coinbaseAccounts.length > 0 && (
                <InstitutionGroup
                  label="Coinbase"
                  accounts={coinbaseAccounts}
                  showHidden={showHidden}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                  onHide={(id) => hideMutation.mutate(id)}
                  onAsk={askAdvisorAboutAccount}
                  onEdit={(id) => {
                    const acc = accounts.find((a) => a.id === id);
                    if (acc) setEditAccount(acc);
                  }}
                  holdingsByAccount={holdingsByAccount}
                  groupType="coinbase"
                  onSyncCoinbase={() => syncCoinbaseMutation.mutate()}
                  onDisconnectCoinbase={() => setConfirmDisconnectCoinbase(true)}
                />
              )}

              {/* SimpleFIN groups */}
              {Object.entries(simplefinGroups).map(([institutionName, grpAccounts]) => (
                <InstitutionGroup
                  key={institutionName}
                  label={institutionName}
                  accounts={grpAccounts}
                  showHidden={showHidden}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                  onHide={(id) => hideMutation.mutate(id)}
                  onAsk={askAdvisorAboutAccount}
                  onEdit={(id) => {
                    const acc = accounts.find((a) => a.id === id);
                    if (acc) setEditAccount(acc);
                  }}
                  holdingsByAccount={holdingsByAccount}
                  groupType="simplefin"
                  onSyncItem={() => syncAllMutation.mutate()}
                  onRemoveItem={() => navigate('/settings?section=connections')}
                />
              ))}

              {/* Manual accounts */}
              {manualAccounts.length > 0 && (
                <InstitutionGroup
                  label="Manual"
                  accounts={manualAccounts}
                  showHidden={showHidden}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                  onHide={(id) => hideMutation.mutate(id)}
                  onAsk={askAdvisorAboutAccount}
                  onDelete={(id) => {
                    const acc = accounts.find((a) => a.id === id);
                    if (acc) setConfirmDeleteAccount(acc);
                  }}
                  onEdit={(id) => {
                    const acc = accounts.find((a) => a.id === id);
                    if (acc) setEditAccount(acc);
                  }}
                  holdingsByAccount={holdingsByAccount}
                  groupType="manual"
                />
              )}

              {totalAccounts === 0 && !isLoading && (
                <EmptyState
                  icon={CreditCard}
                  title="No accounts yet"
                  description="Connect a bank, configure Coinbase, or create a manual account to start building Mizān."
                  action={() => navigate('/settings?section=connections')}
                  actionLabel="Connect Bank"
                  secondaryAction={() => setShowManualModal(true)}
                  secondaryActionLabel="Add Manual"
                />
              )}
            </>
          )}
        </div>

        {/* Show hidden toggle */}
        <div className="px-3 py-2 border-t border-border flex-shrink-0">
          <button
            onClick={() => setShowHidden((v) => !v)}
            className="flex items-center gap-2 text-xs text-muted hover:text-text w-full"
          >
            {showHidden ? <EyeOff size={12} /> : <Eye size={12} />}
            {showHidden ? 'Hide hidden accounts' : 'Show hidden accounts'}
          </button>
        </div>
      </div>
      </Panel>

      <Separator
        className="group cursor-col-resize"
        style={{ width: 5, flexShrink: 0, background: 'var(--color-border)', transition: 'background 0.15s', position: 'relative', overflow: 'visible', zIndex: 10 }}
      >
        <button
          onClick={toggleLeft}
          className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-5 h-8 flex items-center justify-center rounded bg-border border border-border text-muted opacity-0 group-hover:opacity-100 transition-opacity hover:text-text hover:bg-surface z-10"
          title={leftCollapsed ? 'Show accounts panel' : 'Hide accounts panel'}
        >
          {leftCollapsed ? <PanelLeftOpen size={12} /> : <PanelLeftClose size={12} />}
        </button>
      </Separator>

      {/* Right Panel */}
      <Panel minSize="40" style={{ overflow: 'hidden' }}>
        <div className="relative h-full overflow-y-auto bg-background">
          {leftCollapsed && (
            <button
              onClick={toggleLeft}
              className="absolute top-3 left-3 z-20 w-7 h-7 flex items-center justify-center rounded bg-surface shadow-sm border border-border text-muted hover:text-text hover:border-green-50 transition-colors"
              title="Show accounts panel"
            >
              <PanelLeftOpen size={14} />
            </button>
          )}
          {selectedAccount ? (
            <AccountDetail account={selectedAccount} />
          ) : totalAccounts === 0 && !isLoading ? (
            <div className="flex h-full items-center justify-center">
              <EmptyState
                icon={CreditCard}
                title="Connect your first account"
                description="Balances, reports, budgets, and review queues depend on account data."
                action={() => navigate('/settings?section=connections')}
                actionLabel="Connect Bank"
                secondaryAction={() => setShowManualModal(true)}
                secondaryActionLabel="Add Manual"
              />
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-muted">
              <CreditCard size={48} className="mb-4 opacity-20" />
              <p className="text-sm">Select an account to view details</p>
            </div>
          )}
        </div>
      </Panel>

      {/* Modals */}
      <AddManualAccountModal open={showManualModal} onClose={() => setShowManualModal(false)} />

      <EditAccountModal
        open={editAccount != null}
        account={editAccount}
        onClose={() => setEditAccount(null)}
      />

      <ConfirmRemoveModal
        open={confirmDisconnectCoinbase}
        onClose={() => setConfirmDisconnectCoinbase(false)}
        title="Disconnect Coinbase?"
        description="This will remove your Coinbase API credentials. Existing transactions and accounts will be hidden but not deleted."
        confirmLabel="Disconnect Coinbase"
        onConfirm={() => disconnectCoinbaseMutation.mutate()}
        isPending={disconnectCoinbaseMutation.isPending}
      />

      <ConfirmRemoveModal
        open={confirmDeleteAccount != null}
        onClose={() => setConfirmDeleteAccount(null)}
        title={`Delete ${confirmDeleteAccount?.account_name ?? 'Account'}?`}
        description="This will permanently delete this manual account and all its transactions. This cannot be undone."
        confirmLabel="Delete Account"
        onConfirm={() => confirmDeleteAccount && deleteMutation.mutate(confirmDeleteAccount.id)}
        isPending={deleteMutation.isPending}
      />
    </Group>
  );
}
