import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Legend,
} from 'recharts';
import { ChevronLeft, ChevronRight, ArrowRight, X } from 'lucide-react';
import { format, subMonths, startOfMonth, endOfMonth, addMonths } from 'date-fns';
import {
  reportsApi,
  transactionsApi,
  categoriesApi,
  recurringApi,
  flattenCategories,
  collectCategoryAndDescendantIds,
} from '../lib/api';
import { formatCurrency, formatMonth } from '../lib/formatters';
import { PageLoader } from '../components/LoadingSpinner';
import { AmountBadge } from '../components/AmountBadge';
import { CategoryBadge } from '../components/CategoryBadge';
import { EmptyState } from '../components/EmptyState';

interface TooltipPayload {
  dataKey: string | number;
  color?: string;
  name?: string;
  value: number;
}

interface CustomTooltipProps {
  active?: boolean;
  payload?: TooltipPayload[];
  label?: string | number;
}

function CustomTooltip({ active, payload, label }: CustomTooltipProps) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-surface shadow-sm border border-border rounded px-3 py-2 text-xs">
      <p className="text-muted mb-1 font-mono">{label}</p>
      {payload.map((p) => (
        <div key={p.dataKey} className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: p.color ?? '#6b6b7a' }} />
          <span className="text-text">{p.name ?? p.dataKey}:</span>
          <span className="font-mono" style={{ color: p.color ?? '#6b6b7a' }}>{formatCurrency(Math.abs(p.value))}</span>
        </div>
      ))}
    </div>
  );
}

