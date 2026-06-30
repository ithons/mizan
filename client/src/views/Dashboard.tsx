import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
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
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  CircleAlert,
  CreditCard,
  Eye,
  EyeOff,
  FileInput,
  GripVertical,
  Info,
  Lightbulb,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  RotateCcw,
  Settings2,
  ShieldCheck,
  Sparkles,
  Wallet,
  Target,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { format, startOfMonth, endOfMonth, subMonths, parseISO } from 'date-fns';
import type { DataQualitySummary, Goal, Insight, RecurringForecast, SyncHealth, SyncRun, TransactionReviewSummary } from '@shared/types';
import { accountsApi, networthApi, reportsApi, recurringApi, budgetsApi, transactionsApi, investmentsApi, insightsApi, goalsApi, syncApi, settingsApi } from '../lib/api';
import { getDashboardMode, type DashboardMode } from '../lib/dashboardState';
import { getOnboardingPlan, type OnboardingPlan } from '../lib/onboarding';
import { advisorRouteState } from '../lib/advisorRouteState';
import {
  DASHBOARD_CARD_DEFINITIONS,
  DASHBOARD_LAYOUT_IMPORTED_STORAGE_KEY,
  DASHBOARD_LAYOUT_PREFERENCE_KEY,
  DASHBOARD_LAYOUT_STORAGE_KEY,
  DEFAULT_DASHBOARD_LAYOUT,
  moveDashboardCard,
  normalizeDashboardLayout,
  parseDashboardLayout,
  setDashboardCardHidden,
  setDashboardCardPinned,
  visibleDashboardCardIds,
  type DashboardCardId,
  type DashboardLayoutItem,
} from '../lib/dashboardLayout';
import {
  buildDashboardCardAdvisorPrompt,
  type DashboardCardAdvisorPromptContext,
} from '../lib/advisorPrompts';
import { availableBudgetAmount, budgetProjectedPercent, budgetProjectedSpend } from '../lib/budgetMath';
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

