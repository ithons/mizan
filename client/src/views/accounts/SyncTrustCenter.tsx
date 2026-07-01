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
import type { Account, Holding, SyncHealth, SyncHealthConnection, SyncRun } from '@shared/types';


const syncTone = {
  empty: { color: '#6b6b7a', icon: CreditCard },
  healthy: { color: '#32bfa3', icon: CheckCircle2 },
  stale: { color: '#e2a53f', icon: AlertTriangle },
  attention: { color: '#ef6f8a', icon: CircleAlert },
} satisfies Record<SyncHealth['status'], { color: string; icon: LucideIcon }>;

const connectionTone = {
  fresh: '#32bfa3',
  stale: '#e2a53f',
  never: '#e2a53f',
  attention: '#ef6f8a',
} satisfies Record<SyncHealthConnection['freshness'], string>;

function connectionActionLabel(action: SyncHealthConnection['recommended_action']): string | null {
  switch (action) {
    case 'connect':
      return 'Connect';
    case 'sync':
      return 'Sync';
    case 'reconnect':
      return 'Reconnect';
    case 'retry':
      return 'Retry';
    case 'none':
      return null;
  }
}

export function SyncTrustCenter({
  health,
  onSyncAll,
  onConnectBank,
  onConnectCoinbase,
  onConnectionAction,
  isSyncingAll,
  busyConnectionId,
}: {
  health?: SyncHealth;
  onSyncAll: () => void;
  onConnectBank: () => void;
  onConnectCoinbase: () => void;
  onConnectionAction: (connection: SyncHealthConnection) => void;
  isSyncingAll: boolean;
  busyConnectionId: string | null;
}) {
  const status = health?.status ?? 'empty';
  const tone = syncTone[status];
  const Icon = tone.icon;
  const connections = health?.connections ?? [];

  return (
    <div className="px-3 pb-2">
      <div className="bg-background border border-border rounded p-3">
        <div className="flex items-start justify-between gap-3 mb-2">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 mb-1">
              <Icon size={13} style={{ color: tone.color }} />
              <p className="text-xs font-medium text-text">Sync Trust</p>
            </div>
            <p className="text-xs leading-relaxed text-muted">
              {health?.status_detail ?? 'No connected institutions yet.'}
            </p>
          </div>
          {connections.length > 0 && (
            <button
              className="flex items-center gap-1 text-xs text-muted hover:text-green disabled:opacity-40 flex-shrink-0"
              onClick={onSyncAll}
              disabled={isSyncingAll}
            >
              <RefreshCw size={11} className={isSyncingAll ? 'animate-spin' : ''} />
              Sync
            </button>
          )}
        </div>

        {connections.length > 0 ? (
          <div className="space-y-1.5">
            <div className="grid grid-cols-4 gap-1.5 text-[11px]">
              <div>
                <p className="text-muted">Total</p>
                <p className="font-mono text-text">{health?.connection_count ?? 0}</p>
              </div>
              <div>
                <p className="text-muted">Fresh</p>
                <p className="font-mono text-green">{health?.fresh_count ?? 0}</p>
              </div>
              <div>
                <p className="text-muted">Stale</p>
                <p className="font-mono" style={{ color: (health?.stale_count ?? 0) > 0 ? '#e2a53f' : '#32bfa3' }}>
                  {health?.stale_count ?? 0}
                </p>
              </div>
              <div>
                <p className="text-muted">Issues</p>
                <p className="font-mono" style={{ color: (health?.attention_count ?? 0) > 0 ? '#ef6f8a' : '#32bfa3' }}>
                  {health?.attention_count ?? 0}
                </p>
              </div>
            </div>

            <div className="border-t border-border pt-1.5 space-y-1.5">
              {connections.map((connection) => {
                const actionLabel = connectionActionLabel(connection.recommended_action);
                const busy = busyConnectionId === `${connection.provider}:${connection.id}`;
                return (
                  <div key={`${connection.provider}:${connection.id}`} className="flex items-center justify-between gap-2 text-xs">
                    <div className="min-w-0">
                      <p className="text-text truncate">{connection.institution_name}</p>
                      <p className="text-[11px] text-muted truncate">
                        {connection.account_count} acct{connection.account_count === 1 ? '' : 's'}
                        {connection.last_success_at ? `, ${formatRelativeTime(connection.last_success_at)}` : ', no successful sync'}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <span
                        className="font-mono text-[11px]"
                        style={{ color: connectionTone[connection.freshness] }}
                        title={connection.status_detail}
                      >
                        {connection.status_label}
                      </span>
                      {actionLabel && (
                        <button
                          className="text-muted hover:text-green disabled:opacity-40"
                          onClick={() => onConnectionAction(connection)}
                          disabled={busy}
                        >
                          {busy ? '...' : actionLabel}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="flex gap-2">
            <button
              className="flex-1 flex items-center justify-center gap-1.5 text-xs bg-text text-surface font-medium rounded px-2 py-1.5 hover:opacity-90"
              onClick={onConnectBank}
            >
              <Link size={11} /> Bank
            </button>
            <button
              className="flex-1 flex items-center justify-center gap-1.5 text-xs border border-border text-muted rounded px-2 py-1.5 hover:text-text"
              onClick={onConnectCoinbase}
            >
              <Link size={11} /> Coinbase
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Account Row ─────────────────────────────────────────────────────────────
