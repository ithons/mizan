import React from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  PieChart,
  Pie,
  Cell,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { TrendingUp, TrendingDown, RefreshCw, AlertTriangle } from 'lucide-react';
import { format, startOfMonth, endOfMonth } from 'date-fns';
import { networthApi, reportsApi, recurringApi, budgetsApi, transactionsApi, investmentsApi } from '../lib/api';
import { formatCurrency, formatDate, formatDateShort, formatMonth } from '../lib/formatters';
import { AmountBadge } from '../components/AmountBadge';
import { CategoryBadge } from '../components/CategoryBadge';
import { PageLoader } from '../components/LoadingSpinner';

const CHART_COLORS = [
  '#4ecba3', '#5b8dee', '#d4a44c', '#e07070', '#a78bfa',
  '#f472b6', '#34d399', '#fb923c', '#60a5fa', '#f87171',
];

function StatCard({
  title,
  value,
  delta,
  deltaLabel,
  positive,
}: {
  title: string;
  value: string;
  delta?: number;
  deltaLabel?: string;
  positive?: boolean;
}) {
  const isGood = positive !== undefined ? positive : (delta ?? 0) >= 0;
  return (
    <div className="bg-surface border border-border rounded p-4">
      <p className="text-xs text-muted mb-1">{title}</p>
      <p className="font-mono text-xl font-medium text-text mb-2">{value}</p>
      {delta !== undefined && (
        <div className="flex items-center gap-1">
          {isGood ? (
            <TrendingUp size={12} className="text-[#4ecba3]" />
          ) : (
            <TrendingDown size={12} className="text-[#e07070]" />
          )}
          <span
            className="text-xs font-mono"
            style={{ color: isGood ? '#4ecba3' : '#e07070' }}
          >
            {delta >= 0 ? '+' : ''}{formatCurrency(delta)} {deltaLabel}
          </span>
        </div>
      )}
    </div>
  );
}

function CustomTooltip({ active, payload }: { active?: boolean; payload?: Array<{ name: string; value: number; payload: { color?: string } }> }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-surface border border-border rounded px-3 py-2 text-sm">
      <p className="text-text">{payload[0].name}</p>
      <p className="font-mono text-[#4ecba3]">{formatCurrency(payload[0].value)}</p>
    </div>
  );
}

