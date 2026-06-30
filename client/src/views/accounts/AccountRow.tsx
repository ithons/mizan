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
  Sparkles,
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

export function AccountTypeBadge({ type }: { type: string }) {
  return (
    <span className="text-xs text-muted bg-border/50 px-1.5 py-0.5 rounded flex-shrink-0">
      {ACCOUNT_TYPE_LABELS[type] ?? type}
    </span>
  );
}

export function AccountRow({
  account,
  selected,
  onSelect,
  onHide,
  onAsk,
  onDelete,
  onEdit,
  holdingsByAccount,
  showHidden,
}: {
  account: Account;
  selected: boolean;
  onSelect: () => void;
  onHide: () => void;
  onAsk: () => void;
  onDelete?: () => void;
  onEdit?: () => void;
  holdingsByAccount: Record<string, Holding[]>;
  showHidden: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useOutsideClick(menuRef, menuOpen, () => setMenuOpen(false));

  const isHidden = account.is_hidden;
  const isInvestment = ['brokerage', 'ira_traditional', 'ira_roth'].includes(account.type);
  const isCredit = account.type === 'credit';

  // Compute P&L for investment accounts
  const holdings = holdingsByAccount[account.id] ?? [];
  const costBasis = holdings.reduce((s, h) => s + (h.cost_basis ?? 0), 0);
  const hasCostBasis = holdings.some((h) => h.cost_basis != null);
  const unrealized = hasCostBasis ? account.current_balance - costBasis : null;
  const returnPct = hasCostBasis && costBasis > 0 ? ((account.current_balance - costBasis) / costBasis) * 100 : null;

  // Credit utilization
  const utilization = isCredit && account.credit_limit ? (account.current_balance / account.credit_limit) * 100 : null;

  return (
    <div
      className={`flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-white/3 group relative transition-opacity ${
        selected ? 'bg-white/5' : ''
      } ${isHidden ? 'opacity-40' : ''}`}
      onClick={onSelect}
    >
      <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: account.color || '#6b6b7a' }} />
      <div className="flex-1 min-w-0">
        <p className={`text-sm text-text truncate ${isHidden ? 'line-through' : ''}`} title={account.account_name}>
          {account.account_name}
        </p>
        <div className="flex items-center gap-1.5">
          <p className="text-xs text-muted font-mono">{account.mask ? `••${account.mask}` : account.currency}</p>
          {isInvestment && unrealized != null && (
            <span className="text-xs font-mono" style={{ color: unrealized >= 0 ? '#32bfa3' : '#ef6f8a' }}>
              {unrealized >= 0 ? '+' : ''}{formatCurrency(unrealized)}
              {returnPct != null && ` (${returnPct >= 0 ? '+' : ''}${returnPct.toFixed(1)}%)`}
            </span>
          )}
          {isCredit && utilization != null && (
            <span
              className="text-xs font-mono"
              style={{ color: utilization > 70 ? '#ef6f8a' : utilization > 30 ? '#e2a53f' : '#32bfa3' }}
            >
              {utilization.toFixed(0)}% used
            </span>
          )}
        </div>
      </div>
      <AccountTypeBadge type={account.type} />
      <span
        className="font-mono text-sm flex-shrink-0"
        style={{ color: account.is_liability ? '#ef6f8a' : '#32bfa3' }}
      >
        {formatCurrency(account.current_balance)}
      </span>
      <button
        className="opacity-0 group-hover:opacity-100 p-1 text-muted hover:text-blue transition-all"
        onClick={(e) => { e.stopPropagation(); onAsk(); }}
        title="Ask advisor"
      >
        <Sparkles size={13} />
      </button>

      {/* Kebab */}
      <div className="relative" ref={menuRef} onClick={(e) => e.stopPropagation()}>
        <button
          className="opacity-0 group-hover:opacity-100 p-1 text-muted hover:text-text transition-all"
          onClick={() => setMenuOpen((v) => !v)}
        >
          <MoreHorizontal size={14} />
        </button>
        {menuOpen && (
          <div className="absolute right-0 top-6 bg-surface shadow-sm border border-border rounded shadow-lg z-20 w-44 py-1">
            <button
              className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-muted hover:text-text hover:bg-white/5"
              onClick={() => { onHide(); setMenuOpen(false); }}
            >
              {isHidden ? <Eye size={12} /> : <EyeOff size={12} />}
              {isHidden ? 'Show Account' : 'Hide Account'}
            </button>
            {account.is_manual && onEdit && (
              <button
                className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-muted hover:text-text hover:bg-white/5"
                onClick={() => { onEdit(); setMenuOpen(false); }}
              >
                <Edit2 size={12} />
                Edit Account
              </button>
            )}
            {account.is_manual && onDelete && (
              <>
                <div className="border-t border-border my-1" />
                <button
                  className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-rose hover:bg-white/5"
                  onClick={() => { onDelete(); setMenuOpen(false); }}
                >
                  <Trash2 size={12} />
                  Delete Account
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Institution Group ────────────────────────────────────────────────────────