function MorningBriefingPanel({
  safeToSpend,
  totalOpen,
  forecast,
  onNavigate,
}: {
  safeToSpend: number;
  totalOpen: number;
  forecast?: RecurringForecast;
  onNavigate: (route: string) => void;
}) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      <div 
        className="bg-surface shadow-sm border border-border rounded p-5 cursor-pointer hover:bg-black/5 transition-colors"
        onClick={() => onNavigate('/review')}
      >
        <p className="text-xs text-muted mb-1">Inbox Zero</p>
        <p className="font-mono text-3xl font-medium mb-1" style={{ color: totalOpen > 0 ? '#e2a53f' : '#32bfa3' }}>
          {totalOpen}
        </p>
        <p className="text-xs text-muted">items need review</p>
      </div>

      <div 
        className="bg-surface shadow-sm border border-border rounded p-5 cursor-pointer hover:bg-black/5 transition-colors"
        onClick={() => onNavigate('/budget')}
      >
        <p className="text-xs text-muted mb-1">Safe to Spend</p>
        <p className="font-mono text-3xl font-medium mb-1 text-text">
          {formatCurrency(safeToSpend)}
        </p>
        <p className="text-xs text-muted">liquid after bills & budgets</p>
      </div>

      <div 
        className="bg-surface shadow-sm border border-border rounded p-5 cursor-pointer hover:bg-black/5 transition-colors"
        onClick={() => onNavigate('/bills')}
      >
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs text-muted">Radar (next 14d)</p>
          <ArrowRight size={14} className="text-muted" />
        </div>
        {forecast && forecast.occurrences.length > 0 ? (
          <div className="space-y-1.5">
            {forecast.occurrences.slice(0, 3).map((item) => (
              <div key={item.id} className="flex justify-between items-center text-xs">
                <span className="text-text truncate pr-2">{item.merchant_name}</span>
                <span className="font-mono flex-shrink-0" style={{ color: item.amount >= 0 ? '#32bfa3' : '#ef6f8a' }}>
                  {formatCurrency(item.amount)}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted mt-2">No upcoming items</p>
        )}
      </div>
    </div>
  );
}

function StatCard({
  title,
  value,
  delta,
  deltaLabel,
  positive,
  onClick,
  onAsk,
}: {
  title: string;
  value: string;
  delta?: number;
  deltaLabel?: string;
  positive?: boolean;
  onClick?: () => void;
  onAsk?: () => void;
}) {
  const isGood = positive !== undefined ? positive : (delta ?? 0) >= 0;
  const cls = `bg-surface shadow-sm border border-border rounded p-5 ${onClick ? 'cursor-pointer hover:bg-green/5 transition-colors' : ''}`;
  return (
    <div className={cls} onClick={onClick}>
      <div className="flex items-start justify-between gap-2 mb-1">
        <p className="text-xs text-muted">{title}</p>
        {onAsk && (
          <button
            type="button"
            className="text-[11px] text-muted hover:text-green transition-colors flex items-center gap-1"
            title={`Why did ${title} change?`}
            aria-label={`Why did ${title} change?`}
            onClick={(event) => {
              event.stopPropagation();
              onAsk();
            }}
          >
            <Sparkles size={12} />
            Why changed?
          </button>
        )}
      </div>
      <p className="font-mono text-2xl font-medium text-text mb-2">{value}</p>
      {delta !== undefined && (
        <div className="flex items-center gap-1">
          {isGood ? (
            <TrendingUp size={12} className="text-green" />
          ) : (
            <TrendingDown size={12} className="text-rose" />
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
    <div className="bg-surface shadow-sm border border-border rounded px-3 py-2 text-sm">
      <p className="text-text">{payload[0].name}</p>
      <p className="font-mono text-green">{formatCurrency(payload[0].value)}</p>
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
  onAskAdvisor,
}: {
  insights?: Insight[];
  onNavigate: (route: string) => void;
  onAskAdvisor: (prompt: string) => void;
}) {
  const visibleInsights = insights?.slice(0, 4) ?? [];

  return (
    <div className="bg-surface shadow-sm border border-border rounded">
      <div className="px-4 py-3 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Lightbulb size={15} className="text-amber" />
          <h2 className="text-sm font-medium text-text">Signals</h2>
        </div>
        <button
          onClick={() => onAskAdvisor('Give me a financial overview from the dashboard. Explain sync health, review blockers, cash flow, budget risk, goals, and the most important next action.')}
          className="text-xs text-muted hover:text-green flex items-center gap-1"
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
                    className="text-xs text-muted hover:text-green flex items-center gap-1 flex-shrink-0 pt-1"
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
    <div className="bg-surface shadow-sm border border-border rounded p-4">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Icon size={14} style={{ color: tone.color }} />
          <h2 className="text-sm font-medium text-text">Data Quality</h2>
        </div>
        <button onClick={() => onNavigate(primaryRoute)} className="text-xs text-muted hover:text-green flex items-center gap-1">
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
                className="w-full flex items-start gap-2 text-left text-xs hover:bg-black/5 rounded p-1 -m-1"
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
    <div className="bg-surface shadow-sm border border-border rounded p-4">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <RefreshCw size={14} style={{ color: tone.color }} />
          <h2 className="text-sm font-medium text-text">Sync Health</h2>
        </div>
        <button onClick={() => onNavigate('/accounts')} className="text-xs text-muted hover:text-green flex items-center gap-1">
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
                        className="text-muted hover:text-green"
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

function dashboardCardDefinition(cardId: DashboardCardId) {
  const definition = DASHBOARD_CARD_DEFINITIONS.find((card) => card.id === cardId);
  if (!definition) {
    throw new Error(`Unknown dashboard card: ${cardId}`);
  }
  return definition;
}

function DashboardLayoutPanel({
  layout,
  onMove,
  onSetHidden,
  onSetPinned,
  onReset,
}: {
  layout: DashboardLayoutItem[];
  onMove: (cardId: DashboardCardId, direction: 'up' | 'down') => void;
  onSetHidden: (cardId: DashboardCardId, hidden: boolean) => void;
  onSetPinned: (cardId: DashboardCardId, pinned: boolean) => void;
  onReset: () => void;
}) {
  return (
    <div className="bg-surface shadow-sm border border-border rounded p-3">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div>
          <h2 className="text-sm font-medium text-text">Dashboard cards</h2>
          <p className="text-xs text-muted font-mono">{layout.filter((item) => !item.hidden).length} visible</p>
        </div>
        <button
          type="button"
          onClick={onReset}
          className="flex items-center gap-1.5 rounded border border-border px-2.5 py-1.5 text-xs text-muted hover:text-green hover:bg-green/5"
        >
          <RotateCcw size={13} />
          Reset
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-2">
        {layout.map((item, index) => {
          const definition = dashboardCardDefinition(item.id);
          return (
            <div
              key={item.id}
              className={`flex items-center gap-2 rounded border border-border bg-background/40 px-2 py-2 ${item.hidden ? 'opacity-70' : ''}`}
            >
              <GripVertical size={14} className="text-muted flex-shrink-0" />
              <div className="flex flex-col gap-1">
                <button
                  type="button"
                  disabled={index === 0}
                  onClick={() => onMove(item.id, 'up')}
                  className="rounded p-1 text-muted hover:text-green hover:bg-green/5 disabled:opacity-30 disabled:hover:text-muted disabled:hover:bg-transparent"
                  title={`Move ${definition.label} up`}
                  aria-label={`Move ${definition.label} up`}
                >
                  <ChevronUp size={13} />
                </button>
                <button
                  type="button"
                  disabled={index === layout.length - 1}
                  onClick={() => onMove(item.id, 'down')}
                  className="rounded p-1 text-muted hover:text-green hover:bg-green/5 disabled:opacity-30 disabled:hover:text-muted disabled:hover:bg-transparent"
                  title={`Move ${definition.label} down`}
                  aria-label={`Move ${definition.label} down`}
                >
                  <ChevronDown size={13} />
                </button>
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-text truncate">{definition.label}</p>
                <p className="text-xs text-muted truncate">{definition.detail}</p>
              </div>
              <button
                type="button"
                onClick={() => onSetPinned(item.id, !item.pinned)}
                className={`rounded p-1.5 transition-colors ${item.pinned ? 'text-green bg-green/10' : 'text-muted hover:text-green hover:bg-green/5'}`}
                title={item.pinned ? `Unpin ${definition.label}` : `Pin ${definition.label}`}
                aria-label={item.pinned ? `Unpin ${definition.label}` : `Pin ${definition.label}`}
              >
                {item.pinned ? <PinOff size={14} /> : <Pin size={14} />}
              </button>
              <button
                type="button"
                onClick={() => onSetHidden(item.id, !item.hidden)}
                className={`rounded p-1.5 transition-colors ${item.hidden ? 'text-rose bg-rose/10' : 'text-muted hover:text-green hover:bg-green/5'}`}
                title={item.hidden ? `Show ${definition.label}` : `Hide ${definition.label}`}
                aria-label={item.hidden ? `Show ${definition.label}` : `Hide ${definition.label}`}
              >
                {item.hidden ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DashboardFocusPanel({
  mode,
  onboardingPlan,
  syncHealth,
  reviewSummary,
  forecast,
  onNavigate,
}: {
  mode: DashboardMode;
  onboardingPlan?: OnboardingPlan;
  syncHealth?: SyncHealth;
  reviewSummary?: TransactionReviewSummary;
  forecast?: RecurringForecast;
  onNavigate: (route: string) => void;
}) {
  if (mode === 'first_run') {
    const setupSteps = onboardingPlan?.steps ?? [];
    const current = onboardingPlan?.currentStep;

    return (
      <div className="bg-surface shadow-sm border border-border rounded p-5">
        <div className="grid grid-cols-1 xl:grid-cols-[1fr_380px] gap-6">
          <div>
            <div className="flex items-center gap-2 mb-3">
              <CreditCard size={16} className="text-green" />
              <h2 className="text-base font-medium text-text">Connect your first money source</h2>
            </div>
            <p className="text-sm text-muted max-w-2xl leading-relaxed mb-5">
              {current?.detail ?? 'Live bank sync gives Mizān the cleanest first dashboard.'}
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-2">
              <button
                onClick={() => onNavigate('/onboarding')}
                className="flex items-center justify-center gap-2 rounded border border-green/35 bg-green/15 text-green px-3 py-2.5 text-sm hover:bg-green/20"
              >
                <CreditCard size={15} /> Start setup
              </button>
              <button
                onClick={() => onNavigate('/accounts?manual=1')}
                className="flex items-center justify-center gap-2 rounded border border-border text-text px-3 py-2.5 text-sm hover:bg-black/5"
              >
                <Plus size={15} /> Manual account
              </button>
              <button
                onClick={() => onNavigate('/settings?section=coinbase')}
                className="flex items-center justify-center gap-2 rounded border border-border text-text px-3 py-2.5 text-sm hover:bg-black/5"
              >
                <Wallet size={15} /> Coinbase
              </button>
              <button
                onClick={() => onNavigate('/settings?section=data')}
                className="flex items-center justify-center gap-2 rounded border border-border text-text px-3 py-2.5 text-sm hover:bg-black/5"
              >
                <FileInput size={15} /> Import CSV
              </button>
            </div>
          </div>
          <div className="border border-border rounded p-4 bg-background/40">
            <p className="text-xs text-muted mb-3">Setup path</p>
            <div className="grid grid-cols-5 gap-2">
              {setupSteps.map((step, index) => (
                <div key={step.label} className="min-w-0">
                  <div
                    className="h-1.5 rounded-full mb-2"
                    style={{ backgroundColor: step.status === 'complete' ? '#32bfa3' : step.status === 'active' ? '#6487f0' : '#dbe7e2' }}
                  />
                  <p className="text-[11px] text-text truncate">{index + 1}. {step.label}</p>
                </div>
              ))}
            </div>
            <p className="text-xs text-muted leading-relaxed mt-4">
              {onboardingPlan
                ? `${onboardingPlan.completedCount} of ${onboardingPlan.totalCount} steps complete.`
                : 'After the first source syncs, Mizān will route open cleanup into Review Inbox.'}
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
    <div className="bg-surface shadow-sm border border-border rounded px-4 py-3 flex items-center justify-between gap-4">
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
        className="flex items-center gap-1.5 text-xs text-muted hover:text-green flex-shrink-0"
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
  const [isCustomizingDashboard, setIsCustomizingDashboard] = useState(false);
  const [dashboardLayout, setDashboardLayout] = useState<DashboardLayoutItem[]>(DEFAULT_DASHBOARD_LAYOUT);

  const { data: dashboardLayoutPreference, isFetched: dashboardLayoutPreferenceFetched } = useQuery({
    queryKey: ['settings', 'preferences', DASHBOARD_LAYOUT_PREFERENCE_KEY],
    queryFn: () => settingsApi.getPreference<DashboardLayoutItem[]>(DASHBOARD_LAYOUT_PREFERENCE_KEY),
  });

  const saveDashboardLayoutPreference = useMutation({
    mutationFn: (layout: DashboardLayoutItem[]) =>
      settingsApi.setPreference(DASHBOARD_LAYOUT_PREFERENCE_KEY, normalizeDashboardLayout(layout)),
  });

  useEffect(() => {
    if (!dashboardLayoutPreferenceFetched) return;

    if (dashboardLayoutPreference) {
      setDashboardLayout(normalizeDashboardLayout(dashboardLayoutPreference.value));
      return;
    }

    if (typeof window === 'undefined') return;
    if (window.localStorage.getItem(DASHBOARD_LAYOUT_IMPORTED_STORAGE_KEY) === '1') return;

    const imported = parseDashboardLayout(window.localStorage.getItem(DASHBOARD_LAYOUT_STORAGE_KEY));
    setDashboardLayout(imported);
    saveDashboardLayoutPreference.mutate(imported);
    window.localStorage.setItem(DASHBOARD_LAYOUT_IMPORTED_STORAGE_KEY, '1');
  }, [dashboardLayoutPreference, dashboardLayoutPreferenceFetched]);

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

  const { data: credentials } = useQuery({
    queryKey: ['credential-status', 'dashboard'],
    queryFn: () => settingsApi.getCredentials(),
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

  // Safe to Spend Pacing
  const upcomingBills = Math.abs(forecast?.bills ?? 0);
  const allocatedBudgets = (budgets ?? []).reduce((sum, b) => {
    // Only subtract the *remaining* projected amount that hasn't been spent yet
    const projectedRemaining = b.projected_remaining ?? 0;
    return sum + Math.max(0, projectedRemaining);
  }, 0);
  const allocatedGoals = (goals ?? []).reduce((sum, g) => {
    return g.type === 'savings' ? sum + g.current_amount : sum;
  }, 0);
  const safeToSpend = Math.max(0, liquid - upcomingBills - allocatedBudgets - allocatedGoals);

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
  const visibleAccountCount = accounts.filter((account) => !account.is_hidden).length;
  const onboardingPlan = getOnboardingPlan({
    accountCount: visibleAccountCount,
    credentialStatus: credentials,
    syncHealth,
    reviewSummary,
  });
  const askAdvisor = (prompt: string) => {
    navigate('/advisor', {
      state: advisorRouteState({
        source: 'dashboard',
        prompt,
        recordKind: 'dashboard',
      }),
    });
  };
  const askAdvisorAboutDashboardCard = (context: DashboardCardAdvisorPromptContext) => {
    navigate('/advisor', {
      state: advisorRouteState(buildDashboardCardAdvisorPrompt(context)),
    });
  };
  const persistDashboardLayout = (layout: DashboardLayoutItem[]) => {
    const normalized = normalizeDashboardLayout(layout);
    setDashboardLayout(normalized);
    saveDashboardLayoutPreference.mutate(normalized);
  };
  const moveDashboardSection = (cardId: DashboardCardId, direction: 'up' | 'down') => {
    persistDashboardLayout(moveDashboardCard(dashboardLayout, cardId, direction));
  };
  const setDashboardSectionHidden = (cardId: DashboardCardId, hidden: boolean) => {
    persistDashboardLayout(setDashboardCardHidden(dashboardLayout, cardId, hidden));
  };
  const setDashboardSectionPinned = (cardId: DashboardCardId, pinned: boolean) => {
    persistDashboardLayout(setDashboardCardPinned(dashboardLayout, cardId, pinned));
  };
  const resetDashboardLayout = () => {
    persistDashboardLayout(DEFAULT_DASHBOARD_LAYOUT);
  };
  const visibleDashboardCards = visibleDashboardCardIds(dashboardLayout);
  const visibleDashboardCardSet = new Set<DashboardCardId>(visibleDashboardCards);
  const dashboardCardOrder = (cardId: DashboardCardId) => {
    const index = visibleDashboardCards.indexOf(cardId);
    return index < 0 ? 0 : index;
  };

  if (dashboardMode === 'first_run') {
    return (
      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold text-text">Dashboard</h1>
          <span className="text-sm text-muted font-mono">{formatMonth(currentMonth)}</span>
        </div>
        <DashboardFocusPanel
          mode={dashboardMode}
          onboardingPlan={onboardingPlan}
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
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-xl font-semibold text-text">Dashboard</h1>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted font-mono">{formatMonth(currentMonth)}</span>
          <button
            type="button"
            onClick={() => setIsCustomizingDashboard((current) => !current)}
            className={`flex items-center gap-1.5 rounded border px-2.5 py-1.5 text-xs transition-colors ${
              isCustomizingDashboard
                ? 'border-green/35 bg-green/10 text-green'
                : 'border-border text-muted hover:text-green hover:bg-green/5'
            }`}
            aria-expanded={isCustomizingDashboard}
          >
            <Settings2 size={13} />
            Customize
          </button>
        </div>
      </div>

      {isCustomizingDashboard && (
        <DashboardLayoutPanel
          layout={dashboardLayout}
          onMove={moveDashboardSection}
          onSetHidden={setDashboardSectionHidden}
          onSetPinned={setDashboardSectionPinned}
          onReset={resetDashboardLayout}
        />
      )}

      <DashboardFocusPanel
        mode={dashboardMode}
        onboardingPlan={onboardingPlan}
        syncHealth={syncHealth}
        reviewSummary={reviewSummary}
        forecast={forecast}
        onNavigate={navigate}
      />

      {visibleDashboardCards.length === 0 ? (
        <div className="bg-surface shadow-sm border border-border rounded p-6 text-center">
          <p className="text-sm font-medium text-text mb-1">All dashboard cards are hidden</p>
          <p className="text-xs text-muted mb-4">Reset the layout to restore the default overview.</p>
          <button
            type="button"
            onClick={resetDashboardLayout}
            className="inline-flex items-center gap-1.5 rounded border border-border px-3 py-2 text-xs text-muted hover:text-green hover:bg-green/5"
          >
            <RotateCcw size={13} />
            Reset layout
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          {visibleDashboardCardSet.has('morning_briefing') && (
            <div style={{ order: dashboardCardOrder('morning_briefing') }}>
              <MorningBriefingPanel
                safeToSpend={safeToSpend}
                totalOpen={reviewSummary?.total_open ?? 0}
                forecast={forecast}
                onNavigate={navigate}
              />
            </div>
          )}

          {visibleDashboardCardSet.has('overview') && (
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4" style={{ order: dashboardCardOrder('overview') }}>
              <StatCard
                title="Net Worth"
                value={formatCurrency(latestNW?.net_worth ?? 0)}
                delta={nwDelta}
                deltaLabel="vs last month"
                positive={nwDelta !== undefined ? nwDelta >= 0 : undefined}
                onClick={() => navigate('/reports')}
                onAsk={() => askAdvisorAboutDashboardCard({
                  card: 'net_worth',
                  title: 'Net Worth',
                  period: currentMonth,
                  value: latestNW?.net_worth ?? 0,
                  delta: nwDelta ?? null,
                  deltaLabel: 'vs last month',
                })}
              />
              <StatCard
                title="Monthly Spend"
                value={formatCurrency(monthlySpend)}
                delta={spendDelta}
                deltaLabel="vs last month"
                positive={spendDelta !== undefined ? spendDelta <= 0 : undefined}
                onClick={() => navigate('/transactions')}
                onAsk={() => askAdvisorAboutDashboardCard({
                  card: 'monthly_spend',
                  title: 'Monthly Spend',
                  period: currentMonth,
                  value: monthlySpend,
                  delta: spendDelta ?? null,
                  deltaLabel: 'vs last month',
                  extraContext: 'Transfers, investments, crypto, and pending transactions are excluded from reportable spending.',
                })}
              />
              <StatCard
                title="Monthly Income"
                value={formatCurrency(monthlyIncome)}
                delta={incomeDelta}
                deltaLabel="vs last month"
                positive={incomeDelta !== undefined ? incomeDelta >= 0 : undefined}
                onClick={() => navigate('/transactions')}
                onAsk={() => askAdvisorAboutDashboardCard({
                  card: 'monthly_income',
                  title: 'Monthly Income',
                  period: currentMonth,
                  value: monthlyIncome,
                  delta: incomeDelta ?? null,
                  deltaLabel: 'vs last month',
                  extraContext: 'Only reportable income is included. Transfers and investment flows are excluded.',
                })}
              />
              <div
                className="bg-surface shadow-sm border border-border rounded p-5 cursor-pointer hover:bg-green/5 transition-colors"
                onClick={() => navigate('/reports')}
              >
                <div className="flex items-start justify-between gap-2 mb-1">
                  <p className="text-xs text-muted">Top Category</p>
                  <button
                    type="button"
                    className="text-[11px] text-muted hover:text-green transition-colors flex items-center gap-1"
                    title="Why did this top category change?"
                    aria-label="Why did this top category change?"
                    onClick={(event) => {
                      event.stopPropagation();
                      askAdvisorAboutDashboardCard({
                        card: 'top_category',
                        title: 'Top Category',
                        period: currentMonth,
                        value: topCategory?.amount ?? 0,
                        extraContext: topCategory
                          ? `Top spending category is ${topCategory.category_name}.`
                          : 'No categorized spending is available for this period.',
                      });
                    }}
                  >
                    <Sparkles size={12} />
                    Why changed?
                  </button>
                </div>
                {topCategory ? (
                  <>
                    <p className="text-sm font-medium text-text mb-1">{topCategory.category_name}</p>
                    <p className="font-mono text-2xl font-medium text-rose">{formatCurrency(topCategory.amount)}</p>
                  </>
                ) : (
                  <p className="text-sm text-muted">No data</p>
                )}
              </div>
            </div>
          )}

          {visibleDashboardCardSet.has('signals') && (
            <div className="grid grid-cols-1 gap-4" style={{ order: dashboardCardOrder('signals') }}>
              <SignalsPanel insights={insights} onNavigate={navigate} onAskAdvisor={askAdvisor} />
            </div>
          )}

          {visibleDashboardCardSet.has('sync_activity') && (
            <div style={{ order: dashboardCardOrder('sync_activity') }}>
              <SyncActivityPanel runs={syncRuns} />
            </div>
          )}

          {visibleDashboardCardSet.has('asset_breakdown') && (
            <div className="bg-surface shadow-sm border border-border rounded p-4" style={{ order: dashboardCardOrder('asset_breakdown') }}>
              <h2 className="text-sm font-medium text-text mb-4">Asset Breakdown</h2>
              {assetDonutData.length > 0 ? (
                <div className="flex flex-col md:flex-row md:items-center gap-8">
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
          )}

          {visibleDashboardCardSet.has('spending_bills') && (
            <div className="grid grid-cols-1 xl:grid-cols-5 gap-4" style={{ order: dashboardCardOrder('spending_bills') }}>
              <div className="xl:col-span-3 bg-surface shadow-sm border border-border rounded p-4">
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

              <div className="xl:col-span-2 bg-surface shadow-sm border border-border rounded p-4">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-sm font-medium text-text">Next 30 Days</h2>
                  <button onClick={() => navigate('/bills')} className="text-xs text-muted hover:text-green flex items-center gap-1">
                    View all <ArrowRight size={11} />
                  </button>
                </div>
                {forecast && forecast.occurrences.length > 0 ? (
                  <div className="space-y-3">
                    <div className="grid grid-cols-3 gap-2 text-xs">
                      <div>
                        <p className="text-muted mb-0.5">Income</p>
                        <p className="font-mono text-green">{formatCurrency(forecast.income)}</p>
                      </div>
                      <div>
                        <p className="text-muted mb-0.5">Bills</p>
                        <p className="font-mono text-rose">{formatCurrency(-forecast.bills)}</p>
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
          )}

          {visibleDashboardCardSet.has('planning') && (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4" style={{ order: dashboardCardOrder('planning') }}>
              <div className="bg-surface shadow-sm border border-border rounded p-4">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-sm font-medium text-text">Budget Progress</h2>
                  <button onClick={() => navigate('/budget')} className="text-xs text-muted hover:text-green flex items-center gap-1">
                    View all <ArrowRight size={11} />
                  </button>
                </div>
                {budgets && budgets.length > 0 ? (
                  <div className="space-y-3">
                    {budgets.slice(0, 6).map((budget) => {
                      const available = availableBudgetAmount(budget);
                      const projected = budgetProjectedSpend(budget);
                      const pct = budgetProjectedPercent(budget);
                      const velocity = budget.pacing_velocity ?? 0;
                      
                      // Base bar color on velocity if applicable, fallback to pct
                      const barColor = velocity > 1.05 || pct >= 100 
                        ? '#ef6f8a' 
                        : velocity > 0.95 || pct >= 80 
                          ? '#e2a53f' 
                          : '#32bfa3';
                      
                      return (
                        <div key={budget.id}>
                          <div className="flex items-center justify-between text-xs mb-1">
                            <span className="text-text flex items-center gap-1.5">
                              {budget.category_name}
                              {velocity > 1.05 && <span className="text-[10px] text-rose font-medium bg-rose/10 px-1.5 rounded">Running hot</span>}
                              {velocity > 0 && velocity < 0.8 && <span className="text-[10px] text-green font-medium bg-green/10 px-1.5 rounded">On track</span>}
                            </span>
                            <span className="font-mono text-muted">
                              {formatCurrency(budget.spent ?? 0)} / {formatCurrency(available)}
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

              <div className="bg-surface shadow-sm border border-border rounded p-4">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2">
                    <Target size={14} className="text-amber" />
                    <h2 className="text-sm font-medium text-text">Goals</h2>
                  </div>
                  <button onClick={() => navigate('/goals')} className="text-xs text-muted hover:text-green flex items-center gap-1">
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

              <div className="bg-surface shadow-sm border border-border rounded p-4">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-sm font-medium text-text">Investments</h2>
                  <button onClick={() => navigate('/investments')} className="text-xs text-muted hover:text-green flex items-center gap-1">
                    View all <ArrowRight size={11} />
                  </button>
                </div>
                {holdings && holdings.length > 0 ? (
                  <>
                    <p className="font-mono text-2xl text-blue mb-4">{formatCurrency(investmentTotal)}</p>
                    <div className="space-y-2">
                      {holdings.slice(0, 5).map((h) => {
                        const unrealized = h.cost_basis != null ? h.institution_value - h.cost_basis : null;
                        return (
                          <div key={h.id} className="flex items-center justify-between text-xs">
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-blue font-medium">{h.ticker ?? '-'}</span>
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
          )}

          {visibleDashboardCardSet.has('recent_transactions') && (
            <div className="bg-surface shadow-sm border border-border rounded" style={{ order: dashboardCardOrder('recent_transactions') }}>
              <div className="px-4 py-3 border-b border-border flex items-center justify-between">
                <h2 className="text-sm font-medium text-text">Recent Transactions</h2>
                <button onClick={() => navigate('/transactions')} className="text-xs text-muted hover:text-green flex items-center gap-1">
                  View all <ArrowRight size={11} />
                </button>
              </div>
              {recentTxs && recentTxs.data.length > 0 ? (
                <div className="divide-y divide-border">
                  {recentTxs.data.map((tx) => (
                    <div
                      key={tx.id}
                      className="flex flex-col gap-2 px-4 py-2.5 hover:bg-black/5 cursor-pointer sm:flex-row sm:items-center sm:gap-4"
                      onClick={() => navigate('/transactions')}
                    >
                      <span className="font-mono text-xs text-muted sm:w-20 sm:flex-shrink-0">{formatDate(tx.date)}</span>
                      <span className="text-sm text-text flex-1 truncate">{tx.merchant_name || tx.original_name}</span>
                      <span className="text-xs text-muted sm:flex-shrink-0">
                        {tx.category_name ? (
                          <CategoryBadge name={tx.category_name} color={tx.category_color} icon={tx.category_icon} />
                        ) : (
                          <span className="text-muted">Uncategorized</span>
                        )}
                      </span>
                      <AmountBadge amount={tx.amount} className="sm:flex-shrink-0 sm:w-24 sm:text-right" />
                    </div>
                  ))}
                </div>
              ) : (
                <div className="py-12 flex items-center justify-center text-muted text-sm">
                  No transactions this month
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
