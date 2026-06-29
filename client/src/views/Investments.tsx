import React, { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { ChevronUp, ChevronDown } from 'lucide-react';
import { format, subMonths } from 'date-fns';
import { investmentsApi, reportsApi, accountsApi } from '../lib/api';
import { formatCurrency, formatDate } from '../lib/formatters';
import { AmountBadge } from '../components/AmountBadge';
import { SkeletonList, SkeletonCard } from '../components/SkeletonLoader';
import { EmptyState } from '../components/EmptyState';
import type { Holding, InvestmentTransaction, Account } from '@shared/types';

// ─── Types ────────────────────────────────────────────────────────────────────

type SortCol = 'ticker' | 'value' | 'pnl' | 'pnl_pct';
type SortDir = 'asc' | 'desc';
type ActiveTab = 'holdings' | 'transactions';

const INV_ACCOUNT_TYPES = ['brokerage', 'ira_traditional', 'ira_roth', 'crypto_wallet'];

const TX_TYPE_COLORS: Record<string, string> = {
  buy: 'bg-[#4ecba3]/10 text-[#4ecba3]',
  sell: 'bg-[#e07070]/10 text-[#e07070]',
  dividend: 'bg-[#5b8dee]/10 text-[#5b8dee]',
  transfer: 'bg-[#f0c040]/10 text-[#f0c040]',
  fee: 'bg-border text-muted',
  other: 'bg-border text-muted',
};

const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  brokerage: 'Brokerage',
  ira_traditional: 'Traditional IRA',
  ira_roth: 'Roth IRA',
  crypto_wallet: 'Crypto',
};

function formatPct(n: number | null): string {
  if (n == null) return '-';
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
}

function PnlCell({ value, pct }: { value: number | null; pct: number | null }) {
  if (value == null) return <span className="text-muted">-</span>;
  const color = value >= 0 ? 'text-[#4ecba3]' : 'text-[#e07070]';
  return (
    <span className={`font-mono ${color}`}>
      {value >= 0 ? '+' : ''}{formatCurrency(value)}
      {pct != null && <span className="text-xs ml-1 opacity-70">{formatPct(pct)}</span>}
    </span>
  );
}

// ─── Sortable header ──────────────────────────────────────────────────────────

function SortableHeader({
  label,
  col,
  sortBy,
  sortDir,
  onSort,
  align = 'left',
}: {
  label: string;
  col: SortCol;
  sortBy: SortCol;
  sortDir: SortDir;
  onSort: (col: SortCol) => void;
  align?: 'left' | 'right';
}) {
  const active = sortBy === col;
  return (
    <th
      className={`px-3 py-2.5 text-xs text-muted font-medium uppercase tracking-wider cursor-pointer select-none hover:text-text ${align === 'right' ? 'text-right' : 'text-left'}`}
      onClick={() => onSort(col)}
    >
      <span className={`inline-flex items-center gap-1 ${align === 'right' ? 'flex-row-reverse' : ''}`}>
        {label}
        {active ? (
          sortDir === 'asc' ? <ChevronUp size={11} /> : <ChevronDown size={11} />
        ) : (
          <ChevronDown size={11} className="opacity-0" />
        )}
      </span>
    </th>
  );
}

// ─── Custom tooltip ───────────────────────────────────────────────────────────

function ChartTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ value: number }>; label?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-surface border border-border rounded px-3 py-2 text-xs">
      <p className="text-muted">{label}</p>
      <p className="font-mono text-[#5b8dee] font-medium">{formatCurrency(payload[0].value)}</p>
    </div>
  );
}

// ─── Main view ────────────────────────────────────────────────────────────────

