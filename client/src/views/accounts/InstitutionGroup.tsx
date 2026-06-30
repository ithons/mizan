import { useOutsideClick } from "./utils";

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
import { accountsApi, plaidApi, coinbaseApi, transactionsApi, investmentsApi, syncApi } from '../../lib/api';
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
import { loadPlaidLink } from '../../lib/plaidLink';
import { invalidateFinancialData } from '../../lib/queryInvalidation';
import { parseDecimalInput } from '../../lib/numberInput';
import type { Account, PlaidItem, Holding, SyncHealth, SyncHealthConnection, SyncRun } from '@shared/types';

import { AccountRow } from './AccountRow';

export function InstitutionGroup({
  label,
  sublabel,
  accounts,
  showHidden,
  selectedId,
  onSelect,
  onHide,
  onDelete,
  onEdit,
  holdingsByAccount,
  groupType,
  plaidItem,
  onSyncItem,
  onRemoveItem,
  onReauthItem,
  onDisconnectCoinbase,
  onSyncCoinbase,
}: {
  label: string;
  sublabel?: string;
  accounts: Account[];
  showHidden: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onHide: (id: string) => void;
  onDelete?: (id: string) => void;
  onEdit?: (id: string) => void;
  holdingsByAccount: Record<string, Holding[]>;
  groupType: 'plaid' | 'coinbase' | 'manual';
  plaidItem?: PlaidItem;
  onSyncItem?: () => void;
  onRemoveItem?: () => void;
  onReauthItem?: () => void;
  onDisconnectCoinbase?: () => void;
  onSyncCoinbase?: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useOutsideClick(menuRef, menuOpen, () => setMenuOpen(false));

  const visibleAccounts = showHidden ? accounts : accounts.filter((a) => !a.is_hidden);
  if (visibleAccounts.length === 0 && !showHidden) return null;
  if (accounts.length === 0) return null;

  const total = visibleAccounts.reduce(
    (sum, a) => sum + (a.is_liability ? -a.current_balance : a.current_balance),
    0
  );
  const needsReauth = plaidItem?.status === 'reauth_required';

  return (
    <div className="mb-1">
      <div className="flex items-center px-3 py-1.5 group/header">
        <button
          className="flex items-center gap-1.5 flex-1 min-w-0 text-left"
          onClick={() => setCollapsed((v) => !v)}
        >
          <span className="text-xs font-medium text-muted uppercase tracking-wider truncate">{label}</span>
          {needsReauth && (
            <span title="Reconnect required"><AlertTriangle size={11} className="text-amber flex-shrink-0" /></span>
          )}
          {sublabel && <span className="text-xs text-muted/50 font-normal normal-case tracking-normal">{sublabel}</span>}
        </button>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <span className="font-mono text-xs" style={{ color: total >= 0 ? '#32bfa3' : '#ef6f8a' }}>
            {formatCurrency(total)}
          </span>
          {(groupType === 'plaid' || groupType === 'coinbase') && (
            <div className="relative" ref={menuRef} onClick={(e) => e.stopPropagation()}>
              <button
                className="opacity-0 group-hover/header:opacity-100 p-0.5 text-muted hover:text-text transition-all"
                onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }}
              >
                <MoreHorizontal size={12} />
              </button>
              {menuOpen && (
                <div className="absolute right-0 top-5 bg-surface shadow-sm border border-border rounded shadow-lg z-30 w-44 py-1">
                  {groupType === 'plaid' && (
                    <>
                      <button
                        className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-muted hover:text-text hover:bg-white/5"
                        onClick={() => { onSyncItem?.(); setMenuOpen(false); }}
                      >
                        <RefreshCw size={12} /> Sync Institution
                      </button>
                      {needsReauth && (
                        <button
                          className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-amber hover:bg-white/5"
                          onClick={() => { onReauthItem?.(); setMenuOpen(false); }}
                        >
                          <Unlink size={12} /> Reconnect
                        </button>
                      )}
                      <div className="border-t border-border my-1" />
                      <button
                        className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-rose hover:bg-white/5"
                        onClick={() => { onRemoveItem?.(); setMenuOpen(false); }}
                      >
                        <Trash2 size={12} /> Remove Institution
                      </button>
                    </>
                  )}
                  {groupType === 'coinbase' && (
                    <>
                      <button
                        className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-muted hover:text-text hover:bg-white/5"
                        onClick={() => { onSyncCoinbase?.(); setMenuOpen(false); }}
                      >
                        <RefreshCw size={12} /> Sync Coinbase
                      </button>
                      <div className="border-t border-border my-1" />
                      <button
                        className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-rose hover:bg-white/5"
                        onClick={() => { onDisconnectCoinbase?.(); setMenuOpen(false); }}
                      >
                        <Unlink size={12} /> Disconnect Coinbase
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          )}
          <button onClick={() => setCollapsed((v) => !v)} className="text-muted hover:text-text">
            {collapsed ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
          </button>
        </div>
      </div>
      {!collapsed && (
        <div>
          {visibleAccounts.map((acc) => (
            <AccountRow
              key={acc.id}
              account={acc}
              selected={selectedId === acc.id}
              onSelect={() => onSelect(acc.id)}
              onHide={() => onHide(acc.id)}
              onDelete={onDelete ? () => onDelete(acc.id) : undefined}
              onEdit={onEdit ? () => onEdit(acc.id) : undefined}
              holdingsByAccount={holdingsByAccount}
              showHidden={showHidden}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Account Detail ──────────────────────────────────────────────────────────
