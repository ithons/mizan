import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
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
  CreditCard,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react';
import { accountsApi, plaidApi, coinbaseApi, transactionsApi, investmentsApi } from '../lib/api';
import { formatCurrency, formatDate, formatRelativeTime } from '../lib/formatters';
import { ACCOUNT_TYPE_LABELS, CATEGORY_COLORS } from '../lib/constants';
import { useAppStore } from '../store';
import { Modal } from '../components/Modal';
import { AmountBadge } from '../components/AmountBadge';
import { CategoryBadge } from '../components/CategoryBadge';
import { SkeletonList } from '../components/SkeletonLoader';
import { ConfirmRemoveModal } from '../components/ConfirmRemoveModal';
import { loadPlaidLink } from '../lib/plaidLink';
import { invalidateFinancialData } from '../lib/queryInvalidation';
import type { Account, PlaidItem, Holding } from '@shared/types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function AccountTypeBadge({ type }: { type: string }) {
  return (
    <span className="text-xs text-muted bg-border/50 px-1.5 py-0.5 rounded flex-shrink-0">
      {ACCOUNT_TYPE_LABELS[type] ?? type}
    </span>
  );
}

function useOutsideClick(ref: React.RefObject<HTMLElement | null>, active: boolean, cb: () => void) {
  useEffect(() => {
    if (!active) return;
    const handler = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) cb();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [active, ref, cb]);
}

function errorMessage(err: unknown, fallback: string) {
  return err instanceof Error && err.message ? err.message : fallback;
}

// ─── Account Row ─────────────────────────────────────────────────────────────

