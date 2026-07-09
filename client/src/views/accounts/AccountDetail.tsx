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
import { MergeAccountModal } from './MergeAccountModal';
import { SyncActivityPanel } from '../../components/SyncActivityPanel';
import { invalidateFinancialData } from '../../lib/queryInvalidation';
import { parseDecimalInput } from '../../lib/numberInput';
import type { Account, Holding, SyncHealth, SyncHealthConnection, SyncRun } from '@shared/types';

import { AccountRow } from './AccountRow';
import { AccountTypeBadge } from "./AccountRow";
import { EditAccountModal } from './Modals';
import { errorMessage } from "./utils";
import { useOutsideClick } from './utils';

export function AccountDetail({ account }: { account: Account }) {
  const navigate = useNavigate();
  const [tab, setTab] = useState<'transactions' | 'holdings' | 'inv-transactions'>('transactions');
  const isInvestment = ['brokerage', 'ira_traditional', 'ira_roth'].includes(account.type);
  const isCrypto = account.type === 'crypto_wallet';
  const isCredit = account.type === 'credit';
  const hasHoldings = isInvestment || isCrypto;

  const { data: txs, isLoading: txLoading } = useQuery({
    queryKey: ['transactions', 'account', account.id],
    queryFn: () => transactionsApi.list({ accountId: [account.id], limit: 50, page: 1 }),
    enabled: tab === 'transactions',
  });

  const { data: holdings = [], isLoading: holdingsLoading } = useQuery({
    queryKey: ['holdings', account.id],
    queryFn: () => investmentsApi.holdingsByAccount(account.id),
    enabled: hasHoldings,
  });

  const { data: invTxs, isLoading: invTxLoading } = useQuery({
    queryKey: ['inv-transactions', account.id],
    queryFn: () => investmentsApi.transactions({ accountId: account.id }),
    enabled: isInvestment && tab === 'inv-transactions',
  });

  // Investment summary stats
  const costBasis = holdings.reduce((s, h) => s + (h.cost_basis ?? 0), 0);
  const hasCostBasis = holdings.some((h) => h.cost_basis != null);
  const unrealized = hasCostBasis ? account.current_balance - costBasis : null;
  const returnPct = hasCostBasis && costBasis > 0 ? ((account.current_balance - costBasis) / costBasis) * 100 : null;

  // Credit utilization
  const utilization = isCredit && account.credit_limit
    ? (account.current_balance / account.credit_limit) * 100
    : null;
  const utilizationColor = utilization == null ? '#7a6c5d'
    : utilization > 70 ? '#b5654a'
    : utilization > 30 ? '#ce8642'
    : '#c9963a';

  const typeLabel = {
    brokerage: 'Brokerage',
    ira_traditional: 'Traditional IRA',
    ira_roth: 'Roth IRA',
  }[account.type as string] ?? ACCOUNT_TYPE_LABELS[account.type] ?? account.type;

  const [mergeModalOpen, setMergeModalOpen] = useState(false);
  const [editingType, setEditingType] = useState(false);
  const qc = useQueryClient();
  const updateTypeMutation = useMutation({
    mutationFn: (type: string) => accountsApi.update(account.id, { type: type as Account['type'] }),
    onSuccess: () => {
      invalidateFinancialData(qc);
      setEditingType(false);
    },
  });

  return (
    <div className="flex flex-col h-full">
        {/* Header */}
        <div className="px-6 py-4 border-b border-border">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-3">
              <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: account.color || '#7a6c5d' }} />
              <h2 className="text-base font-semibold text-text">{account.account_name}</h2>
              {editingType ? (
                <select
                  autoFocus
                  defaultValue={account.type}
                  disabled={updateTypeMutation.isPending}
                  onChange={(e) => updateTypeMutation.mutate(e.target.value)}
                  onBlur={() => setEditingType(false)}
                  className="text-xs bg-background border border-border rounded px-1.5 py-0.5"
                >
                  {Object.entries(ACCOUNT_TYPE_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              ) : (
                <button
                  onClick={() => setEditingType(true)}
                  className="flex items-center gap-1 group"
                  title="Correct this account's type if it was misclassified by sync"
                >
                  <AccountTypeBadge type={account.type} />
                  <Edit2 size={10} className="text-muted opacity-0 group-hover:opacity-100 transition-opacity" />
                </button>
              )}
              {(account.type === 'ira_traditional' || account.type === 'ira_roth') && (
                <span className="text-xs bg-info/20 text-info px-2 py-0.5 rounded">Tax-Advantaged</span>
              )}
            </div>
            
            {/* Merge Button */}
            {!account.is_manual && (
              <button
                onClick={() => setMergeModalOpen(true)}
                className="px-2 py-1 text-[11px] text-muted hover:text-text border border-border rounded flex items-center gap-1 transition-colors"
                title="Merge another connection into this one"
              >
                <Link size={12} />
                Merge
              </button>
            )}
          </div>

        {/* Cash/Checking/Savings: just balance */}
        {!isCredit && !isInvestment && !isCrypto && (
          <>
            <p className="font-mono text-2xl" style={{ color: account.is_liability ? '#b5654a' : '#c9963a' }}>
              {formatCurrency(account.current_balance)}
            </p>
            <div className="flex items-center gap-2 mt-1 text-xs text-muted">
              {account.institution_name && <span>{account.institution_name}</span>}
              {account.mask && <><span>·</span><span className="font-mono">••{account.mask}</span></>}
            </div>
          </>
        )}

        {/* Credit card: 4-stat grid */}
        {isCredit && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-xs text-muted">
              {account.institution_name && <span>{account.institution_name}</span>}
              {account.mask && <><span>·</span><span className="font-mono">••{account.mask}</span></>}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-background border border-border rounded p-3">
                <p className="text-xs text-muted mb-1">Balance Owed</p>
                <p className="font-mono text-sm text-negative">{formatCurrency(account.current_balance)}</p>
              </div>
              <div className="bg-background border border-border rounded p-3">
                <p className="text-xs text-muted mb-1">Credit Limit</p>
                <p className="font-mono text-sm text-text">
                  {account.credit_limit != null ? formatCurrency(account.credit_limit) : '-'}
                </p>
              </div>
              <div className="bg-background border border-border rounded p-3">
                <p className="text-xs text-muted mb-1">Available Credit</p>
                <p className="font-mono text-sm text-positive">
                  {account.available_balance != null ? formatCurrency(account.available_balance) : '-'}
                </p>
              </div>
              <div className="bg-background border border-border rounded p-3">
                <p className="text-xs text-muted mb-1">Utilization</p>
                <div className="flex items-center gap-2">
                  <p className="font-mono text-sm" style={{ color: utilizationColor }}>
                    {utilization != null ? `${utilization.toFixed(0)}%` : '-'}
                  </p>
                  {utilization != null && (
                    <div className="flex-1 h-1.5 bg-border rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all"
                        style={{ width: `${Math.min(utilization, 100)}%`, backgroundColor: utilizationColor }}
                      />
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Investment: 4-stat grid */}
        {isInvestment && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-xs text-muted">
              {account.institution_name && <span>{account.institution_name}</span>}
              {account.mask && <><span>·</span><span className="font-mono">••{account.mask}</span></>}
              <span>·</span><span>{typeLabel}</span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-background border border-border rounded p-3">
                <p className="text-xs text-muted mb-1">Portfolio Value</p>
                <p className="font-mono text-sm text-positive">{formatCurrency(account.current_balance)}</p>
              </div>
              <div className="bg-background border border-border rounded p-3">
                <p className="text-xs text-muted mb-1">Cost Basis</p>
                <p className="font-mono text-sm text-text">
                  {hasCostBasis ? formatCurrency(costBasis) : '-'}
                </p>
              </div>
              <div className="bg-background border border-border rounded p-3">
                <p className="text-xs text-muted mb-1">Unrealized G/L</p>
                <p className="font-mono text-sm" style={{ color: unrealized == null ? '#7a6c5d' : unrealized >= 0 ? '#c9963a' : '#b5654a' }}>
                  {unrealized != null ? `${unrealized >= 0 ? '+' : ''}${formatCurrency(unrealized)}` : '-'}
                </p>
              </div>
              <div className="bg-background border border-border rounded p-3">
                <p className="text-xs text-muted mb-1">Total Return</p>
                <p className="font-mono text-sm" style={{ color: returnPct == null ? '#7a6c5d' : returnPct >= 0 ? '#c9963a' : '#b5654a' }}>
                  {returnPct != null ? `${returnPct >= 0 ? '+' : ''}${returnPct.toFixed(2)}%` : '-'}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Crypto */}
        {isCrypto && (
          <div className="flex gap-6 mt-1">
            <div>
              <p className="text-xs text-muted mb-1">Native Balance</p>
              <p className="font-mono text-lg text-text">
                {account.native_balance?.toFixed(8) ?? '-'} {account.native_currency ?? ''}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted mb-1">USD Value</p>
              <p className="font-mono text-lg text-positive">{formatCurrency(account.current_balance)}</p>
            </div>
          </div>
        )}
      </div>

      {/* Tabs (investment/crypto only) */}
      {hasHoldings && (
        <div className="flex gap-1 px-6 py-2 border-b border-border">
          {(isInvestment ? ['holdings', 'transactions', 'inv-transactions'] as const : ['holdings', 'transactions'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-3 py-1 text-xs rounded transition-colors ${tab === t ? 'bg-positive-10 text-positive' : 'text-muted hover:text-text'}`}
            >
              {t === 'inv-transactions' ? 'Inv Transactions' : t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {/* Holdings */}
        {tab === 'holdings' && hasHoldings && (
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-surface border-b border-border z-10">
              <tr>
                {['Ticker', 'Name', 'Qty', 'Price', 'Value', 'Cost Basis', 'P&L'].map((h) => (
                  <th key={h} className="text-left px-4 py-2.5 text-muted font-medium uppercase tracking-wider">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {holdingsLoading ? (
                <SkeletonList rows={6} cols={7} />
              ) : (holdings).map((h) => {
                const unr = h.cost_basis != null ? h.institution_value - h.cost_basis : null;
                return (
                  <tr key={h.id} className="border-b border-border hover:bg-black/5">
                    <td className="px-4 py-2.5 font-mono text-info font-medium">{h.ticker ?? '-'}</td>
                    <td className="px-4 py-2.5 text-text truncate max-w-[160px]" title={h.security_name ?? ''}>{h.security_name}</td>
                    <td className="px-4 py-2.5 font-mono text-muted">{h.quantity.toFixed(4)}</td>
                    <td className="px-4 py-2.5 font-mono text-muted">{formatCurrency(h.institution_price)}</td>
                    <td className="px-4 py-2.5 font-mono text-text">{formatCurrency(h.institution_value)}</td>
                    <td className="px-4 py-2.5 font-mono text-muted">{h.cost_basis != null ? formatCurrency(h.cost_basis) : '-'}</td>
                    <td className="px-4 py-2.5 font-mono" style={{ color: unr != null ? (unr >= 0 ? '#c9963a' : '#b5654a') : '#7a6c5d' }}>
                      {unr != null ? `${unr >= 0 ? '+' : ''}${formatCurrency(unr)}` : '-'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {/* Investment Transactions */}
        {tab === 'inv-transactions' && isInvestment && (
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-surface border-b border-border z-10">
              <tr>
                {['Date', 'Type', 'Security', 'Qty', 'Price', 'Amount'].map((h) => (
                  <th key={h} className="text-left px-4 py-2.5 text-muted font-medium uppercase tracking-wider">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {invTxLoading ? (
                <SkeletonList rows={6} cols={6} />
              ) : (invTxs ?? []).map((tx) => (
                <tr key={tx.id} className="border-b border-border hover:bg-black/5">
                  <td className="px-4 py-2.5 font-mono text-muted">{formatDate(tx.date)}</td>
                  <td className="px-4 py-2.5">
                    <span className={`px-1.5 py-0.5 rounded text-xs ${
                      tx.type === 'buy' ? 'bg-positive-10 text-positive' :
                      tx.type === 'sell' ? 'bg-negative/10 text-negative' :
                      tx.type === 'dividend' ? 'bg-info/10 text-info' :
                      'bg-border/50 text-muted'
                    }`}>
                      {tx.type}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 font-mono text-info">{tx.ticker ?? tx.security_name ?? tx.name}</td>
                  <td className="px-4 py-2.5 font-mono text-muted">{tx.quantity?.toFixed(4) ?? '-'}</td>
                  <td className="px-4 py-2.5 font-mono text-muted">{tx.price != null ? formatCurrency(tx.price) : '-'}</td>
                  <td className="px-4 py-2.5"><AmountBadge amount={tx.amount} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {tab === 'transactions' && (
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-surface border-b border-border z-10">
              <tr>
                {['Date', 'Merchant', 'Category', 'Amount'].map((h) => (
                  <th key={h} className="text-left px-4 py-2.5 text-muted font-medium uppercase tracking-wider">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {txLoading ? (
                <SkeletonList rows={8} cols={4} />
              ) : (txs?.data ?? []).map((tx) => (
                <tr key={tx.id} className="border-b border-border hover:bg-black/5">
                  <td className="px-4 py-2.5 font-mono text-muted">{formatDate(tx.date)}</td>
                  <td className="px-4 py-2.5 text-text truncate max-w-[200px]" title={tx.merchant_name || tx.original_name}>
                    {tx.merchant_name || tx.original_name}
                  </td>
                  <td className="px-4 py-2.5">
                    {tx.category_name ? (
                      <CategoryBadge name={tx.category_name} color={tx.category_color} />
                    ) : (
                      <span className="text-muted">Uncategorized</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5"><AmountBadge amount={tx.amount} /></td>
                </tr>
              ))}
              {!txLoading && (txs?.data ?? []).length === 0 && (
                <tr>
                  <td colSpan={4}>
                    <EmptyState
                      icon={CreditCard}
                      title="No transactions found"
                      description="Run sync or inspect the full ledger if this account should have recent activity."
                      action={() => navigate('/transactions')}
                      actionLabel="View Ledger"
                    />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      <MergeAccountModal 
        isOpen={mergeModalOpen} 
        onClose={() => setMergeModalOpen(false)} 
        targetAccount={account} 
      />
    </div>
  );
}

// ─── Edit Manual Account Modal ────────────────────────────────────────────────
