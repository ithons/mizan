import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  PieChart,
  Pie,
  Cell,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  CircleAlert,
  Info,
  Lightbulb,
  Target,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { format, startOfMonth, endOfMonth, subMonths, parseISO } from 'date-fns';
import type { Goal, Insight } from '@shared/types';
import { networthApi, reportsApi, recurringApi, budgetsApi, transactionsApi, investmentsApi, insightsApi, goalsApi } from '../lib/api';
import { formatCurrency, formatDate, formatDateShort, formatMonth } from '../lib/formatters';
import { AmountBadge } from '../components/AmountBadge';
import { CategoryBadge } from '../components/CategoryBadge';
import { SkeletonCard } from '../components/SkeletonLoader';

const CHART_COLORS = [
  '#4ecba3', '#5b8dee', '#d4a44c', '#e07070', '#a78bfa',
  '#f472b6', '#34d399', '#fb923c', '#60a5fa', '#f87171',
];

const ASSET_COLORS = ['#4ecba3', '#5b8dee', '#d4a44c', '#9b8dee'];

function StatCard({
  title,
  value,
  delta,
  deltaLabel,
  positive,
  onClick,
}: {
  title: string;
  value: string;
  delta?: number;
  deltaLabel?: string;
  positive?: boolean;
  onClick?: () => void;
}) {
  const isGood = positive !== undefined ? positive : (delta ?? 0) >= 0;
  const cls = `bg-surface border border-border rounded p-5 ${onClick ? 'cursor-pointer hover:bg-[#4ecba3]/5 transition-colors' : ''}`;
  return (
    <div className={cls} onClick={onClick}>
      <p className="text-xs text-muted mb-1">{title}</p>
      <p className="font-mono text-2xl font-medium text-text mb-2">{value}</p>
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

const insightStyles: Record<Insight['severity'], {
  icon: LucideIcon;
  color: string;
  label: string;
}> = {
  critical: { icon: CircleAlert, color: '#e07070', label: 'Critical' },
  warning: { icon: AlertTriangle, color: '#d4a44c', label: 'Warning' },
  positive: { icon: CheckCircle2, color: '#4ecba3', label: 'Good' },
  info: { icon: Info, color: '#5b8dee', label: 'Info' },
};

function SignalsPanel({
  insights,
  onNavigate,
}: {
  insights?: Insight[];
  onNavigate: (route: string) => void;
}) {
  const visibleInsights = insights?.slice(0, 4) ?? [];

  return (
    <div className="bg-surface border border-border rounded">
      <div className="px-4 py-3 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Lightbulb size={15} className="text-[#d4a44c]" />
          <h2 className="text-sm font-medium text-text">Signals</h2>
        </div>
        <button
          onClick={() => onNavigate('/advisor')}
          className="text-xs text-muted hover:text-[#4ecba3] flex items-center gap-1"
        >
          Ask advisor <ArrowRight size={11} />
        </button>
      </div>

      {visibleInsights.length > 0 ? (
        <div className="divide-y divide-border">
          {visibleInsights.map((insight) => {
            const style = insightStyles[insight.severity];
            const Icon = style.icon;
            const actionRoute = insight.action_route;
            const actionLabel = insight.action_label;
            return (
              <div key={insight.id} className="px-4 py-3 flex items-start gap-3">
                <div
                  className="w-7 h-7 rounded flex items-center justify-center flex-shrink-0"
                  style={{ backgroundColor: `${style.color}18` }}
                  title={style.label}
                >
                  <Icon size={14} style={{ color: style.color }} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-0.5">
                    <p className="text-sm font-medium text-text truncate">{insight.title}</p>
                    {insight.metric && (
                      <span className="font-mono text-xs text-muted flex-shrink-0">{insight.metric}</span>
                    )}
                  </div>
                  <p className="text-xs text-muted leading-relaxed">{insight.message}</p>
                </div>
                {actionRoute && actionLabel && (
                  <button
                    onClick={() => onNavigate(actionRoute)}
                    className="text-xs text-muted hover:text-[#4ecba3] flex items-center gap-1 flex-shrink-0 pt-1"
                  >
                    {actionLabel}
                    <ArrowRight size={11} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="px-4 py-8 flex items-center justify-center text-muted text-sm">
          No signals yet
        </div>
      )}
    </div>
  );
}

function GoalProgressRow({ goal }: { goal: Goal }) {
  const progress = Math.min(goal.progress_percent, 100);
  const tone = goal.type === 'debt' ? '#d4a44c' : '#4ecba3';

  return (
    <div>
      <div className="flex items-center justify-between gap-3 text-xs mb-1">
        <span className="text-text truncate">{goal.name}</span>
        <span className="font-mono text-muted flex-shrink-0">{Math.round(progress)}%</span>
      </div>
      <div className="h-1.5 bg-border rounded-full overflow-hidden">
        <div
          className="h-full rounded-full"
          style={{ width: `${progress}%`, backgroundColor: tone }}
        />
      </div>
      <div className="flex items-center justify-between gap-3 text-[11px] text-muted mt-1">
        <span className="truncate">
          {goal.account_name ?? (goal.type === 'debt' ? 'Debt goal' : 'Savings goal')}
        </span>
        <span className="font-mono flex-shrink-0">{formatCurrency(goal.remaining_amount)} left</span>
      </div>
    </div>
  );
}

export function Dashboard() {
  const navigate = useNavigate();
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

  const { data: forecast } = useQuery({
    queryKey: ['recurring', 'forecast', 'dashboard', 30],
    queryFn: () => recurringApi.forecast(30),
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

  const { data: insights } = useQuery({
    queryKey: ['insights', 'dashboard'],
    queryFn: () => insightsApi.list(),
  });

  const { data: goals } = useQuery({
    queryKey: ['goals', 'dashboard'],
    queryFn: () => goalsApi.list(),
  });

  if (nwLoading) {
    return (
      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold text-text">Dashboard</h1>
        </div>
        <div className="grid grid-cols-4 gap-4">
          <SkeletonCard /><SkeletonCard /><SkeletonCard /><SkeletonCard />
        </div>
      </div>
    );
  }

  // Compute stats
  const snapshots = networthHistory ?? [];
  const latestNW = snapshots[snapshots.length - 1];
  const prevNW = snapshots.length >= 2 ? snapshots[snapshots.length - 2] : null;
  const nwDelta = latestNW && prevNW ? latestNW.net_worth - prevNW.net_worth : undefined;

  const months = cashflow?.months ?? [];
  const currentMonthCF = months.find((m) => m.month === currentMonth);
  const prevMonthStr = format(subMonths(parseISO(currentMonth + '-01'), 1), 'yyyy-MM');
  const prevMonthCF = months.find((m) => m.month === prevMonthStr);

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

  // Asset breakdown donut data
  const liquid = latestNW?.liquid_assets ?? 0;
  const investmentAssets = latestNW?.investment_assets ?? 0;
  const crypto = latestNW?.crypto_assets ?? 0;
  const otherAssets = Math.max(0, (latestNW?.total_assets ?? 0) - liquid - investmentAssets - crypto);
  const assetDonutData = [
    { name: 'Liquid', value: liquid },
    { name: 'Investments', value: investmentAssets },
    { name: 'Crypto', value: crypto },
    ...(otherAssets > 0 ? [{ name: 'Other', value: otherAssets }] : []),
  ].filter((d) => d.value > 0);

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
          onClick={() => navigate('/reports')}
        />
        <StatCard
          title="Monthly Spend"
          value={formatCurrency(monthlySpend)}
          delta={spendDelta}
          deltaLabel="vs last month"
          positive={spendDelta !== undefined ? spendDelta <= 0 : undefined}
          onClick={() => navigate('/transactions')}
        />
        <StatCard
          title="Monthly Income"
          value={formatCurrency(monthlyIncome)}
          delta={incomeDelta}
          deltaLabel="vs last month"
          positive={incomeDelta !== undefined ? incomeDelta >= 0 : undefined}
          onClick={() => navigate('/transactions')}
        />
        <div
          className="bg-surface border border-border rounded p-5 cursor-pointer hover:bg-[#4ecba3]/5 transition-colors"
          onClick={() => navigate('/reports')}
        >
          <p className="text-xs text-muted mb-1">Top Category</p>
          {topCategory ? (
            <>
              <p className="text-sm font-medium text-text mb-1">{topCategory.category_name}</p>
              <p className="font-mono text-2xl font-medium text-[#e07070]">{formatCurrency(topCategory.amount)}</p>
            </>
          ) : (
            <p className="text-sm text-muted">No data</p>
          )}
        </div>
      </div>

      <SignalsPanel insights={insights} onNavigate={navigate} />

      {/* Row 2: Asset Breakdown */}
      <div className="bg-surface border border-border rounded p-4">
        <h2 className="text-sm font-medium text-text mb-4">Asset Breakdown</h2>
        {assetDonutData.length > 0 ? (
          <div className="flex items-center gap-8">
            <div className="relative flex-shrink-0">
              <ResponsiveContainer width={160} height={160}>
                <PieChart>
                  <Pie
                    data={assetDonutData}
                    cx="50%"
                    cy="50%"
                    innerRadius={48}
                    outerRadius={72}
                    dataKey="value"
                    paddingAngle={2}
                  >
                    {assetDonutData.map((_entry, index) => (
                      <Cell key={index} fill={ASSET_COLORS[index % ASSET_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip content={<CustomTooltip />} />
                </PieChart>
              </ResponsiveContainer>
              <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                <p className="text-xs text-muted">Net Worth</p>
                <p className="font-mono text-sm font-medium text-text">{formatCurrency(latestNW?.net_worth ?? 0)}</p>
              </div>
            </div>
            <div className="flex flex-wrap gap-x-6 gap-y-2">
              {assetDonutData.map((entry, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: ASSET_COLORS[i % ASSET_COLORS.length] }} />
                  <div>
                    <p className="text-xs text-muted">{entry.name}</p>
                    <p className="font-mono text-sm text-text">{formatCurrency(entry.value)}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="h-24 flex items-center justify-center text-muted text-sm">
            No asset data available
          </div>
        )}
      </div>

      {/* Row 3: Donut + Upcoming bills */}
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
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-medium text-text">Next 30 Days</h2>
            <button onClick={() => navigate('/bills')} className="text-xs text-muted hover:text-[#4ecba3] flex items-center gap-1">
              View all <ArrowRight size={11} />
            </button>
          </div>
          {forecast && forecast.occurrences.length > 0 ? (
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-2 text-xs">
                <div>
                  <p className="text-muted mb-0.5">Income</p>
                  <p className="font-mono text-[#4ecba3]">{formatCurrency(forecast.income)}</p>
                </div>
                <div>
                  <p className="text-muted mb-0.5">Bills</p>
                  <p className="font-mono text-[#e07070]">{formatCurrency(-forecast.bills)}</p>
                </div>
                <div>
                  <p className="text-muted mb-0.5">Net</p>
                  <p className="font-mono" style={{ color: forecast.net >= 0 ? '#4ecba3' : '#e07070' }}>
                    {formatCurrency(forecast.net)}
                  </p>
                </div>
              </div>
              <div className="space-y-2">
                {forecast.occurrences.slice(0, 5).map((item) => (
                  <div key={item.id} className="flex items-center justify-between py-1.5 border-b border-border last:border-0">
                    <div className="min-w-0">
                      <p className="text-sm text-text truncate">{item.merchant_name}</p>
                      <p className="text-xs text-muted font-mono">{formatDateShort(item.expected_date)}</p>
                    </div>
                    <span
                      className="font-mono text-sm ml-2"
                      style={{ color: item.amount >= 0 ? '#4ecba3' : '#e07070' }}
                    >
                      {formatCurrency(item.amount)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="h-32 flex items-center justify-center text-muted text-sm">
              No recurring activity scheduled
            </div>
          )}
        </div>
      </div>

      {/* Row 4: Budget + Goals + Investments */}
      <div className="grid grid-cols-3 gap-4">
        {/* Budget progress */}
        <div className="bg-surface border border-border rounded p-4">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-medium text-text">Budget Progress</h2>
            <button onClick={() => navigate('/budget')} className="text-xs text-muted hover:text-[#4ecba3] flex items-center gap-1">
              View all <ArrowRight size={11} />
            </button>
          </div>
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

        {/* Goal progress */}
        <div className="bg-surface border border-border rounded p-4">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Target size={14} className="text-[#d4a44c]" />
              <h2 className="text-sm font-medium text-text">Goals</h2>
            </div>
            <button onClick={() => navigate('/goals')} className="text-xs text-muted hover:text-[#4ecba3] flex items-center gap-1">
              View all <ArrowRight size={11} />
            </button>
          </div>
          {goals && goals.length > 0 ? (
            <div className="space-y-3">
              {goals.slice(0, 4).map((goal) => (
                <GoalProgressRow key={goal.id} goal={goal} />
              ))}
            </div>
          ) : (
            <div className="h-32 flex items-center justify-center text-muted text-sm">
              No goals set
            </div>
          )}
        </div>

        {/* Investment Snapshot */}
        <div className="bg-surface border border-border rounded p-4">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-medium text-text">Investments</h2>
            <button onClick={() => navigate('/investments')} className="text-xs text-muted hover:text-[#4ecba3] flex items-center gap-1">
              View all <ArrowRight size={11} />
            </button>
          </div>
          {holdings && holdings.length > 0 ? (
            <>
              <p className="font-mono text-2xl text-[#5b8dee] mb-4">{formatCurrency(investmentTotal)}</p>
              <div className="space-y-2">
                {holdings.slice(0, 5).map((h) => {
                  const unrealized = h.cost_basis != null ? h.institution_value - h.cost_basis : null;
                  return (
                    <div key={h.id} className="flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[#5b8dee] font-medium">{h.ticker ?? '-'}</span>
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

      {/* Row 5: Recent Transactions */}
      <div className="bg-surface border border-border rounded">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <h2 className="text-sm font-medium text-text">Recent Transactions</h2>
          <button onClick={() => navigate('/transactions')} className="text-xs text-muted hover:text-[#4ecba3] flex items-center gap-1">
            View all <ArrowRight size={11} />
          </button>
        </div>
        {recentTxs && recentTxs.data.length > 0 ? (
          <div className="divide-y divide-border">
            {recentTxs.data.map((tx) => (
              <div key={tx.id} className="flex items-center px-4 py-2.5 gap-4 hover:bg-white/2 cursor-pointer" onClick={() => navigate('/transactions')}>
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