function AccountRow({
  account,
  selected,
  onSelect,
  onHide,
  onDelete,
  onEdit,
  holdingsByAccount,
  showHidden,
}: {
  account: Account;
  selected: boolean;
  onSelect: () => void;
  onHide: () => void;
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
            <span className="text-xs font-mono" style={{ color: unrealized >= 0 ? '#4ecba3' : '#e07070' }}>
              {unrealized >= 0 ? '+' : ''}{formatCurrency(unrealized)}
              {returnPct != null && ` (${returnPct >= 0 ? '+' : ''}${returnPct.toFixed(1)}%)`}
            </span>
          )}
          {isCredit && utilization != null && (
            <span
              className="text-xs font-mono"
              style={{ color: utilization > 70 ? '#e07070' : utilization > 30 ? '#f0c040' : '#4ecba3' }}
            >
              {utilization.toFixed(0)}% used
            </span>
          )}
        </div>
      </div>
      <AccountTypeBadge type={account.type} />
      <span
        className="font-mono text-sm flex-shrink-0"
        style={{ color: account.is_liability ? '#e07070' : '#4ecba3' }}
      >
        {formatCurrency(account.current_balance)}
      </span>

      {/* Kebab */}
      <div className="relative" ref={menuRef} onClick={(e) => e.stopPropagation()}>
        <button
          className="opacity-0 group-hover:opacity-100 p-1 text-muted hover:text-text transition-all"
          onClick={() => setMenuOpen((v) => !v)}
        >
          <MoreHorizontal size={14} />
        </button>
        {menuOpen && (
          <div className="absolute right-0 top-6 bg-surface border border-border rounded shadow-lg z-20 w-44 py-1">
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
                  className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-[#e07070] hover:bg-white/5"
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

function InstitutionGroup({
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
            <span title="Reconnect required"><AlertTriangle size={11} className="text-[#f0c040] flex-shrink-0" /></span>
          )}
          {sublabel && <span className="text-xs text-muted/50 font-normal normal-case tracking-normal">{sublabel}</span>}
        </button>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <span className="font-mono text-xs" style={{ color: total >= 0 ? '#4ecba3' : '#e07070' }}>
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
                <div className="absolute right-0 top-5 bg-surface border border-border rounded shadow-lg z-30 w-44 py-1">
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
                          className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-[#f0c040] hover:bg-white/5"
                          onClick={() => { onReauthItem?.(); setMenuOpen(false); }}
                        >
                          <Unlink size={12} /> Reconnect
                        </button>
                      )}
                      <div className="border-t border-border my-1" />
                      <button
                        className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-[#e07070] hover:bg-white/5"
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
                        className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-[#e07070] hover:bg-white/5"
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

function AccountDetail({ account }: { account: Account }) {
  const [tab, setTab] = useState<'transactions' | 'holdings' | 'inv-transactions'>('transactions');
  const isInvestment = ['brokerage', 'ira_traditional', 'ira_roth'].includes(account.type);
  const isCrypto = account.type === 'crypto_wallet';
  const isCredit = account.type === 'credit';

  const { data: txs, isLoading: txLoading } = useQuery({
    queryKey: ['transactions', 'account', account.id],
    queryFn: () => transactionsApi.list({ accountId: [account.id], limit: 50, page: 1 }),
    enabled: tab === 'transactions',
  });

  const { data: holdings = [], isLoading: holdingsLoading } = useQuery({
    queryKey: ['holdings', account.id],
    queryFn: () => investmentsApi.holdingsByAccount(account.id),
    enabled: isInvestment,
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
  const utilizationColor = utilization == null ? '#6b6b7a'
    : utilization > 70 ? '#e07070'
    : utilization > 30 ? '#f0c040'
    : '#4ecba3';

  const typeLabel = {
    brokerage: 'Brokerage',
    ira_traditional: 'Traditional IRA',
    ira_roth: 'Roth IRA',
  }[account.type as string] ?? ACCOUNT_TYPE_LABELS[account.type] ?? account.type;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 py-4 border-b border-border">
        <div className="flex items-center gap-3 mb-2">
          <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: account.color || '#6b6b7a' }} />
          <h2 className="text-base font-semibold text-text">{account.account_name}</h2>
          <AccountTypeBadge type={account.type} />
          {(account.type === 'ira_traditional' || account.type === 'ira_roth') && (
            <span className="text-xs bg-[#5b8dee]/20 text-[#5b8dee] px-2 py-0.5 rounded">Tax-Advantaged</span>
          )}
        </div>

        {/* Cash/Checking/Savings: just balance */}
        {!isCredit && !isInvestment && !isCrypto && (
          <>
            <p className="font-mono text-2xl" style={{ color: account.is_liability ? '#e07070' : '#4ecba3' }}>
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
                <p className="font-mono text-sm text-[#e07070]">{formatCurrency(account.current_balance)}</p>
              </div>
              <div className="bg-background border border-border rounded p-3">
                <p className="text-xs text-muted mb-1">Credit Limit</p>
                <p className="font-mono text-sm text-text">
                  {account.credit_limit != null ? formatCurrency(account.credit_limit) : '-'}
                </p>
              </div>
              <div className="bg-background border border-border rounded p-3">
                <p className="text-xs text-muted mb-1">Available Credit</p>
                <p className="font-mono text-sm text-[#4ecba3]">
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
                <p className="font-mono text-sm text-[#4ecba3]">{formatCurrency(account.current_balance)}</p>
              </div>
              <div className="bg-background border border-border rounded p-3">
                <p className="text-xs text-muted mb-1">Cost Basis</p>
                <p className="font-mono text-sm text-text">
                  {hasCostBasis ? formatCurrency(costBasis) : '-'}
                </p>
              </div>
              <div className="bg-background border border-border rounded p-3">
                <p className="text-xs text-muted mb-1">Unrealized G/L</p>
                <p className="font-mono text-sm" style={{ color: unrealized == null ? '#6b6b7a' : unrealized >= 0 ? '#4ecba3' : '#e07070' }}>
                  {unrealized != null ? `${unrealized >= 0 ? '+' : ''}${formatCurrency(unrealized)}` : '-'}
                </p>
              </div>
              <div className="bg-background border border-border rounded p-3">
                <p className="text-xs text-muted mb-1">Total Return</p>
                <p className="font-mono text-sm" style={{ color: returnPct == null ? '#6b6b7a' : returnPct >= 0 ? '#4ecba3' : '#e07070' }}>
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
              <p className="font-mono text-lg text-[#4ecba3]">{formatCurrency(account.current_balance)}</p>
            </div>
          </div>
        )}
      </div>

      {/* Tabs (investment only) */}
      {isInvestment && (
        <div className="flex gap-1 px-6 py-2 border-b border-border">
          {(['holdings', 'transactions', 'inv-transactions'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-3 py-1 text-xs rounded transition-colors ${tab === t ? 'bg-[#4ecba3]/10 text-[#4ecba3]' : 'text-muted hover:text-text'}`}
            >
              {t === 'inv-transactions' ? 'Inv Transactions' : t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {/* Holdings */}
        {tab === 'holdings' && isInvestment && (
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
                  <tr key={h.id} className="border-b border-border hover:bg-white/2">
                    <td className="px-4 py-2.5 font-mono text-[#5b8dee] font-medium">{h.ticker ?? '-'}</td>
                    <td className="px-4 py-2.5 text-text truncate max-w-[160px]" title={h.security_name ?? ''}>{h.security_name}</td>
                    <td className="px-4 py-2.5 font-mono text-muted">{h.quantity.toFixed(4)}</td>
                    <td className="px-4 py-2.5 font-mono text-muted">{formatCurrency(h.institution_price)}</td>
                    <td className="px-4 py-2.5 font-mono text-text">{formatCurrency(h.institution_value)}</td>
                    <td className="px-4 py-2.5 font-mono text-muted">{h.cost_basis != null ? formatCurrency(h.cost_basis) : '-'}</td>
                    <td className="px-4 py-2.5 font-mono" style={{ color: unr != null ? (unr >= 0 ? '#4ecba3' : '#e07070') : '#6b6b7a' }}>
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
                <tr key={tx.id} className="border-b border-border hover:bg-white/2">
                  <td className="px-4 py-2.5 font-mono text-muted">{formatDate(tx.date)}</td>
                  <td className="px-4 py-2.5">
                    <span className={`px-1.5 py-0.5 rounded text-xs ${
                      tx.type === 'buy' ? 'bg-[#4ecba3]/10 text-[#4ecba3]' :
                      tx.type === 'sell' ? 'bg-[#e07070]/10 text-[#e07070]' :
                      tx.type === 'dividend' ? 'bg-[#5b8dee]/10 text-[#5b8dee]' :
                      'bg-border/50 text-muted'
                    }`}>
                      {tx.type}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 font-mono text-[#5b8dee]">{tx.ticker ?? tx.security_name ?? tx.name}</td>
                  <td className="px-4 py-2.5 font-mono text-muted">{tx.quantity?.toFixed(4) ?? '-'}</td>
                  <td className="px-4 py-2.5 font-mono text-muted">{tx.price != null ? formatCurrency(tx.price) : '-'}</td>
                  <td className="px-4 py-2.5"><AmountBadge amount={tx.amount} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {/* Regular Transactions */}
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
                <tr key={tx.id} className="border-b border-border hover:bg-white/2">
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
                  <td colSpan={4} className="px-4 py-8 text-center text-xs text-muted">No transactions found</td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ─── Edit Manual Account Modal ────────────────────────────────────────────────

function EditManualAccountModal({
  open,
  account,
  onClose,
}: {
  open: boolean;
  account: Account | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { addToast } = useAppStore();
  const [form, setForm] = useState({
    account_name: '',
    institution_name: '',
    type: 'checking',
    current_balance: '',
    color: CATEGORY_COLORS[0],
  });

  useEffect(() => {
    if (account) {
      setForm({
        account_name: account.account_name,
        institution_name: account.institution_name ?? '',
        type: account.type,
        current_balance: String(account.current_balance),
        color: account.color ?? CATEGORY_COLORS[0],
      });
    }
  }, [account]);

  const mutation = useMutation({
    mutationFn: () =>
      accountsApi.update(account!.id, {
        account_name: form.account_name,
        institution_name: form.institution_name,
        type: form.type as import('@shared/types').AccountType,
        current_balance: parseFloat(form.current_balance) || 0,
        color: form.color,
      }),
    onSuccess: () => {
      invalidateFinancialData(qc);
      addToast({ type: 'success', message: 'Account updated' });
      onClose();
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  if (!account) return null;

  return (
    <Modal open={open} onClose={onClose} title="Edit Account">
      <div className="space-y-4">
        <div>
          <label className="block text-xs text-muted mb-1">Account Name</label>
          <input
            className="w-full bg-background border border-border rounded px-3 py-2 text-sm text-text focus:outline-none focus:ring-1 focus:ring-[#4ecba3]/50"
            value={form.account_name}
            onChange={(e) => setForm({ ...form, account_name: e.target.value })}
          />
        </div>
        <div>
          <label className="block text-xs text-muted mb-1">Institution</label>
          <input
            className="w-full bg-background border border-border rounded px-3 py-2 text-sm text-text focus:outline-none focus:ring-1 focus:ring-[#4ecba3]/50"
            value={form.institution_name}
            onChange={(e) => setForm({ ...form, institution_name: e.target.value })}
            placeholder="Chase"
          />
        </div>
        <div>
          <label className="block text-xs text-muted mb-1">Account Type</label>
          <select
            className="w-full bg-background border border-border rounded px-3 py-2 text-sm text-text focus:outline-none focus:ring-1 focus:ring-[#4ecba3]/50"
            value={form.type}
            onChange={(e) => setForm({ ...form, type: e.target.value })}
          >
            {Object.entries(ACCOUNT_TYPE_LABELS).map(([val, label]) => (
              <option key={val} value={val}>{label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-muted mb-1">Current Balance</label>
          <input
            type="number"
            className="w-full bg-background border border-border rounded px-3 py-2 text-sm text-text font-mono focus:outline-none focus:ring-1 focus:ring-[#4ecba3]/50"
            value={form.current_balance}
            onChange={(e) => setForm({ ...form, current_balance: e.target.value })}
          />
        </div>
        <div>
          <label className="block text-xs text-muted mb-1">Color</label>
          <div className="flex flex-wrap gap-2">
            {CATEGORY_COLORS.map((c) => (
              <button
                key={c}
                onClick={() => setForm({ ...form, color: c })}
                className="w-5 h-5 rounded-full transition-transform"
                style={{
                  backgroundColor: c,
                  outline: form.color === c ? '2px solid white' : 'none',
                  outlineOffset: '2px',
                  transform: form.color === c ? 'scale(1.15)' : 'scale(1)',
                }}
              />
            ))}
          </div>
        </div>
        <div className="flex gap-3 pt-2">
          <button
            className="flex-1 py-2 text-sm bg-[#4ecba3] text-[#0f0f11] font-medium rounded hover:opacity-90 disabled:opacity-40"
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending}
          >
            {mutation.isPending ? 'Saving...' : 'Save Changes'}
          </button>
          <button
            className="px-4 py-2 text-sm border border-border rounded text-muted hover:text-text"
            onClick={onClose}
          >
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ─── Add Manual Account Modal ─────────────────────────────────────────────────

function AddManualAccountModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const { addToast } = useAppStore();
  const [form, setForm] = useState({
    account_name: '',
    institution_name: '',
    type: 'checking',
    current_balance: '',
    currency: 'USD',
    color: CATEGORY_COLORS[0],
  });

  const mutation = useMutation({
    mutationFn: () =>
      accountsApi.createManual({
        ...form,
        current_balance: parseFloat(form.current_balance) || 0,
      }),
    onSuccess: () => {
      invalidateFinancialData(qc);
      addToast({ type: 'success', message: 'Account created' });
      onClose();
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  return (
    <Modal open={open} onClose={onClose} title="Add Manual Account">
      <div className="space-y-4">
        <div>
          <label className="block text-xs text-muted mb-1">Account Name</label>
          <input
            className="w-full bg-background border border-border rounded px-3 py-2 text-sm text-text focus:outline-none focus:ring-1 focus:ring-[#4ecba3]/50"
            value={form.account_name}
            onChange={(e) => setForm({ ...form, account_name: e.target.value })}
            placeholder="My Savings"
          />
        </div>
        <div>
          <label className="block text-xs text-muted mb-1">Institution (optional)</label>
          <input
            className="w-full bg-background border border-border rounded px-3 py-2 text-sm text-text focus:outline-none focus:ring-1 focus:ring-[#4ecba3]/50"
            value={form.institution_name}
            onChange={(e) => setForm({ ...form, institution_name: e.target.value })}
            placeholder="Chase"
          />
        </div>
        <div>
          <label className="block text-xs text-muted mb-1">Account Type</label>
          <select
            className="w-full bg-background border border-border rounded px-3 py-2 text-sm text-text focus:outline-none focus:ring-1 focus:ring-[#4ecba3]/50"
            value={form.type}
            onChange={(e) => setForm({ ...form, type: e.target.value })}
          >
            {Object.entries(ACCOUNT_TYPE_LABELS).map(([val, label]) => (
              <option key={val} value={val}>{label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-muted mb-1">Current Balance</label>
          <input
            type="number"
            className="w-full bg-background border border-border rounded px-3 py-2 text-sm text-text font-mono focus:outline-none focus:ring-1 focus:ring-[#4ecba3]/50"
            value={form.current_balance}
            onChange={(e) => setForm({ ...form, current_balance: e.target.value })}
            placeholder="0.00"
          />
        </div>
        <div className="flex gap-3 pt-2">
          <button
            className="flex-1 py-2 text-sm bg-[#4ecba3] text-[#0f0f11] font-medium rounded hover:opacity-90 disabled:opacity-40"
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending}
          >
            {mutation.isPending ? 'Creating...' : 'Create Account'}
          </button>
          <button
            className="px-4 py-2 text-sm border border-border rounded text-muted hover:text-text"
            onClick={onClose}
          >
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ─── Main Accounts View ───────────────────────────────────────────────────────

export function Accounts() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { addToast } = useAppStore();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [showManualModal, setShowManualModal] = useState(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const addMenuRef = useRef<HTMLDivElement>(null);
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
  const [confirmRemoveItem, setConfirmRemoveItem] = useState<{ id: string; name: string } | null>(null);
  const [confirmDisconnectCoinbase, setConfirmDisconnectCoinbase] = useState(false);
  const [confirmDeleteAccount, setConfirmDeleteAccount] = useState<Account | null>(null);

  const { data: accounts = [], isLoading } = useQuery({
    queryKey: ['accounts'],
    queryFn: accountsApi.list,
  });

  const { data: plaidItems = [] } = useQuery({
    queryKey: ['plaid-items'],
    queryFn: plaidApi.listItems,
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

  const removeItemMutation = useMutation({
    mutationFn: (itemId: string) => plaidApi.deleteItem(itemId),
    onSuccess: () => {
      invalidateFinancialData(qc);
      setConfirmRemoveItem(null);
      addToast({ type: 'success', message: 'Institution removed' });
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const syncItemMutation = useMutation({
    mutationFn: (itemId: string) => plaidApi.syncItem(itemId),
    onSuccess: (result) => {
      invalidateFinancialData(qc);
      if (!result.success) {
        addToast({ type: 'error', message: 'Bank needs reconnecting' });
        return;
      }
      addToast({ type: 'success', message: 'Bank sync complete' });
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

  const handleReauth = async (itemId: string) => {
    try {
      const plaid = await loadPlaidLink();
      const { link_token } = await plaidApi.createUpdateToken(itemId);
      sessionStorage.setItem('plaid_link_token', link_token);
      const handler = plaid.create({
        token: link_token,
        onSuccess: async () => {
          sessionStorage.removeItem('plaid_link_token');
          const result = await plaidApi.syncItem(itemId);
          invalidateFinancialData(qc);
          if (!result.success) {
            addToast({ type: 'error', message: 'Bank still needs reconnecting' });
            return;
          }
          addToast({ type: 'success', message: 'Bank reconnected' });
        },
        onExit: () => sessionStorage.removeItem('plaid_link_token'),
      });
      handler.open();
    } catch (err: unknown) {
      addToast({ type: 'error', message: errorMessage(err, 'Failed to reconnect') });
    }
  };

  const connectPlaid = async () => {
    setAddMenuOpen(false);
    try {
      const plaid = await loadPlaidLink();
      const { link_token } = await plaidApi.createLinkToken();
      sessionStorage.setItem('plaid_link_token', link_token);
      const handler = plaid.create({
        token: link_token,
        onSuccess: async (publicToken: string, metadata: unknown) => {
          sessionStorage.removeItem('plaid_link_token');
          const result = await plaidApi.exchangeToken(publicToken, metadata);
          invalidateFinancialData(qc);
          if (result.initialSyncStatus === 'synced') {
            addToast({ type: 'success', message: 'Bank connected successfully' });
          } else {
            addToast({
              type: 'error',
              message: result.initialSyncError
                ? `Bank connected, but initial sync failed: ${result.initialSyncError}`
                : 'Bank connected, but initial sync did not finish',
            });
          }
        },
        onExit: () => sessionStorage.removeItem('plaid_link_token'),
      });
      handler.open();
    } catch (err: unknown) {
      addToast({ type: 'error', message: errorMessage(err, 'Failed to open Plaid') });
    }
  };

  const selectedAccount = accounts.find((a) => a.id === selectedId) ?? null;

  // Build institution groups
  const plaidGroups = plaidItems.map((item) => ({
    item,
    accounts: accounts.filter((a) => a.connection_id === item.id),
    sublabel: item.last_synced_at ? formatRelativeTime(item.last_synced_at) : undefined,
  }));

  const coinbaseAccounts = accounts.filter((a) => a.connection_type === 'coinbase');
  const manualAccounts = accounts.filter((a) => a.is_manual);

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
              className="w-5 h-5 flex items-center justify-center rounded text-muted hover:text-text hover:bg-white/10 transition-colors"
              title="Hide panel"
            >
              <PanelLeftClose size={13} />
            </button>
          </div>
          <div className="relative" ref={addMenuRef}>
            <button
              className="flex items-center gap-1 text-xs text-[#4ecba3] hover:opacity-80"
              onClick={() => setAddMenuOpen((v) => !v)}
            >
              <Plus size={14} /> Add
            </button>
            {addMenuOpen && (
              <div className="absolute right-0 top-6 bg-surface border border-border rounded shadow-lg z-20 w-52 py-1">
                <button
                  className="flex items-center gap-2 w-full px-3 py-2 text-xs text-text hover:bg-white/5"
                  onClick={connectPlaid}
                >
                  <Link size={12} className="text-[#4ecba3]" />
                  Connect Bank or Card
                </button>
                <button
                  className="flex items-center gap-2 w-full px-3 py-2 text-xs text-text hover:bg-white/5"
                  onClick={() => { setAddMenuOpen(false); navigate('/settings'); }}
                >
                  <Link size={12} className="text-[#5b8dee]" />
                  Connect Coinbase
                </button>
                <button
                  className="flex items-center gap-2 w-full px-3 py-2 text-xs text-text hover:bg-white/5"
                  onClick={() => { setAddMenuOpen(false); setShowManualModal(true); }}
                >
                  <Plus size={12} className="text-muted" />
                  Add Manual Account
                </button>
              </div>
            )}
          </div>
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
              {/* Plaid institution groups */}
              {plaidGroups.map(({ item, accounts: grpAccounts, sublabel }) => (
                <InstitutionGroup
                  key={item.id}
                  label={item.institution_name}
                  sublabel={sublabel}
                  accounts={grpAccounts}
                  showHidden={showHidden}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                  onHide={(id) => hideMutation.mutate(id)}
                  holdingsByAccount={holdingsByAccount}
                  groupType="plaid"
                  plaidItem={item}
                  onSyncItem={() => syncItemMutation.mutate(item.id)}
                  onRemoveItem={() => setConfirmRemoveItem({ id: item.id, name: item.institution_name })}
                  onReauthItem={() => handleReauth(item.id)}
                />
              ))}

              {/* Coinbase group */}
              {coinbaseAccounts.length > 0 && (
                <InstitutionGroup
                  label="Coinbase"
                  accounts={coinbaseAccounts}
                  showHidden={showHidden}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                  onHide={(id) => hideMutation.mutate(id)}
                  holdingsByAccount={holdingsByAccount}
                  groupType="coinbase"
                  onSyncCoinbase={() => syncCoinbaseMutation.mutate()}
                  onDisconnectCoinbase={() => setConfirmDisconnectCoinbase(true)}
                />
              )}

              {/* Manual accounts */}
              {manualAccounts.length > 0 && (
                <InstitutionGroup
                  label="Manual"
                  accounts={manualAccounts}
                  showHidden={showHidden}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                  onHide={(id) => hideMutation.mutate(id)}
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
                <div className="py-12 text-center text-muted text-sm px-4">
                  <CreditCard size={32} className="mx-auto mb-3 opacity-20" />
                  <p className="mb-1">No accounts yet</p>
                  <p className="text-xs">Click "Add" to connect your accounts</p>
                </div>
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
              className="absolute top-3 left-3 z-20 w-7 h-7 flex items-center justify-center rounded bg-surface border border-border text-muted hover:text-text hover:border-[#4ecba3]/50 transition-colors"
              title="Show accounts panel"
            >
              <PanelLeftOpen size={14} />
            </button>
          )}
          {selectedAccount ? (
            <AccountDetail account={selectedAccount} />
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

      <EditManualAccountModal
        open={editAccount != null}
        account={editAccount}
        onClose={() => setEditAccount(null)}
      />

      <ConfirmRemoveModal
        open={confirmRemoveItem != null}
        onClose={() => setConfirmRemoveItem(null)}
        title={`Remove ${confirmRemoveItem?.name ?? 'Institution'}?`}
        description="This will remove all connected accounts for this institution and delete their access token. Existing transactions will be hidden but not deleted."
        confirmLabel="Remove Institution"
        onConfirm={() => confirmRemoveItem && removeItemMutation.mutate(confirmRemoveItem.id)}
        isPending={removeItemMutation.isPending}
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
