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
  CreditCard,
  FileInput,
  Info,
  Lightbulb,
  Plus,
  RefreshCw,
  ShieldCheck,
  Wallet,
  Target,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { format, startOfMonth, endOfMonth, subMonths, parseISO } from 'date-fns';
import type { DataQualitySummary, Goal, Insight, RecurringForecast, SyncHealth, SyncRun, TransactionReviewSummary } from '@shared/types';
import { accountsApi, networthApi, reportsApi, recurringApi, budgetsApi, transactionsApi, investmentsApi, insightsApi, goalsApi, syncApi } from '../lib/api';
import { getDashboardMode, type DashboardMode } from '../lib/dashboardState';
import { formatCurrency, formatDate, formatDateShort, formatMonth, formatRelativeTime } from '../lib/formatters';
import { AmountBadge } from '../components/AmountBadge';
import { CategoryBadge } from '../components/CategoryBadge';
import { SkeletonCard } from '../components/SkeletonLoader';
import { SyncActivityPanel } from '../components/SyncActivityPanel';

const CHART_COLORS = [
  '#32bfa3', '#6487f0', '#e2a53f', '#ef6f8a', '#a78bfa',
  '#f472b6', '#34d399', '#fb923c', '#60a5fa', '#f87171',
];

const ASSET_COLORS = ['#32bfa3', '#6487f0', '#e2a53f', '#9b8dee'];

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
  const cls = `bg-surface border border-border rounded p-5 ${onClick ? 'cursor-pointer hover:bg-[#32bfa3]/5 transition-colors' : ''}`;
  return (
    <div className={cls} onClick={onClick}>
      <p className="text-xs text-muted mb-1">{title}</p>
      <p className="font-mono text-2xl font-medium text-text mb-2">{value}</p>
      {delta !== undefined && (
        <div className="flex items-center gap-1">
          {isGood ? (
            <TrendingUp size={12} className="text-[#32bfa3]" />
          ) : (
            <TrendingDown size={12} className="text-[#ef6f8a]" />
          )}
          <span
            className="text-xs font-mono"
            style={{ color: isGood ? '#32bfa3' : '#ef6f8a' }}
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
      <p className="font-mono text-[#32bfa3]">{formatCurrency(payload[0].value)}</p>
    </div>
  );
}

const insightStyles: Record<Insight['severity'], {
  icon: LucideIcon;
  color: string;
  label: string;
}> = {
  critical: { icon: CircleAlert, color: '#ef6f8a', label: 'Critical' },
  warning: { icon: AlertTriangle, color: '#e2a53f', label: 'Warning' },
  positive: { icon: CheckCircle2, color: '#32bfa3', label: 'Good' },
  info: { icon: Info, color: '#6487f0', label: 'Info' },
};

const dataQualityTone: Record<DataQualitySummary['status'], {
  icon: LucideIcon;
  color: string;
  label: string;
}> = {
  healthy: { icon: ShieldCheck, color: '#32bfa3', label: 'Reliable' },
  review: { icon: Info, color: '#6487f0', label: 'Review' },
  stale: { icon: AlertTriangle, color: '#e2a53f', label: 'Stale' },
  attention: { icon: CircleAlert, color: '#ef6f8a', label: 'Attention' },
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
          <Lightbulb size={15} className="text-[#e2a53f]" />
          <h2 className="text-sm font-medium text-text">Signals</h2>
        </div>
        <button
          onClick={() => onNavigate('/advisor')}
          className="text-xs text-muted hover:text-[#32bfa3] flex items-center gap-1"
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
                    className="text-xs text-muted hover:text-[#32bfa3] flex items-center gap-1 flex-shrink-0 pt-1"
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
  const tone = goal.type === 'debt' ? '#e2a53f' : '#32bfa3';

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

function DataQualityPanel({
  quality,
  onNavigate,
}: {
  quality?: DataQualitySummary;
  onNavigate: (route: string) => void;
}) {
  const fallbackTone = { icon: ShieldCheck, color: '#6b6b7a', label: 'Loading' };
  const tone = quality ? dataQualityTone[quality.status] : fallbackTone;
  const Icon = tone.icon;
  const visibleIssues = quality?.issues.slice(0, 3) ?? [];
  const primaryRoute = visibleIssues[0]?.route ?? '/advisor';

  return (
    <div className="bg-surface border border-border rounded p-4">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Icon size={14} style={{ color: tone.color }} />
          <h2 className="text-sm font-medium text-text">Data Quality</h2>
        </div>
        <button onClick={() => onNavigate(primaryRoute)} className="text-xs text-muted hover:text-[#32bfa3] flex items-center gap-1">
          Review <ArrowRight size={11} />
        </button>
      </div>

      <div className="flex items-end justify-between gap-3 mb-3">
        <div>
          <p className="text-xs text-muted mb-1">Trust score</p>
          <p className="font-mono text-2xl font-medium" style={{ color: tone.color }}>
            {quality ? quality.score : '--'}
          </p>
        </div>
        <div className="text-right min-w-0">
          <p className="text-xs text-muted mb-1">Status</p>
          <p className="text-sm font-medium truncate" style={{ color: tone.color }}>
            {quality?.status_label ?? tone.label}
          </p>
        </div>
      </div>

      <p className="text-xs text-muted leading-relaxed mb-3">
        {quality?.status_detail ?? 'Checking sync, review queues, forecasts, and report caveats.'}
      </p>

      {visibleIssues.length > 0 ? (
        <div className="space-y-2">
          {visibleIssues.map((issue) => {
            const issueTone = insightStyles[issue.severity];
            return (
              <button
                key={issue.id}
                onClick={() => onNavigate(issue.route)}
                className="w-full flex items-start gap-2 text-left text-xs hover:bg-white/5 rounded p-1 -m-1"
              >
                <span className="w-1.5 h-1.5 rounded-full flex-shrink-0 mt-1.5" style={{ backgroundColor: issueTone.color }} />
                <span className="min-w-0">
                  <span className="block text-text truncate">{issue.label}</span>
                  <span className="block text-muted leading-relaxed">{issue.message}</span>
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="h-16 flex items-center justify-center text-muted text-sm">
          No trust blockers
        </div>
      )}
    </div>
  );
}

const syncHealthTone: Record<SyncHealth['status'], { label: string; color: string }> = {
  empty: { label: 'Not connected', color: '#6b6b7a' },
  healthy: { label: 'Fresh', color: '#32bfa3' },
  stale: { label: 'Stale', color: '#e2a53f' },
  attention: { label: 'Needs attention', color: '#ef6f8a' },
};

function SyncHealthPanel({
  health,
  onNavigate,
}: {
  health?: SyncHealth;
  onNavigate: (route: string) => void;
}) {
  const tone = syncHealthTone[health?.status ?? 'empty'];
  const topConnections = health?.connections.slice(0, 3) ?? [];

  return (
    <div className="bg-surface border border-border rounded p-4">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <RefreshCw size={14} style={{ color: tone.color }} />
          <h2 className="text-sm font-medium text-text">Sync Health</h2>
        </div>
        <button onClick={() => onNavigate('/accounts')} className="text-xs text-muted hover:text-[#32bfa3] flex items-center gap-1">
          Accounts <ArrowRight size={11} />
        </button>
      </div>

      <div className="flex items-baseline justify-between gap-3 mb-3">
        <div>
          <p className="text-xs text-muted mb-1">Status</p>
          <p className="text-sm font-medium" style={{ color: tone.color }}>{health?.status_label ?? tone.label}</p>
        </div>
        <div className="text-right">
          <p className="text-xs text-muted mb-1">Last sync</p>
          <p className="text-xs font-mono text-text">
            {health?.last_synced_at ? formatRelativeTime(health.last_synced_at) : 'Never'}
          </p>
        </div>
      </div>

      {health && health.connection_count > 0 ? (
        <div className="space-y-2">
          <div className="grid grid-cols-3 gap-2 text-xs">
            <div>
              <p className="text-muted mb-0.5">Connections</p>
              <p className="font-mono text-text">{health.connection_count}</p>
            </div>
            <div>
              <p className="text-muted mb-0.5">Stale</p>
              <p className="font-mono" style={{ color: health.stale_count > 0 ? '#e2a53f' : '#32bfa3' }}>
                {health.stale_count}
              </p>
            </div>
            <div>
              <p className="text-muted mb-0.5">Attention</p>
              <p className="font-mono" style={{ color: health.attention_count > 0 ? '#ef6f8a' : '#32bfa3' }}>
                {health.attention_count}
              </p>
            </div>
          </div>

          <div className="space-y-1.5">
            {topConnections.map((connection) => {
              const connectionTone = connection.needs_attention
                ? '#ef6f8a'
                : connection.is_stale
                  ? '#e2a53f'
                  : '#32bfa3';
              const detail = connection.recommended_action === 'none' && connection.last_synced_at
                ? formatRelativeTime(connection.last_synced_at)
                : connection.status_label;
              const actionLabel = {
                connect: 'Connect',
                sync: 'Sync',
                reconnect: 'Reconnect',
                retry: 'Retry',
                none: '',
              }[connection.recommended_action];
              return (
                <div key={`${connection.provider}:${connection.id}`} className="flex items-center justify-between gap-3 text-xs">
                  <span className="text-text truncate">{connection.institution_name}</span>
                  <span className="flex items-center gap-2 flex-shrink-0">
                    <span className="font-mono" style={{ color: connectionTone }}>
                      {detail}
                    </span>
                    {actionLabel && (
                      <button
                        onClick={() => onNavigate('/accounts')}
                        className="text-muted hover:text-[#32bfa3]"
                      >
                        {actionLabel}
                      </button>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="h-24 flex items-center justify-center text-muted text-sm">
          No connected institutions
        </div>
      )}
    </div>
  );
}

function DashboardFocusPanel({
  mode,
  syncHealth,
  reviewSummary,
  forecast,
  onNavigate,
}: {
  mode: DashboardMode;
  syncHealth?: SyncHealth;
  reviewSummary?: TransactionReviewSummary;
  forecast?: RecurringForecast;
  onNavigate: (route: string) => void;
}) {
  if (mode === 'first_run') {
    const setupSteps = [
      { label: 'Source', active: true },
      { label: 'Sync', active: false },
      { label: 'Review', active: false },
      { label: 'Dashboard', active: false },
    ];

    return (
      <div className="bg-surface border border-border rounded p-5">
        <div className="grid grid-cols-1 xl:grid-cols-[1fr_380px] gap-6">
          <div>
            <div className="flex items-center gap-2 mb-3">
              <CreditCard size={16} className="text-[#32bfa3]" />
              <h2 className="text-base font-medium text-text">Connect your first money source</h2>
            </div>
            <p className="text-sm text-muted max-w-2xl leading-relaxed mb-5">
              Live bank sync gives Mizān the cleanest first dashboard.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-2">
              <button
                onClick={() => onNavigate('/accounts?connect=bank')}
                className="flex items-center justify-center gap-2 rounded border border-[#32bfa3]/35 bg-[#32bfa3]/15 text-[#32bfa3] px-3 py-2.5 text-sm hover:bg-[#32bfa3]/20"
              >
                <CreditCard size={15} /> Bank or card
              </button>
              <button
                onClick={() => onNavigate('/accounts?manual=1')}
                className="flex items-center justify-center gap-2 rounded border border-border text-text px-3 py-2.5 text-sm hover:bg-white/5"
              >
                <Plus size={15} /> Manual account
              </button>
              <button
                onClick={() => onNavigate('/settings?section=coinbase')}
                className="flex items-center justify-center gap-2 rounded border border-border text-text px-3 py-2.5 text-sm hover:bg-white/5"
              >
                <Wallet size={15} /> Coinbase
              </button>
              <button
                onClick={() => onNavigate('/settings?section=data')}
                className="flex items-center justify-center gap-2 rounded border border-border text-text px-3 py-2.5 text-sm hover:bg-white/5"
              >
                <FileInput size={15} /> Import CSV
              </button>
            </div>
          </div>
          <div className="border border-border rounded p-4 bg-background/40">
            <p className="text-xs text-muted mb-3">Setup path</p>
            <div className="grid grid-cols-4 gap-2">
              {setupSteps.map((step, index) => (
                <div key={step.label} className="min-w-0">
                  <div
                    className="h-1.5 rounded-full mb-2"
                    style={{ backgroundColor: step.active ? '#32bfa3' : '#dbe7e2' }}
                  />
                  <p className="text-[11px] text-text truncate">{index + 1}. {step.label}</p>
                </div>
              ))}
            </div>
            <p className="text-xs text-muted leading-relaxed mt-4">
              After the first source syncs, Mizān will route open cleanup into Review Inbox.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const config = {
    sync_repair: {
      icon: AlertTriangle,
      color: '#e2a53f',
      title: 'Sync needs attention',
      detail: syncHealth?.status_detail ?? 'A connected source needs sync review.',
      action: 'Open Accounts',
      route: '/accounts',
    },
    review_backlog: {
      icon: CircleAlert,
      color: '#6487f0',
      title: 'Review Inbox is open',
      detail: `${reviewSummary?.total_open ?? 0} item${(reviewSummary?.total_open ?? 0) === 1 ? '' : 's'} need confirmation before the dashboard is fully trusted.`,
      action: 'Open Review',
      route: '/review',
    },
    forecast_warning: {
      icon: TrendingDown,
      color: '#ef6f8a',
      title: 'Upcoming cash flow is negative',
      detail: `The next 30 days project ${formatCurrency(forecast?.net ?? 0)} after expected income and bills.`,
      action: 'Open Bills',
      route: '/bills',
    },
    clean_overview: {
      icon: CheckCircle2,
      color: '#32bfa3',
      title: 'Review complete',
      detail: 'No open review blockers are affecting the dashboard right now.',
      action: 'Open Reports',
      route: '/reports',
    },
  } satisfies Record<Exclude<DashboardMode, 'first_run'>, {
    icon: LucideIcon;
    color: string;
    title: string;
    detail: string;
    action: string;
    route: string;
  }>;

  const item = config[mode];
  const Icon = item.icon;

  return (
    <div className="bg-surface border border-border rounded px-4 py-3 flex items-center justify-between gap-4">
      <div className="flex items-start gap-3 min-w-0">
        <div
          className="w-8 h-8 rounded flex items-center justify-center flex-shrink-0"
          style={{ backgroundColor: `${item.color}18` }}
        >
          <Icon size={16} style={{ color: item.color }} />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium text-text">{item.title}</p>
          <p className="text-xs text-muted leading-relaxed mt-0.5">{item.detail}</p>
        </div>
      </div>
      <button
        onClick={() => onNavigate(item.route)}
        className="flex items-center gap-1.5 text-xs text-muted hover:text-[#32bfa3] flex-shrink-0"
      >
        {item.action} <ArrowRight size={11} />
      </button>
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

  const { data: reviewSummary } = useQuery({
    queryKey: ['transactions', 'review', 'dashboard'],
    queryFn: transactionsApi.review,
  });

  const { data: accounts = [], isLoading: accountsLoading } = useQuery({
    queryKey: ['accounts', 'dashboard'],
    queryFn: accountsApi.list,
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

  const { data: syncHealth } = useQuery({
    queryKey: ['sync', 'health', 'dashboard'],
    queryFn: () => syncApi.health(),
  });

  const { data: syncRuns } = useQuery<SyncRun[]>({
    queryKey: ['sync', 'history', 'dashboard'],
    queryFn: () => syncApi.history(3),
  });

  const { data: dataQuality } = useQuery({
    queryKey: ['insights', 'quality', 'dashboard'],
    queryFn: () => insightsApi.quality(),
  });

  if (nwLoading || accountsLoading) {
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

  const dashboardMode = getDashboardMode({
    accountCount: accounts.filter((account) => !account.is_hidden).length,
    syncHealth,
    reviewSummary,
    forecast,
    dataQuality,
  });

  if (dashboardMode === 'first_run') {
    return (
      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold text-text">Dashboard</h1>
          <span className="text-sm text-muted font-mono">{formatMonth(currentMonth)}</span>
        </div>
        <DashboardFocusPanel
          mode={dashboardMode}
          syncHealth={syncHealth}
          reviewSummary={reviewSummary}
          forecast={forecast}
          onNavigate={navigate}
        />
        <SyncActivityPanel runs={syncRuns} />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-text">Dashboard</h1>
        <span className="text-sm text-muted font-mono">{formatMonth(currentMonth)}</span>
      </div>

      <DashboardFocusPanel
        mode={dashboardMode}
        syncHealth={syncHealth}
        reviewSummary={reviewSummary}
        forecast={forecast}
        onNavigate={navigate}
      />

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
          className="bg-surface border border-border rounded p-5 cursor-pointer hover:bg-[#32bfa3]/5 transition-colors"
          onClick={() => navigate('/reports')}
        >
          <p className="text-xs text-muted mb-1">Top Category</p>
          {topCategory ? (
            <>
              <p className="text-sm font-medium text-text mb-1">{topCategory.category_name}</p>
              <p className="font-mono text-2xl font-medium text-[#ef6f8a]">{formatCurrency(topCategory.amount)}</p>
            </>
          ) : (
            <p className="text-sm text-muted">No data</p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-4 gap-4">
        <div className="xl:col-span-2">
          <SignalsPanel insights={insights} onNavigate={navigate} />
        </div>
        <DataQualityPanel quality={dataQuality} onNavigate={navigate} />
        <SyncHealthPanel health={syncHealth} onNavigate={navigate} />
      </div>

      <SyncActivityPanel runs={syncRuns} />

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
            <button onClick={() => navigate('/bills')} className="text-xs text-muted hover:text-[#32bfa3] flex items-center gap-1">
              View all <ArrowRight size={11} />
            </button>
          </div>
          {forecast && forecast.occurrences.length > 0 ? (
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-2 text-xs">
                <div>
                  <p className="text-muted mb-0.5">Income</p>
                  <p className="font-mono text-[#32bfa3]">{formatCurrency(forecast.income)}</p>
                </div>
                <div>
                  <p className="text-muted mb-0.5">Bills</p>
                  <p className="font-mono text-[#ef6f8a]">{formatCurrency(-forecast.bills)}</p>
                </div>
                <div>
                  <p className="text-muted mb-0.5">Net</p>
                  <p className="font-mono" style={{ color: forecast.net >= 0 ? '#32bfa3' : '#ef6f8a' }}>
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
                      style={{ color: item.amount >= 0 ? '#32bfa3' : '#ef6f8a' }}
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
            <button onClick={() => navigate('/budget')} className="text-xs text-muted hover:text-[#32bfa3] flex items-center gap-1">
              View all <ArrowRight size={11} />
            </button>
          </div>
          {budgets && budgets.length > 0 ? (
            <div className="space-y-3">
              {budgets.slice(0, 6).map((budget) => {
                const spent = budget.spent ?? 0;
                const projected = budget.projected_spend ?? spent;
                const pct = budget.amount > 0 ? (projected / budget.amount) * 100 : 0;
                const barColor = pct >= 100 ? '#ef6f8a' : pct >= 80 ? '#e2a53f' : '#32bfa3';
                return (
                  <div key={budget.id}>
                    <div className="flex items-center justify-between text-xs mb-1">
                      <span className="text-text">{budget.category_name}</span>
                      <span className="font-mono text-muted">
                        {formatCurrency(projected)} / {formatCurrency(budget.amount)}
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
              <Target size={14} className="text-[#e2a53f]" />
              <h2 className="text-sm font-medium text-text">Goals</h2>
            </div>
            <button onClick={() => navigate('/goals')} className="text-xs text-muted hover:text-[#32bfa3] flex items-center gap-1">
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
            <button onClick={() => navigate('/investments')} className="text-xs text-muted hover:text-[#32bfa3] flex items-center gap-1">
              View all <ArrowRight size={11} />
            </button>
          </div>
          {holdings && holdings.length > 0 ? (
            <>
              <p className="font-mono text-2xl text-[#6487f0] mb-4">{formatCurrency(investmentTotal)}</p>
              <div className="space-y-2">
                {holdings.slice(0, 5).map((h) => {
                  const unrealized = h.cost_basis != null ? h.institution_value - h.cost_basis : null;
                  return (
                    <div key={h.id} className="flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[#6487f0] font-medium">{h.ticker ?? '-'}</span>
                        <span className="text-muted truncate max-w-[120px]">{h.security_name}</span>
                      </div>
                      <div className="text-right">
                        <p className="font-mono text-text">{formatCurrency(h.institution_value)}</p>
                        {unrealized != null && (
                          <p className="font-mono" style={{ color: unrealized >= 0 ? '#32bfa3' : '#ef6f8a' }}>
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
          <button onClick={() => navigate('/transactions')} className="text-xs text-muted hover:text-[#32bfa3] flex items-center gap-1">
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