export function Investments() {
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ActiveTab>('holdings');
  const [sortBy, setSortBy] = useState<SortCol>('value');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [txTypeFilter, setTxTypeFilter] = useState<string>('');

  const startDate = format(subMonths(new Date(), 12), 'yyyy-MM-dd');
  const endDate = format(new Date(), 'yyyy-MM-dd');

  const { data: allHoldings = [], isLoading: holdingsLoading } = useQuery({
    queryKey: ['holdings'],
    queryFn: investmentsApi.holdings,
  });

  const { data: txs = [], isLoading: txsLoading } = useQuery({
    queryKey: ['investment-transactions', selectedAccountId, startDate, endDate],
    queryFn: () =>
      investmentsApi.transactions({
        accountId: selectedAccountId ?? undefined,
        startDate,
        endDate,
      }),
  });

  const { data: invReport } = useQuery({
    queryKey: ['reports-investments'],
    queryFn: () => reportsApi.investments({ startDate, endDate }),
  });

  const { data: accounts = [] } = useQuery({
    queryKey: ['accounts'],
    queryFn: accountsApi.list,
  });

  const invAccounts = useMemo(
    () => accounts.filter((a) => INV_ACCOUNT_TYPES.includes(a.type)),
    [accounts]
  );

  // Filter holdings by selected account
  const filteredHoldings = useMemo(
    () =>
      selectedAccountId
        ? allHoldings.filter((h) => h.account_id === selectedAccountId)
        : allHoldings,
    [allHoldings, selectedAccountId]
  );

  // Group holdings by account_id for account summary
  const holdingsByAccount = useMemo(() => {
    const map = new Map<string, Holding[]>();
    for (const h of allHoldings) {
      if (!map.has(h.account_id)) map.set(h.account_id, []);
      map.get(h.account_id)!.push(h);
    }
    return map;
  }, [allHoldings]);

  // Summary stats
  const totalValue = filteredHoldings.reduce((s, h) => s + h.institution_value, 0);
  const totalCostBasis = filteredHoldings.reduce((s, h) => s + (h.cost_basis ?? 0), 0);
  const hasCostBasis = filteredHoldings.some((h) => h.cost_basis != null);
  const unrealized = hasCostBasis ? totalValue - totalCostBasis : null;
  const totalReturn = hasCostBasis && totalCostBasis > 0 ? ((totalValue - totalCostBasis) / totalCostBasis) * 100 : null;

  // Sort holdings
  const sortedHoldings = useMemo(() => {
    return [...filteredHoldings].sort((a, b) => {
      let cmp = 0;
      if (sortBy === 'value') cmp = a.institution_value - b.institution_value;
      else if (sortBy === 'ticker') cmp = (a.ticker ?? '').localeCompare(b.ticker ?? '');
      else if (sortBy === 'pnl') {
        const aPnl = a.cost_basis != null ? a.institution_value - a.cost_basis : -Infinity;
        const bPnl = b.cost_basis != null ? b.institution_value - b.cost_basis : -Infinity;
        cmp = aPnl - bPnl;
      } else if (sortBy === 'pnl_pct') {
        const aPct = a.cost_basis != null && a.cost_basis > 0 ? (a.institution_value - a.cost_basis) / a.cost_basis : -Infinity;
        const bPct = b.cost_basis != null && b.cost_basis > 0 ? (b.institution_value - b.cost_basis) / b.cost_basis : -Infinity;
        cmp = aPct - bPct;
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [filteredHoldings, sortBy, sortDir]);

  const handleSort = (col: SortCol) => {
    if (sortBy === col) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortBy(col); setSortDir('desc'); }
  };

  // Filter transactions
  const filteredTxs = useMemo(() => {
    let result = txs;
    if (selectedAccountId) result = result.filter((t) => t.account_id === selectedAccountId);
    if (txTypeFilter) result = result.filter((t) => t.type === txTypeFilter);
    return result;
  }, [txs, selectedAccountId, txTypeFilter]);

  // Chart data
  const chartData = useMemo(
    () =>
      (invReport?.history ?? []).map((p) => ({
        date: p.date.slice(0, 7),
        value: p.value,
      })),
    [invReport]
  );

  // Allocation breakdown
  const allocation = useMemo(() => {
    const total = (invReport?.allocation ?? []).reduce((s, a) => s + a.total_value, 0);
    return (invReport?.allocation ?? []).map((a) => ({
      ...a,
      pct: total > 0 ? (a.total_value / total) * 100 : 0,
    }));
  }, [invReport]);

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-xl font-semibold text-text">Investments</h1>

      {/* Summary cards */}
      <div className="grid grid-cols-4 gap-4">
        {holdingsLoading ? (
          <><SkeletonCard /><SkeletonCard /><SkeletonCard /><SkeletonCard /></>
        ) : (
          <>
            <div className="bg-surface border border-border rounded p-5">
              <p className="text-xs text-muted mb-1">Portfolio Value</p>
              <p className="font-mono text-2xl font-medium text-text">{formatCurrency(totalValue)}</p>
            </div>
            <div className="bg-surface border border-border rounded p-5">
              <p className="text-xs text-muted mb-1">Total Cost Basis</p>
              <p className="font-mono text-2xl font-medium text-text">
                {hasCostBasis ? formatCurrency(totalCostBasis) : '-'}
              </p>
            </div>
            <div className="bg-surface border border-border rounded p-5">
              <p className="text-xs text-muted mb-1">Unrealized P&L</p>
              <p
                className="font-mono text-2xl font-medium"
                style={{ color: unrealized == null ? undefined : unrealized >= 0 ? '#4ecba3' : '#e07070' }}
                title={unrealized == null ? 'Cost basis not available' : undefined}
              >
                {unrealized == null ? '-' : `${unrealized >= 0 ? '+' : ''}${formatCurrency(unrealized)}`}
              </p>
            </div>
            <div className="bg-surface border border-border rounded p-5">
              <p className="text-xs text-muted mb-1">Total Return</p>
              <p
                className="font-mono text-2xl font-medium"
                style={{ color: totalReturn == null ? undefined : totalReturn >= 0 ? '#4ecba3' : '#e07070' }}
                title={totalReturn == null ? 'Cost basis not available' : undefined}
              >
                {totalReturn == null ? '-' : formatPct(totalReturn)}
              </p>
            </div>
          </>
        )}
      </div>

      {/* Account selector + Chart */}
      <div className="grid grid-cols-5 gap-4">
        {/* Account selector */}
        <div className="col-span-2 bg-surface border border-border rounded p-4 flex flex-col gap-2">
          <p className="text-xs text-muted font-medium uppercase tracking-wider mb-1">Accounts</p>
          {/* All accounts pill */}
          <button
            onClick={() => setSelectedAccountId(null)}
            className={`flex items-center justify-between px-3 py-2 text-xs rounded-full border transition-all ${
              selectedAccountId === null
                ? 'bg-[#4ecba3]/10 text-[#4ecba3] border-[#4ecba3]/40'
                : 'text-muted border-border hover:text-text'
            }`}
          >
            <span>All Accounts</span>
            <span className="font-mono">{formatCurrency(allHoldings.reduce((s, h) => s + h.institution_value, 0))}</span>
          </button>
          {invAccounts.map((acct) => {
            const acctHoldings = holdingsByAccount.get(acct.id) ?? [];
            const acctValue = acctHoldings.reduce((s, h) => s + h.institution_value, 0);
            const typeLabel = ACCOUNT_TYPE_LABELS[acct.type] ?? acct.type;
            return (
              <button
                key={acct.id}
                onClick={() => setSelectedAccountId(acct.id === selectedAccountId ? null : acct.id)}
                className={`flex items-center justify-between px-3 py-2 text-xs rounded-full border transition-all ${
                  selectedAccountId === acct.id
                    ? 'bg-[#4ecba3]/10 text-[#4ecba3] border-[#4ecba3]/40'
                    : 'text-muted border-border hover:text-text'
                }`}
              >
                <span className="truncate">
                  {acct.account_name}
                  {(acct.type === 'ira_traditional' || acct.type === 'ira_roth') && (
                    <span className="ml-1 text-muted/60">{typeLabel}</span>
                  )}
                </span>
                <span className="font-mono flex-shrink-0 ml-2">{formatCurrency(acctValue)}</span>
              </button>
            );
          })}
        </div>

        {/* Portfolio chart */}
        <div className="col-span-3 bg-surface border border-border rounded p-4">
          <p className="text-xs text-muted font-medium uppercase tracking-wider mb-3">Portfolio Value History</p>
          {chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart data={chartData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="invGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#5b8dee" stopOpacity={0.25} />
                    <stop offset="95%" stopColor="#5b8dee" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#6b6b7a' }} tickLine={false} axisLine={false} />
                <YAxis
                  tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`}
                  tick={{ fontSize: 10, fill: '#6b6b7a' }}
                  tickLine={false}
                  axisLine={false}
                  width={48}
                />
                <Tooltip content={<ChartTooltip />} />
                <Area type="monotone" dataKey="value" stroke="#5b8dee" strokeWidth={2} fill="url(#invGrad)" />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-48 flex items-center justify-center text-muted text-sm">
              No portfolio history yet
            </div>
          )}
        </div>
      </div>

      {/* Allocation breakdown */}
      {allocation.length > 0 && (
        <div className="flex flex-wrap gap-3">
          {allocation.map((a) => (
            <div key={a.security_type} className="flex flex-col gap-1.5 p-3 bg-surface border border-border rounded min-w-[130px]">
              <p className="text-xs text-text font-medium capitalize">{a.security_type}</p>
              <div className="h-1 rounded bg-[#5b8dee]" style={{ width: `${Math.max(a.pct, 4)}%`, maxWidth: '100%' }} />
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="font-mono text-muted">{a.pct.toFixed(0)}%</span>
                <span className="font-mono text-text">{formatCurrency(a.total_value)}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Account summary table */}
      {invAccounts.length > 0 && (
        <div className="bg-surface border border-border rounded overflow-hidden">
          <table className="w-full text-xs">
            <thead className="border-b border-border">
              <tr>
                {['Account', 'Institution', 'Type', 'Current Value', 'Cost Basis', 'Gain / Loss', '% Return'].map((h) => (
                  <th key={h} className={`px-3 py-2.5 text-xs text-muted font-medium uppercase tracking-wider ${h === 'Account' || h === 'Institution' || h === 'Type' ? 'text-left' : 'text-right'}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {invAccounts.map((acct) => {
                const acctHoldings = holdingsByAccount.get(acct.id) ?? [];
                const value = acctHoldings.reduce((s, h) => s + h.institution_value, 0);
                const costBasis = acctHoldings.reduce((s, h) => s + (h.cost_basis ?? 0), 0);
                const hasCB = acctHoldings.some((h) => h.cost_basis != null);
                const gl = hasCB ? value - costBasis : null;
                const ret = hasCB && costBasis > 0 ? ((value - costBasis) / costBasis) * 100 : null;
                return (
                  <tr
                    key={acct.id}
                    className={`border-b border-border hover:bg-white/2 cursor-pointer ${selectedAccountId === acct.id ? 'bg-[#4ecba3]/5' : ''}`}
                    onClick={() => setSelectedAccountId(acct.id === selectedAccountId ? null : acct.id)}
                  >
                    <td className="px-3 py-2.5 text-text font-medium">{acct.account_name}</td>
                    <td className="px-3 py-2.5 text-muted">{acct.institution_name ?? '-'}</td>
                    <td className="px-3 py-2.5 text-muted">{ACCOUNT_TYPE_LABELS[acct.type] ?? acct.type}</td>
                    <td className="px-3 py-2.5 text-right font-mono text-text">{formatCurrency(value)}</td>
                    <td className="px-3 py-2.5 text-right font-mono text-muted">{hasCB ? formatCurrency(costBasis) : '-'}</td>
                    <td className="px-3 py-2.5 text-right">
                      <PnlCell value={gl} pct={null} />
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono" style={{ color: ret == null ? undefined : ret >= 0 ? '#4ecba3' : '#e07070' }}>
                      {ret == null ? '-' : formatPct(ret)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            {invAccounts.length > 1 && (() => {
              const totalV = invAccounts.reduce((s, a) => {
                const h = holdingsByAccount.get(a.id) ?? [];
                return s + h.reduce((ss, hh) => ss + hh.institution_value, 0);
              }, 0);
              const totalCB = invAccounts.reduce((s, a) => {
                const h = holdingsByAccount.get(a.id) ?? [];
                return s + h.reduce((ss, hh) => ss + (hh.cost_basis ?? 0), 0);
              }, 0);
              const totalHasCB = allHoldings.some((h) => h.cost_basis != null);
              const totalGL = totalHasCB ? totalV - totalCB : null;
              const totalRet = totalHasCB && totalCB > 0 ? ((totalV - totalCB) / totalCB) * 100 : null;
              return (
                <tfoot>
                  <tr className="border-t-2 border-border">
                    <td className="px-3 py-2.5 text-text font-bold" colSpan={3}>TOTAL</td>
                    <td className="px-3 py-2.5 text-right font-mono font-bold text-text">{formatCurrency(totalV)}</td>
                    <td className="px-3 py-2.5 text-right font-mono text-muted">{totalHasCB ? formatCurrency(totalCB) : '-'}</td>
                    <td className="px-3 py-2.5 text-right font-bold">
                      <PnlCell value={totalGL} pct={null} />
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono font-bold" style={{ color: totalRet == null ? undefined : totalRet >= 0 ? '#4ecba3' : '#e07070' }}>
                      {totalRet == null ? '-' : formatPct(totalRet)}
                    </td>
                  </tr>
                </tfoot>
              );
            })()}
          </table>
        </div>
      )}

      {/* Holdings / Transactions tabs */}
      <div>
        <div className="flex gap-1 mb-4">
          <button
            onClick={() => setActiveTab('holdings')}
            className={`px-4 py-2 text-sm rounded transition-colors ${
              activeTab === 'holdings' ? 'bg-[#1e1e22] text-text' : 'text-muted hover:text-text'
            }`}
          >
            Holdings {filteredHoldings.length > 0 && `(${filteredHoldings.length})`}
          </button>
          <button
            onClick={() => setActiveTab('transactions')}
            className={`px-4 py-2 text-sm rounded transition-colors ${
              activeTab === 'transactions' ? 'bg-[#1e1e22] text-text' : 'text-muted hover:text-text'
            }`}
          >
            Transactions
          </button>
        </div>

        {activeTab === 'holdings' && (
          <div className="bg-surface border border-border rounded overflow-hidden">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-surface border-b border-border z-10">
                <tr>
                  <SortableHeader label="Ticker" col="ticker" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                  <th className="text-left px-3 py-2.5 text-xs text-muted font-medium uppercase tracking-wider">Name</th>
                  {!selectedAccountId && (
                    <th className="text-left px-3 py-2.5 text-xs text-muted font-medium uppercase tracking-wider">Account</th>
                  )}
                  <th className="text-right px-3 py-2.5 text-xs text-muted font-medium uppercase tracking-wider">Qty</th>
                  <th className="text-right px-3 py-2.5 text-xs text-muted font-medium uppercase tracking-wider">Price</th>
                  <SortableHeader label="Value" col="value" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} align="right" />
                  <th className="text-right px-3 py-2.5 text-xs text-muted font-medium uppercase tracking-wider">Cost Basis</th>
                  <SortableHeader label="Unrealized" col="pnl" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} align="right" />
                  <SortableHeader label="Return%" col="pnl_pct" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} align="right" />
                </tr>
              </thead>
              <tbody>
                {holdingsLoading ? (
                  <SkeletonList rows={8} cols={selectedAccountId ? 8 : 9} />
                ) : sortedHoldings.length === 0 ? null : (
                  sortedHoldings.map((h) => {
                    const pnl = h.cost_basis != null ? h.institution_value - h.cost_basis : null;
                    const pct = h.cost_basis != null && h.cost_basis > 0 ? ((h.institution_value - h.cost_basis) / h.cost_basis) * 100 : null;
                    const acct = accounts.find((a) => a.id === h.account_id);
                    const isCash = h.security_type === 'cash';
                    return (
                      <tr key={h.id} className={`border-b border-border hover:bg-white/2 ${isCash ? 'opacity-60' : ''}`}>
                        <td className="px-3 py-2.5 font-mono font-bold text-text">{h.ticker ?? '-'}</td>
                        <td className="px-3 py-2.5 text-muted max-w-[140px]">
                          <span className="truncate block" title={h.security_name ?? undefined}>{h.security_name}</span>
                        </td>
                        {!selectedAccountId && (
                          <td className="px-3 py-2.5 text-muted max-w-[120px]">
                            <span className="truncate block" title={acct?.account_name ?? undefined}>{acct?.account_name ?? '-'}</span>
                          </td>
                        )}
                        <td className="px-3 py-2.5 text-right font-mono text-xs">{h.quantity.toFixed(4)}</td>
                        <td className="px-3 py-2.5 text-right font-mono">{formatCurrency(h.institution_price)}</td>
                        <td className="px-3 py-2.5 text-right font-mono font-medium text-text">{formatCurrency(h.institution_value)}</td>
                        <td className="px-3 py-2.5 text-right font-mono text-muted">{h.cost_basis != null ? formatCurrency(h.cost_basis) : '-'}</td>
                        <td className="px-3 py-2.5 text-right">
                          {isCash ? <span className="text-muted">-</span> : <PnlCell value={pnl} pct={null} />}
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono" style={{ color: pct == null ? undefined : pct >= 0 ? '#4ecba3' : '#e07070' }}>
                          {isCash ? '-' : pct == null ? '-' : formatPct(pct)}
                        </td>
                      </tr>
                    );
                  })
                )}
                {/* Footer total row */}
                {!holdingsLoading && sortedHoldings.length > 0 && (() => {
                  const totalV = sortedHoldings.reduce((s, h) => s + h.institution_value, 0);
                  const totalPnl = sortedHoldings.reduce((s, h) => h.cost_basis != null ? s + h.institution_value - h.cost_basis : s, 0);
                  const hasCB2 = sortedHoldings.some((h) => h.cost_basis != null);
                  return (
                    <tr className="border-t-2 border-border">
                      <td className="px-3 py-2.5 font-bold text-text" colSpan={selectedAccountId ? 4 : 5}>TOTAL</td>
                      <td className="px-3 py-2.5 text-right font-mono font-bold text-text">{formatCurrency(totalV)}</td>
                      <td />
                      <td className="px-3 py-2.5 text-right font-bold">
                        <PnlCell value={hasCB2 ? totalPnl : null} pct={null} />
                      </td>
                      <td />
                    </tr>
                  );
                })()}
              </tbody>
            </table>
            {!holdingsLoading && sortedHoldings.length === 0 && (
              <div className="py-12 text-center text-sm text-muted">No holdings found</div>
            )}
          </div>
        )}

        {activeTab === 'transactions' && (
          <div>
            {/* Transaction filters */}
            <div className="flex items-center gap-2 mb-3">
              <select
                className="bg-background border border-border rounded px-2 py-1 text-xs text-text focus:outline-none focus:ring-1 focus:ring-[#4ecba3]/50"
                value={txTypeFilter}
                onChange={(e) => setTxTypeFilter(e.target.value)}
              >
                <option value="">All Types</option>
                {['buy', 'sell', 'dividend', 'transfer', 'fee', 'other'].map((t) => (
                  <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>
                ))}
              </select>
              {txTypeFilter && (
                <button
                  className="text-xs text-muted hover:text-text"
                  onClick={() => setTxTypeFilter('')}
                >
                  × Clear
                </button>
              )}
            </div>

            <div className="bg-surface border border-border rounded overflow-hidden">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-surface border-b border-border z-10">
                  <tr>
                    {['Date', 'Type', 'Security', !selectedAccountId ? 'Account' : null, 'Qty', 'Price', 'Fees', 'Amount']
                      .filter(Boolean)
                      .map((h) => (
                        <th key={h as string} className={`px-3 py-2.5 text-xs text-muted font-medium uppercase tracking-wider ${h === 'Date' || h === 'Type' || h === 'Security' || h === 'Account' ? 'text-left' : 'text-right'}`}>
                          {h}
                        </th>
                      ))}
                  </tr>
                </thead>
                <tbody>
                  {txsLoading ? (
                    <SkeletonList rows={8} cols={selectedAccountId ? 7 : 8} />
                  ) : (
                    filteredTxs.map((tx) => {
                      const acct = accounts.find((a) => a.id === tx.account_id);
                      return (
                        <tr key={tx.id} className="border-b border-border hover:bg-white/2">
                          <td className="px-3 py-2.5 font-mono text-muted whitespace-nowrap">{formatDate(tx.date)}</td>
                          <td className="px-3 py-2.5">
                            <span className={`px-1.5 py-0.5 rounded text-xs ${TX_TYPE_COLORS[tx.type] ?? TX_TYPE_COLORS.other}`}>
                              {tx.type}
                            </span>
                          </td>
                          <td className="px-3 py-2.5 max-w-[180px]">
                            <div>
                              {tx.ticker && <span className="font-mono font-bold text-text mr-1">{tx.ticker}</span>}
                              <span className="text-muted truncate">{tx.security_name ?? tx.name}</span>
                            </div>
                          </td>
                          {!selectedAccountId && (
                            <td className="px-3 py-2.5 text-muted max-w-[120px]">
                              <span className="truncate block" title={acct?.account_name}>{acct?.account_name ?? '-'}</span>
                            </td>
                          )}
                          <td className="px-3 py-2.5 text-right font-mono">
                            {tx.quantity != null ? `${tx.quantity > 0 ? '+' : ''}${tx.quantity.toFixed(4)}` : '-'}
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono">
                            {tx.price != null ? formatCurrency(tx.price) : '-'}
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono text-muted">
                            {tx.fees != null && tx.fees !== 0 ? formatCurrency(tx.fees) : '-'}
                          </td>
                          <td className="px-3 py-2.5 text-right">
                            <AmountBadge amount={tx.amount} />
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
              {!txsLoading && filteredTxs.length === 0 && (
                <div className="py-12 text-center text-sm text-muted">No transactions found</div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