export function Dashboard() {
  const now = new Date();
  const currentMonth = format(now, 'yyyy-MM');
  const startDate = format(startOfMonth(now), 'yyyy-MM-dd');
  const endDate = format(endOfMonth(now), 'yyyy-MM-dd');

  const { data: networthHistory, isLoading: nwLoading } = useQuery({
    queryKey: ['networth', 'history'],
    queryFn: () => networthApi.history(2),
  });

  const { data: cashflow } = useQuery({
    queryKey: ['cashflow', 'dashboard'],
    queryFn: () => reportsApi.cashflow({ startDate: format(startOfMonth(new Date(now.getFullYear(), now.getMonth() - 1, 1)), 'yyyy-MM-dd'), endDate }),
  });

  const { data: spending } = useQuery({
    queryKey: ['spending', currentMonth],
    queryFn: () => reportsApi.spending({ startDate, endDate }),
  });

  const { data: upcoming } = useQuery({
    queryKey: ['recurring', 'upcoming', 7],
    queryFn: () => recurringApi.upcoming(7),
  });

  const { data: budgets } = useQuery({
    queryKey: ['budgets', 'month', currentMonth],
    queryFn: () => budgetsApi.getMonth(currentMonth),
  });

  const { data: recentTxs } = useQuery({
    queryKey: ['transactions', 'recent'],
    queryFn: () => transactionsApi.list({ limit: 10, page: 1, startDate, endDate }),
  });

  const { data: holdings } = useQuery({
    queryKey: ['holdings'],
    queryFn: () => investmentsApi.holdings(),
  });

  if (nwLoading) return <PageLoader />;

  // Compute stats
  const snapshots = networthHistory ?? [];
  const latestNW = snapshots[snapshots.length - 1];
  const prevNW = snapshots.length >= 2 ? snapshots[snapshots.length - 2] : null;
  const nwDelta = latestNW && prevNW ? latestNW.net_worth - prevNW.net_worth : undefined;

  const months = cashflow?.months ?? [];
  const currentMonthCF = months.find((m) => m.month === currentMonth);
  const prevMonthCF = months.find((m) => m.month !== currentMonth);

  const monthlySpend = Math.abs(currentMonthCF?.expenses ?? 0);
  const prevSpend = Math.abs(prevMonthCF?.expenses ?? 0);
  const spendDelta = prevSpend ? monthlySpend - prevSpend : undefined;

  const monthlyIncome = currentMonthCF?.income ?? 0;
  const prevIncome = prevMonthCF?.income ?? 0;
  const incomeDelta = prevIncome ? monthlyIncome - prevIncome : undefined;

  // Top spending category
  const categories = spending?.categories ?? [];
  const topCategory = categories[0];

  // Investment total
  const investmentTotal = (holdings ?? []).reduce((sum, h) => sum + h.institution_value, 0);

  // Spending donut data
  const donutData = categories.slice(0, 8).map((c, i) => ({
    name: c.category_name,
    value: c.amount,
    color: c.color || CHART_COLORS[i % CHART_COLORS.length],
  }));

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-text">Dashboard</h1>
        <span className="text-sm text-muted font-mono">{formatMonth(currentMonth)}</span>
      </div>

      {/* Row 1: Stat cards */}
      <div className="grid grid-cols-4 gap-4">
        <StatCard
          title="Net Worth"
          value={formatCurrency(latestNW?.net_worth ?? 0)}
          delta={nwDelta}
          deltaLabel="vs last month"
          positive={nwDelta !== undefined ? nwDelta >= 0 : undefined}
        />
        <StatCard
          title="Monthly Spend"
          value={formatCurrency(monthlySpend)}
          delta={spendDelta}
          deltaLabel="vs last month"
          positive={spendDelta !== undefined ? spendDelta <= 0 : undefined}
        />
        <StatCard
          title="Monthly Income"
          value={formatCurrency(monthlyIncome)}
          delta={incomeDelta}
          deltaLabel="vs last month"
          positive={incomeDelta !== undefined ? incomeDelta >= 0 : undefined}
        />
        <div className="bg-surface border border-border rounded p-4">
          <p className="text-xs text-muted mb-1">Top Category</p>
          {topCategory ? (
            <>
              <p className="text-sm font-medium text-text mb-1">{topCategory.category_name}</p>
              <p className="font-mono text-base text-[#e07070]">{formatCurrency(topCategory.amount)}</p>
            </>
          ) : (
            <p className="text-sm text-muted">No data</p>
          )}
        </div>
      </div>

      {/* Row 2: Donut + Upcoming bills */}
      <div className="grid grid-cols-5 gap-4">
        {/* Spending Donut */}
        <div className="col-span-3 bg-surface border border-border rounded p-4">
          <h2 className="text-sm font-medium text-text mb-4">Spending by Category</h2>
          {donutData.length > 0 ? (
            <>
              <ResponsiveContainer width="100%" height={200}>
                <PieChart>
                  <Pie
                    data={donutData}
                    cx="50%"
                    cy="50%"
                    innerRadius={55}
                    outerRadius={85}
                    dataKey="value"
                    paddingAngle={2}
                  >
                    {donutData.map((entry, index) => (
                      <Cell key={index} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip content={<CustomTooltip />} />
                </PieChart>
              </ResponsiveContainer>
              {/* Custom legend */}
              <div className="flex flex-wrap gap-x-4 gap-y-1.5 mt-3">
                {donutData.map((entry, i) => (
                  <div key={i} className="flex items-center gap-1.5 text-xs text-muted">
                    <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: entry.color }} />
                    <span className="text-text">{entry.name}</span>
                    <span className="font-mono">{formatCurrency(entry.value)}</span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="h-48 flex items-center justify-center text-muted text-sm">
              No spending data for this month
            </div>
          )}
        </div>

        {/* Upcoming Bills */}
        <div className="col-span-2 bg-surface border border-border rounded p-4">
          <h2 className="text-sm font-medium text-text mb-4">Upcoming Bills (7 days)</h2>
          {upcoming && upcoming.length > 0 ? (
            <div className="space-y-2">
              {upcoming.map((bill) => (
                <div key={bill.id} className="flex items-center justify-between py-1.5 border-b border-border last:border-0">
                  <div className="min-w-0">
                    <p className="text-sm text-text truncate">{bill.merchant_name}</p>
                    <p className="text-xs text-muted font-mono">{formatDateShort(bill.next_expected)}</p>
                  </div>
                  <span className="font-mono text-sm text-[#e07070] ml-2">
                    {formatCurrency(bill.average_amount)}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="h-32 flex items-center justify-center text-muted text-sm">
              No upcoming bills
            </div>
          )}
        </div>
      </div>

      {/* Row 3: Budget + Investments */}
      <div className="grid grid-cols-2 gap-4">
        {/* Budget progress */}
        <div className="bg-surface border border-border rounded p-4">
          <h2 className="text-sm font-medium text-text mb-4">Budget Progress</h2>
          {budgets && budgets.length > 0 ? (
            <div className="space-y-3">
              {budgets.slice(0, 6).map((budget) => {
                const spent = budget.spent ?? 0;
                const pct = budget.amount > 0 ? (spent / budget.amount) * 100 : 0;
                const barColor = pct >= 100 ? '#e07070' : pct >= 80 ? '#d4a44c' : '#4ecba3';
                return (
                  <div key={budget.id}>
                    <div className="flex items-center justify-between text-xs mb-1">
                      <span className="text-text">{budget.category_name}</span>
                      <span className="font-mono text-muted">
                        {formatCurrency(spent)} / {formatCurrency(budget.amount)}
                      </span>
                    </div>
                    <div className="h-1.5 bg-border rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all"
                        style={{
                          width: `${Math.min(pct, 100)}%`,
                          backgroundColor: barColor,
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="h-32 flex items-center justify-center text-muted text-sm">
              No budgets set
            </div>
          )}
        </div>

        {/* Investment Snapshot */}
        <div className="bg-surface border border-border rounded p-4">
          <h2 className="text-sm font-medium text-text mb-4">Investments</h2>
          {holdings && holdings.length > 0 ? (
            <>
              <p className="font-mono text-2xl text-[#5b8dee] mb-4">{formatCurrency(investmentTotal)}</p>
              <div className="space-y-2">
                {holdings.slice(0, 5).map((h) => {
                  const unrealized = h.cost_basis != null ? h.institution_value - h.cost_basis : null;
                  return (
                    <div key={h.id} className="flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[#5b8dee] font-medium">{h.ticker ?? '—'}</span>
                        <span className="text-muted truncate max-w-[120px]">{h.security_name}</span>
                      </div>
                      <div className="text-right">
                        <p className="font-mono text-text">{formatCurrency(h.institution_value)}</p>
                        {unrealized != null && (
                          <p className="font-mono" style={{ color: unrealized >= 0 ? '#4ecba3' : '#e07070' }}>
                            {unrealized >= 0 ? '+' : ''}{formatCurrency(unrealized)}
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          ) : (
            <div className="h-32 flex items-center justify-center text-muted text-sm">
              No investment accounts
            </div>
          )}
        </div>
      </div>

      {/* Row 4: Recent Transactions */}
      <div className="bg-surface border border-border rounded">
        <div className="px-4 py-3 border-b border-border">
          <h2 className="text-sm font-medium text-text">Recent Transactions</h2>
        </div>
        {recentTxs && recentTxs.data.length > 0 ? (
          <div className="divide-y divide-border">
            {recentTxs.data.map((tx) => (
              <div key={tx.id} className="flex items-center px-4 py-2.5 gap-4 hover:bg-white/2">
                <span className="font-mono text-xs text-muted w-20 flex-shrink-0">{formatDate(tx.date)}</span>
                <span className="text-sm text-text flex-1 truncate">{tx.merchant_name || tx.original_name}</span>
                <span className="text-xs text-muted flex-shrink-0">
                  {tx.category_name ? (
                    <CategoryBadge name={tx.category_name} color={tx.category_color} icon={tx.category_icon} />
                  ) : (
                    <span className="text-muted">Uncategorized</span>
                  )}
                </span>
                <AmountBadge amount={tx.amount} className="flex-shrink-0 w-24 text-right" />
              </div>
            ))}
          </div>
        ) : (
          <div className="py-12 flex items-center justify-center text-muted text-sm">
            No transactions this month
          </div>
        )}
      </div>
    </div>
  );
}