export function CashFlow() {
  const navigate = useNavigate();
  const now = new Date();
  const [currentMonth, setCurrentMonth] = useState(format(now, 'yyyy-MM'));

  const monthDate = new Date(`${currentMonth}-01`);
  const startDate = format(startOfMonth(subMonths(monthDate, 11)), 'yyyy-MM-dd');
  const endDate = format(endOfMonth(monthDate), 'yyyy-MM-dd');

  const selectedStartDate = format(startOfMonth(monthDate), 'yyyy-MM-dd');
  const selectedEndDate = format(endOfMonth(monthDate), 'yyyy-MM-dd');

  const { data: forecast } = useQuery({
    queryKey: ["recurring", "forecast", 30],
    queryFn: () => recurringApi.forecast(30),
  });

  const { data: cashflow, isLoading } = useQuery({
    queryKey: ['cashflow', startDate, endDate],
    queryFn: () => reportsApi.cashflow({ startDate, endDate }),
  });

  const { data: txData } = useQuery({
    queryKey: ['transactions', 'cashflow', currentMonth],
    queryFn: () => transactionsApi.list({
      startDate: selectedStartDate,
      endDate: selectedEndDate,
      limit: 200,
      page: 1,
    }),
  });

  const { data: categoriesTree = [] } = useQuery({
    queryKey: ['categories'],
    queryFn: categoriesApi.list,
  });
  const categories = flattenCategories(categoriesTree);

  const [filterCategoryId, setFilterCategoryId] = useState('');

  const months = cashflow?.months ?? [];

  // Formatted chart data
  const chartData = months.map((m) => ({
    month: format(new Date(`${m.month}-01`), 'MMM yy'),
    income: m.income,
    expenses: Math.abs(m.expenses),
    net: m.net,
  }));

  // Selected month data
  const selectedMonthData = months.find((m) => m.month === currentMonth);
  const filterCategoryIds = new Set(
    filterCategoryId ? collectCategoryAndDescendantIds(categoriesTree, filterCategoryId) : []
  );
  const txs = (txData?.data ?? []).filter(
    (t) => !filterCategoryId || (t.category_id ? filterCategoryIds.has(t.category_id) : false)
  );

  if (isLoading) return <PageLoader />;

  return (
    <div className="p-6 space-y-6">
      {/* Header with month selector */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-text">Cash Flow</h1>
        <div className="flex items-center gap-2">
          <button
            className="p-1.5 text-muted hover:text-text border border-border rounded"
            onClick={() => setCurrentMonth(format(subMonths(monthDate, 1), 'yyyy-MM'))}
          >
            <ChevronLeft size={16} />
          </button>
          <span className="font-mono text-sm text-text px-3 py-1 bg-surface shadow-sm border border-border rounded min-w-[120px] text-center">
            {formatMonth(currentMonth)}
          </span>
          <button
            className="p-1.5 text-muted hover:text-text border border-border rounded"
            onClick={() => setCurrentMonth(format(addMonths(monthDate, 1), 'yyyy-MM'))}
            disabled={currentMonth >= format(now, 'yyyy-MM')}
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>

      {/* Bar Chart */}
      <div className="bg-surface shadow-sm border border-border rounded p-4">
        <h2 className="text-sm font-medium text-text mb-4">Income vs Expenses - Trailing 12 Months</h2>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={chartData} barCategoryGap="30%">
            <CartesianGrid vertical={false} stroke="#dbe7e2" />
            <XAxis dataKey="month" tick={{ fill: '#6b6b7a', fontSize: 11, fontFamily: 'JetBrains Mono' }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fill: '#6b6b7a', fontSize: 11, fontFamily: 'JetBrains Mono' }} axisLine={false} tickLine={false} tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} />
            <Tooltip content={<CustomTooltip />} />
            <Legend wrapperStyle={{ fontSize: 11, color: '#6b6b7a' }} />
            <Bar dataKey="income" name="Income" fill="#32bfa3" radius={[2, 2, 0, 0]} />
            <Bar dataKey="expenses" name="Expenses" fill="#ef6f8a" radius={[2, 2, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Line Chart */}
      <div className="bg-surface shadow-sm border border-border rounded p-4">
        <h2 className="text-sm font-medium text-text mb-4">Net Cash Flow - Trailing 12 Months</h2>
        <ResponsiveContainer width="100%" height={180}>
          <LineChart data={chartData}>
            <CartesianGrid vertical={false} stroke="#dbe7e2" />
            <XAxis dataKey="month" tick={{ fill: '#6b6b7a', fontSize: 11, fontFamily: 'JetBrains Mono' }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fill: '#6b6b7a', fontSize: 11, fontFamily: 'JetBrains Mono' }} axisLine={false} tickLine={false} tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} />
            <Tooltip content={<CustomTooltip />} />
            <Line
              type="monotone"
              dataKey="net"
              name="Net"
              stroke="#32bfa3"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, fill: '#32bfa3' }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>


      {/* 30-Day Forward Forecast */}
      {currentMonth === format(now, 'yyyy-MM') && forecast && (
        <div className="bg-surface shadow-sm border border-border rounded p-4">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-medium text-text">30-Day Forward Projection</h2>
            <div className="text-right">
              <p className="text-xs text-muted mb-0.5">Projected Net</p>
              <p className={`font-mono text-sm font-medium ${forecast.net >= 0 ? 'text-green' : 'text-rose'}`}>
                {forecast.net >= 0 ? '+' : ''}{formatCurrency(forecast.net)}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="bg-background border border-border rounded p-3">
              <p className="text-xs text-muted mb-1 flex items-center justify-between">
                Confirmed Income
                <span className="w-1.5 h-1.5 rounded-full bg-green" />
              </p>
              <p className="font-mono text-sm text-green">{formatCurrency(forecast.confirmed_income)}</p>
            </div>
            <div className="bg-background border border-border rounded p-3">
              <p className="text-xs text-muted mb-1 flex items-center justify-between">
                Likely Income
                <span className="w-1.5 h-1.5 rounded-full bg-green-50" />
              </p>
              <p className="font-mono text-sm text-green/80">{formatCurrency(forecast.likely_income)}</p>
            </div>
            <div className="bg-background border border-border rounded p-3">
              <p className="text-xs text-muted mb-1 flex items-center justify-between">
                Confirmed Bills
                <span className="w-1.5 h-1.5 rounded-full bg-rose" />
              </p>
              <p className="font-mono text-sm text-rose">{formatCurrency(forecast.confirmed_bills)}</p>
            </div>
            <div className="bg-background border border-border rounded p-3">
              <p className="text-xs text-muted mb-1 flex items-center justify-between">
                Likely Bills
                <span className="w-1.5 h-1.5 rounded-full bg-rose/50" />
              </p>
              <p className="font-mono text-sm text-rose/80">{formatCurrency(forecast.likely_bills)}</p>
            </div>
          </div>
        </div>
      )}
      {/* Selected month breakdown */}
      {selectedMonthData && (
        <div className="grid grid-cols-3 gap-4">
          <div
            className="bg-surface shadow-sm border border-border rounded p-4 cursor-pointer hover:bg-green/5 transition-colors"
            onClick={() => navigate('/transactions')}
          >
            <p className="text-xs text-muted mb-1">Income</p>
            <p className="font-mono text-xl text-green">{formatCurrency(selectedMonthData.income)}</p>
          </div>
          <div
            className="bg-surface shadow-sm border border-border rounded p-4 cursor-pointer hover:bg-green/5 transition-colors"
            onClick={() => navigate('/transactions')}
          >
            <p className="text-xs text-muted mb-1">Expenses</p>
            <p className="font-mono text-xl text-rose">{formatCurrency(Math.abs(selectedMonthData.expenses))}</p>
          </div>
          <div className="bg-surface shadow-sm border border-border rounded p-4">
            <p className="text-xs text-muted mb-1">Net</p>
            <p
              className="font-mono text-xl"
              style={{ color: selectedMonthData.net >= 0 ? '#32bfa3' : '#ef6f8a' }}
            >
              {formatCurrency(selectedMonthData.net)}
            </p>
          </div>
        </div>
      )}

      {/* Transaction list for selected month */}
      <div className="bg-surface shadow-sm border border-border rounded">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-sm font-medium text-text">Transactions - {formatMonth(currentMonth)}</h2>
          <div className="flex items-center gap-2">
            <select
              className="bg-background border border-border rounded px-2 py-1 text-xs text-text"
              value={filterCategoryId}
              onChange={(e) => setFilterCategoryId(e.target.value)}
            >
              <option value="">All Categories</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
            {filterCategoryId && (
              <button
                className="text-muted hover:text-text"
                onClick={() => setFilterCategoryId('')}
                title="Clear filter"
              >
                <X size={13} />
              </button>
            )}
          </div>
        </div>
        <div className="divide-y divide-border">
          {txs.length === 0 ? (
            <EmptyState
              icon={ArrowRight}
              title={`No transactions for ${formatMonth(currentMonth)}`}
              description={filterCategoryId ? 'Try clearing the category filter.' : undefined}
              action={filterCategoryId ? () => setFilterCategoryId('') : () => navigate('/transactions')}
              actionLabel={filterCategoryId ? 'Clear Filter' : 'Review Transactions'}
              secondaryAction={filterCategoryId ? () => navigate('/transactions') : () => navigate('/accounts?connect=bank')}
              secondaryActionLabel={filterCategoryId ? 'View Ledger' : 'Connect Account'}
            />
          ) : (
            <>
              {txs.slice(0, 50).map((tx) => (
                <div key={tx.id} className="flex items-center px-4 py-2.5 gap-4 hover:bg-black/5">
                  <span className="font-mono text-xs text-muted w-20 flex-shrink-0">{tx.date}</span>
                  <span className="text-sm text-text flex-1 truncate">{tx.merchant_name || tx.original_name}</span>
                  {tx.category_name ? (
                    <CategoryBadge name={tx.category_name} color={tx.category_color} icon={tx.category_icon} />
                  ) : (
                    <span className="text-xs text-muted">Uncategorized</span>
                  )}
                  <AmountBadge amount={tx.amount} className="flex-shrink-0" />
                </div>
              ))}
              {txs.length > 50 && (
                <div className="flex items-center justify-between px-4 py-3 border-t border-border">
                  <span className="text-xs text-muted">Showing 50 of {txs.length}</span>
                  <button
                    className="text-xs text-green hover:opacity-80 flex items-center gap-1"
                    onClick={() => navigate('/transactions')}
                  >
                    View all <ArrowRight size={11} />
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
