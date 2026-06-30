import React, { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  AreaChart,
  Area,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
  Treemap,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Legend,
} from 'recharts';
import { ChevronRight } from 'lucide-react';
import { format, subMonths, startOfMonth, endOfMonth, startOfYear } from 'date-fns';
import { reportsApi, networthApi, investmentsApi, categoriesApi } from '../lib/api';
import { advisorRouteState } from '../lib/advisorRouteState';
import { formatCurrency, formatMonth, formatDate, formatPercent } from '../lib/formatters';
import { PageLoader } from '../components/LoadingSpinner';
import { EmptyState } from '../components/EmptyState';
import { AmountBadge } from '../components/AmountBadge';
import { CategoryBadge } from '../components/CategoryBadge';
import { Modal } from '../components/Modal';
import type {
  Category,
  NetWorthSnapshot,
  ReportComparisonMode,
  ReportDrilldown,
  ReportEvidenceDrilldown,
  ReportExcludedFlowSummary,
  ReportMetricSummary,
  ReportNetWorthEvidence,
  ReportSummary,
} from '@shared/types';
const COLORS = [
  '#32bfa3', '#6487f0', '#e2a53f', '#ef6f8a', '#a78bfa',
  '#f472b6', '#34d399', '#fb923c', '#60a5fa', '#f87171',
];

type DatePreset = 'this_month' | 'last_month' | '3m' | '6m' | '12m' | 'ytd' | 'all' | 'custom';

interface TooltipPayload {
  dataKey: string | number;
  color?: string;
  name?: string;
  value: number;
}

interface ChartTooltipProps {
  active?: boolean;
  payload?: TooltipPayload[];
  label?: string | number;
}

interface TreemapContentProps {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  name?: string;
  color?: string;
  value?: number;
}

interface DrillCategory {
  category_id: string;
  category_name: string;
  color?: string | null;
  amount?: number;
  percentage?: number;
  children?: DrillCategory[];
}

interface SpendingTreemapContentProps extends TreemapContentProps {
  categories?: DrillCategory[];
  onDrill?: (categoryId: string, categoryName: string) => void;
}

interface CategoryOption {
  id: string;
  label: string;
  color?: string | null;
  is_income: boolean;
  is_investment: boolean;
}

interface DrilldownTarget {
  kind: 'spending' | 'income';
  categoryId: string;
  categoryName: string;
}

interface EvidenceTarget {
  kind: 'cashflow_month' | 'excluded_flow';
  label: string;
  month?: string;
  flowType?: ReportExcludedFlowSummary['flow_type'];
}

function getDateRange(preset: DatePreset, customStart?: string, customEnd?: string) {
  const now = new Date();
  switch (preset) {
    case 'this_month':
      return { startDate: format(startOfMonth(now), 'yyyy-MM-dd'), endDate: format(endOfMonth(now), 'yyyy-MM-dd') };
    case 'last_month': {
      const lm = subMonths(now, 1);
      return { startDate: format(startOfMonth(lm), 'yyyy-MM-dd'), endDate: format(endOfMonth(lm), 'yyyy-MM-dd') };
    }
    case '3m':
      return { startDate: format(subMonths(now, 3), 'yyyy-MM-dd'), endDate: format(now, 'yyyy-MM-dd') };
    case '6m':
      return { startDate: format(subMonths(now, 6), 'yyyy-MM-dd'), endDate: format(now, 'yyyy-MM-dd') };
    case '12m':
      return { startDate: format(subMonths(now, 12), 'yyyy-MM-dd'), endDate: format(now, 'yyyy-MM-dd') };
    case 'ytd':
      return { startDate: format(startOfYear(now), 'yyyy-MM-dd'), endDate: format(now, 'yyyy-MM-dd') };
    case 'all':
      return { startDate: '2020-01-01', endDate: format(now, 'yyyy-MM-dd') };
    case 'custom':
      return { startDate: customStart ?? format(subMonths(now, 1), 'yyyy-MM-dd'), endDate: customEnd ?? format(now, 'yyyy-MM-dd') };
  }
}

function ChartTooltip({ active, payload, label }: ChartTooltipProps) {
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

function getTreemapProps(rawProps: unknown): Required<TreemapContentProps> {
  const props = rawProps as TreemapContentProps;
  return {
    x: props.x ?? 0,
    y: props.y ?? 0,
    width: props.width ?? 0,
    height: props.height ?? 0,
    name: props.name ?? '',
    color: props.color ?? '#6b6b7a',
    value: props.value ?? 0,
  };
}

function SpendingTreemapContent({ categories = [], onDrill, ...rawProps }: SpendingTreemapContentProps) {
  const { x, y, width, height, name, color, value } = getTreemapProps(rawProps);
  return (
    <g>
      <rect
        x={x + 1}
        y={y + 1}
        width={Math.max(width - 2, 0)}
        height={Math.max(height - 2, 0)}
        style={{ fill: color, opacity: 0.85, cursor: 'pointer' }}
        onClick={() => {
          const cat = categories.find((c) => c.category_name === name);
          if (cat?.children?.length) onDrill?.(cat.category_id, cat.category_name);
        }}
      />
      {width > 60 && height > 30 && (
        <>
          <text x={x + 8} y={y + 18} fill="#e8e8ec" fontSize={11} fontWeight={500}>{name}</text>
          {height > 50 && (
            <text x={x + 8} y={y + 34} fill="#6b6b7a" fontSize={10} fontFamily="JetBrains Mono">
              {formatCurrency(value)}
            </text>
          )}
        </>
      )}
    </g>
  );
}

function BasicTreemapContent(rawProps: TreemapContentProps) {
  const { x, y, width, height, name, color } = getTreemapProps(rawProps);
  return (
    <g>
      <rect
        x={x + 1}
        y={y + 1}
        width={Math.max(width - 2, 0)}
        height={Math.max(height - 2, 0)}
        style={{ fill: color, opacity: 0.85 }}
      />
      {width > 60 && height > 30 && (
        <text x={x + 8} y={y + 18} fill="#e8e8ec" fontSize={11}>{name}</text>
      )}
    </g>
  );
}

function flattenCategoryOptions(categories: Category[], parentLabel?: string): CategoryOption[] {
  return categories.flatMap((category) => {
    const label = parentLabel ? `${parentLabel} / ${category.name}` : category.name;
    return [
      {
        id: category.id,
        label,
        color: category.color,
        is_income: category.is_income,
        is_investment: category.is_investment,
      },
      ...flattenCategoryOptions(category.children ?? [], label),
    ];
  });
}

function findDrillCategory(categories: DrillCategory[], categoryId: string): DrillCategory | null {
  for (const category of categories) {
    if (category.category_id === categoryId) return category;
    const child = findDrillCategory(category.children ?? [], categoryId);
    if (child) return child;
  }
  return null;
}

function metricColor(metric: ReportMetricSummary, lowerIsBetter = false): string {
  if (metric.delta === 0) return '#6b6b7a';
  const good = lowerIsBetter ? metric.delta < 0 : metric.delta > 0;
  return good ? '#32bfa3' : '#ef6f8a';
}

function formatDelta(metric: ReportMetricSummary, isRate = false): string {
  if (metric.delta === 0) return 'No change';
  const sign = metric.delta > 0 ? '+' : '';
  if (isRate) return `${sign}${metric.delta.toFixed(1)} pp`;
  return `${sign}${formatCurrency(metric.delta)}`;
}

function ReportMetricCard({
  label,
  metric,
  tone,
  isRate,
  lowerIsBetter,
}: {
  label: string;
  metric: ReportMetricSummary;
  tone: string;
  isRate?: boolean;
  lowerIsBetter?: boolean;
}) {
  return (
    <div className="border border-border bg-surface rounded p-4">
      <p className="text-xs text-muted mb-1">{label}</p>
      <p className="font-mono text-xl" style={{ color: tone }}>
        {isRate ? `${metric.current.toFixed(1)}%` : formatCurrency(metric.current)}
      </p>
      <p className="text-xs font-mono mt-2" style={{ color: metricColor(metric, lowerIsBetter) }}>
        {formatDelta(metric, isRate)}
      </p>
    </div>
  );
}

function ReportSummaryPanel({
  summary,
  onAsk,
  onExcludedFlow,
}: {
  summary?: ReportSummary;
  onAsk?: (summary: ReportSummary) => void;
  onExcludedFlow?: (flow: ReportExcludedFlowSummary) => void;
}) {
  if (!summary) return null;

  const topMover = summary.spending_movers[0];
  const comparisonRange = summary.comparison_start_date && summary.comparison_end_date
    ? `${formatDate(summary.comparison_start_date)} to ${formatDate(summary.comparison_end_date)}`
    : 'No comparison range';

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 text-xs text-muted">
        <span>
          Compared with <span className="text-text">{summary.comparison_label}</span>
        </span>
        <div className="flex items-center gap-3">
          <span className="font-mono">{comparisonRange}</span>
          {onAsk && (
            <button
              className="text-muted hover:text-green flex items-center gap-1"
              onClick={() => onAsk(summary)}
            >
              Ask advisor <ChevronRight size={11} />
            </button>
          )}
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <ReportMetricCard label="Income" metric={summary.income} tone="#32bfa3" />
        <ReportMetricCard label="Spending" metric={summary.expenses} tone="#ef6f8a" lowerIsBetter />
        <ReportMetricCard label="Net Cash Flow" metric={summary.net} tone={summary.net.current >= 0 ? '#32bfa3' : '#ef6f8a'} />
        <ReportMetricCard label="Savings Rate" metric={summary.savings_rate} tone="#6487f0" isRate />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-3">
        <div className="border border-border bg-surface rounded p-4">
          <p className="text-xs text-muted mb-2">Top spending mover</p>
          {topMover ? (
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: topMover.color ?? '#6b6b7a' }} />
                <span className="text-sm text-text">{topMover.category_name}</span>
              </div>
              <p className="font-mono text-sm" style={{ color: metricColor(topMover) }}>
                {formatDelta(topMover)}
              </p>
            </div>
          ) : (
            <p className="text-sm text-muted">No movement yet</p>
          )}
        </div>

        <div className="border border-border bg-surface rounded p-4">
          <p className="text-xs text-muted mb-2">Top spending</p>
          <div className="space-y-1.5">
            {summary.top_spending.slice(0, 3).map((category) => (
              <div key={category.category_id} className="flex items-center justify-between gap-3 text-xs">
                <span className="text-text truncate">{category.category_name}</span>
                <span className="font-mono text-rose">{formatCurrency(category.current)}</span>
              </div>
            ))}
            {summary.top_spending.length === 0 && <p className="text-sm text-muted">No spending</p>}
          </div>
        </div>

        <div className="border border-border bg-surface rounded p-4">
          <p className="text-xs text-muted mb-2">Excluded from reports</p>
          <div className="space-y-1.5">
            {summary.excluded_flows.map((flow) => (
              <button
                key={flow.flow_type}
                type="button"
                className="flex w-full items-center justify-between gap-3 rounded px-1.5 py-1 text-left text-xs hover:bg-green/5 focus:outline-none focus:ring-1 focus:ring-green/30"
                onClick={() => onExcludedFlow?.(flow)}
              >
                <span className="text-text capitalize">{flow.flow_type}</span>
                <span className="font-mono text-muted">
                  {flow.count} tx, {formatCurrency(flow.net, { showSign: true })}
                </span>
              </button>
            ))}
            {summary.excluded_flows.length === 0 && <p className="text-sm text-muted">No excluded flows</p>}
          </div>
        </div>
      </div>
    </div>
  );
}

function ReportDrilldownModal({
  target,
  startDate,
  endDate,
  onClose,
}: {
  target: DrilldownTarget | null;
  startDate: string;
  endDate: string;
  onClose: () => void;
}) {
  const { data, isLoading } = useQuery<ReportDrilldown>({
    queryKey: ['reports', 'drilldown', target?.kind, target?.categoryId, startDate, endDate],
    queryFn: () => reportsApi.drilldown({
      kind: target!.kind,
      categoryId: target!.categoryId,
      startDate,
      endDate,
    }),
    enabled: !!target,
  });

  return (
    <Modal
      open={!!target}
      onClose={onClose}
      title={target?.categoryName ?? 'Report Detail'}
      maxWidth="760px"
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs text-muted mb-1">Backed by</p>
            <p className="font-mono text-lg text-text">
              {data ? `${data.count} transaction${data.count === 1 ? '' : 's'}` : 'Loading'}
            </p>
          </div>
          <div className="text-right">
            <p className="text-xs text-muted mb-1">Total</p>
            <p
              className="font-mono text-lg"
              style={{ color: target?.kind === 'income' ? '#32bfa3' : '#ef6f8a' }}
            >
              {data ? formatCurrency(data.total) : '-'}
            </p>
          </div>
        </div>

        <div className="border border-border rounded overflow-hidden max-h-[420px] overflow-y-auto">
          {isLoading ? (
            <div className="py-12 text-center text-sm text-muted">Loading transactions...</div>
          ) : data && data.transactions.length > 0 ? (
            <div className="divide-y divide-border">
              {data.transactions.map((transaction) => (
                <div key={transaction.id} className="grid grid-cols-[88px_1fr_150px_96px] gap-3 items-center px-3 py-2.5">
                  <span className="text-xs text-muted font-mono">{formatDate(transaction.date)}</span>
                  <div className="min-w-0">
                    <p className="text-sm text-text truncate">{transaction.merchant_name || transaction.original_name}</p>
                    <p className="text-xs text-muted truncate">{transaction.account_name}</p>
                  </div>
                  {transaction.category_name ? (
                    <CategoryBadge
                      name={transaction.category_name}
                      color={transaction.category_color}
                      icon={transaction.category_icon}
                    />
                  ) : (
                    <span className="text-xs text-muted">Uncategorized</span>
                  )}
                  <AmountBadge amount={transaction.amount} className="text-right" />
                </div>
              ))}
            </div>
          ) : (
            <div className="py-12 text-center text-sm text-muted">No backing transactions</div>
          )}
        </div>
      </div>
    </Modal>
  );
}

function ReportEvidenceModal({
  target,
  startDate,
  endDate,
  onClose,
}: {
  target: EvidenceTarget | null;
  startDate: string;
  endDate: string;
  onClose: () => void;
}) {
  const { data, isLoading } = useQuery<ReportEvidenceDrilldown>({
    queryKey: ['reports', 'evidence', target?.kind, target?.month, target?.flowType, startDate, endDate],
    queryFn: () => reportsApi.evidence({
      kind: target!.kind,
      month: target?.month,
      flowType: target?.flowType,
      startDate,
      endDate,
    }),
    enabled: !!target,
  });

  return (
    <Modal
      open={!!target}
      onClose={onClose}
      title={target?.label ?? 'Report Evidence'}
      maxWidth="800px"
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
          <div>
            <p className="text-muted mb-1">Backed by</p>
            <p className="font-mono text-lg text-text">
              {data ? `${data.count} transaction${data.count === 1 ? '' : 's'}` : 'Loading'}
            </p>
          </div>
          <div>
            <p className="text-muted mb-1">Income</p>
            <p className="font-mono text-lg text-green">{data ? formatCurrency(data.income) : '-'}</p>
          </div>
          <div>
            <p className="text-muted mb-1">Spending</p>
            <p className="font-mono text-lg text-rose">{data ? formatCurrency(data.expenses) : '-'}</p>
          </div>
          <div>
            <p className="text-muted mb-1">Net</p>
            <p className="font-mono text-lg" style={{ color: (data?.net ?? 0) >= 0 ? '#32bfa3' : '#ef6f8a' }}>
              {data ? formatCurrency(data.net, { showSign: true }) : '-'}
            </p>
          </div>
        </div>

        <div className="border border-border rounded overflow-hidden max-h-[440px] overflow-y-auto">
          {isLoading ? (
            <div className="py-12 text-center text-sm text-muted">Loading evidence...</div>
          ) : data && data.transactions.length > 0 ? (
            <div className="divide-y divide-border">
              {data.transactions.map((transaction) => (
                <div key={transaction.id} className="grid grid-cols-[88px_1fr_150px_96px] gap-3 items-center px-3 py-2.5">
                  <span className="text-xs text-muted font-mono">{formatDate(transaction.date)}</span>
                  <div className="min-w-0">
                    <p className="text-sm text-text truncate">{transaction.merchant_name || transaction.original_name}</p>
                    <p className="text-xs text-muted truncate">{transaction.account_name}</p>
                  </div>
                  {transaction.category_name ? (
                    <CategoryBadge
                      name={transaction.category_name}
                      color={transaction.category_color}
                      icon={transaction.category_icon}
                    />
                  ) : (
                    <span className="text-xs text-muted">Uncategorized</span>
                  )}
                  <AmountBadge amount={transaction.amount} className="text-right" />
                </div>
              ))}
            </div>
          ) : (
            <div className="py-12 text-center text-sm text-muted">No backing transactions</div>
          )}
        </div>
      </div>
    </Modal>
  );
}

function NetWorthEvidenceModal({
  snapshot,
  onClose,
}: {
  snapshot: NetWorthSnapshot | null;
  onClose: () => void;
}) {
  const { data, isLoading } = useQuery<ReportNetWorthEvidence>({
    queryKey: ['reports', 'networth-evidence', snapshot?.id],
    queryFn: () => reportsApi.netWorthEvidence(snapshot!.id),
    enabled: !!snapshot,
  });

  return (
    <Modal
      open={!!snapshot}
      onClose={onClose}
      title={snapshot ? `Net worth on ${formatDate(snapshot.date)}` : 'Net Worth Evidence'}
      maxWidth="820px"
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
          <div>
            <p className="text-muted mb-1">Assets</p>
            <p className="font-mono text-lg text-green">
              {data ? formatCurrency(data.snapshot.total_assets) : '-'}
            </p>
          </div>
          <div>
            <p className="text-muted mb-1">Liabilities</p>
            <p className="font-mono text-lg text-rose">
              {data ? formatCurrency(data.snapshot.total_liabilities) : '-'}
            </p>
          </div>
          <div>
            <p className="text-muted mb-1">Net Worth</p>
            <p className="font-mono text-lg text-text">
              {data ? formatCurrency(data.snapshot.net_worth) : '-'}
            </p>
          </div>
          <div>
            <p className="text-muted mb-1">Change</p>
            <p className="font-mono text-lg" style={{ color: (data?.delta ?? 0) >= 0 ? '#32bfa3' : '#ef6f8a' }}>
              {data?.delta != null ? formatCurrency(data.delta, { showSign: true }) : '-'}
            </p>
          </div>
        </div>

        {data?.previous_snapshot && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs border border-border rounded p-3 bg-background/50">
            <div>
              <p className="text-muted mb-1">Compared with</p>
              <p className="font-mono text-text">{formatDate(data.previous_snapshot.date)}</p>
            </div>
            <div>
              <p className="text-muted mb-1">Asset change</p>
              <p className="font-mono text-text">
                {data.asset_delta != null ? formatCurrency(data.asset_delta, { showSign: true }) : '-'}
              </p>
            </div>
            <div>
              <p className="text-muted mb-1">Liability change</p>
              <p className="font-mono text-text">
                {data.liability_delta != null ? formatCurrency(data.liability_delta, { showSign: true }) : '-'}
              </p>
            </div>
          </div>
        )}

        <div className="border border-border rounded overflow-hidden max-h-[440px] overflow-y-auto">
          {isLoading ? (
            <div className="py-12 text-center text-sm text-muted">Loading snapshot evidence...</div>
          ) : data && data.accounts.length > 0 ? (
            <div className="divide-y divide-border">
              {data.accounts.map((account) => (
                <div
                  key={account.account_id}
                  className="grid grid-cols-[1fr_92px] md:grid-cols-[1fr_130px_130px] gap-3 items-center px-3 py-2.5 text-xs"
                >
                  <div className="min-w-0">
                    <p className="text-sm text-text truncate">{account.account_name ?? account.account_id}</p>
                    <p className="text-xs text-muted truncate">{account.institution_name ?? 'Missing account record'}</p>
                  </div>
                  <span className="hidden md:block text-muted capitalize">{account.type ?? 'unknown'}</span>
                  <span
                    className="font-mono text-right"
                    style={{ color: account.is_liability ? '#ef6f8a' : '#32bfa3' }}
                  >
                    {formatCurrency(account.balance)}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="py-12 text-center text-sm text-muted">No account breakdown stored for this snapshot</div>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ─── Spending Tab ─────────────────────────────────────────────────────────────

function SpendingTab({ startDate, endDate }: { startDate: string; endDate: string }) {
  const navigate = useNavigate();
  const [drillId, setDrillId] = useState<string | null>(null);
  const [drillName, setDrillName] = useState<string | null>(null);
  const [detailTarget, setDetailTarget] = useState<DrilldownTarget | null>(null);

  const { data: spending, isLoading } = useQuery({
    queryKey: ['spending', startDate, endDate],
    queryFn: () => reportsApi.spending({ startDate, endDate }),
  });

  if (isLoading) return <PageLoader />;

  const categories = spending?.categories ?? [];
  const displayCats = drillId
    ? findDrillCategory(categories, drillId)?.children ?? []
    : categories;

  const treemapData = displayCats.map((c, i) => ({
    name: c.category_name,
    size: c.amount,
    color: c.color || COLORS[i % COLORS.length],
  }));

  return (
    <div className="space-y-6">
      {/* Breadcrumb */}
      <div className="flex items-center gap-1 text-xs">
        <button
          className={drillId ? 'text-green hover:opacity-80' : 'text-muted cursor-default'}
          onClick={() => { setDrillId(null); setDrillName(null); }}
        >
          All Categories
        </button>
        {drillId && drillName && (
          <>
            <ChevronRight size={12} className="text-muted" />
            <span className="text-text">{drillName}</span>
          </>
        )}
      </div>

      {treemapData.length > 0 ? (
        <div className="bg-surface shadow-sm border border-border rounded p-4">
          <ResponsiveContainer width="100%" height={280}>
            <Treemap
              data={treemapData}
              dataKey="size"
              aspectRatio={4 / 3}
              content={
                <SpendingTreemapContent
                  categories={displayCats}
                  onDrill={(categoryId, categoryName) => {
                    setDrillId(categoryId);
                    setDrillName(categoryName);
                  }}
                />
              }
            />
          </ResponsiveContainer>
        </div>
      ) : (
        <EmptyState
          icon={ChevronRight}
          title="No spending data for the selected period"
          description="Spending reports populate from categorized expense transactions."
          action={() => navigate('/transactions')}
          actionLabel="Review Transactions"
          secondaryAction={() => navigate('/accounts?connect=bank')}
          secondaryActionLabel="Connect Account"
        />
      )}

      {/* Data table */}
      <div className="bg-surface shadow-sm border border-border rounded overflow-hidden">
        <table className="w-full text-xs">
          <thead className="border-b border-border">
            <tr>
              <th className="text-left px-4 py-2 text-muted font-medium">Category</th>
              <th className="text-right px-4 py-2 text-muted font-medium">Amount</th>
              <th className="text-right px-4 py-2 text-muted font-medium">% of Total</th>
            </tr>
          </thead>
          <tbody>
            {displayCats.map((c, i) => (
              <tr
                key={c.category_id}
                className="border-b border-border hover:bg-black/5 cursor-pointer"
                onClick={() => setDetailTarget({
                  kind: 'spending',
                  categoryId: c.category_id,
                  categoryName: c.category_name,
                })}
              >
                <td className="px-4 py-2">
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: c.color || COLORS[i % COLORS.length] }} />
                    <span className="text-text">{c.category_name}</span>
                  </div>
                </td>
                <td className="px-4 py-2 font-mono text-right text-rose">{formatCurrency(c.amount ?? 0)}</td>
                <td className="px-4 py-2 font-mono text-right text-muted">{formatPercent(c.percentage ?? 0)}</td>
              </tr>
            ))}
          </tbody>
          {spending && (
            <tfoot className="border-t border-border bg-background/30">
              <tr>
                <td className="px-4 py-2 text-sm font-medium text-text">Total</td>
                <td className="px-4 py-2 font-mono text-right text-rose font-medium">{formatCurrency(spending.total)}</td>
                <td />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      <ReportDrilldownModal
        target={detailTarget}
        startDate={startDate}
        endDate={endDate}
        onClose={() => setDetailTarget(null)}
      />
    </div>
  );
}

// ─── Income Tab ───────────────────────────────────────────────────────────────

function IncomeTab({ startDate, endDate }: { startDate: string; endDate: string }) {
  const navigate = useNavigate();
  const [detailTarget, setDetailTarget] = useState<DrilldownTarget | null>(null);
  const { data: income, isLoading } = useQuery({
    queryKey: ['income', startDate, endDate],
    queryFn: () => reportsApi.income({ startDate, endDate }),
  });

  if (isLoading) return <PageLoader />;

  const categories = income?.categories ?? [];
  const treemapData = categories.map((c, i) => ({
    name: c.category_name,
    size: c.amount,
    color: c.color || COLORS[i % COLORS.length],
  }));

  return (
    <div className="space-y-6">
      {treemapData.length > 0 ? (
        <div className="bg-surface shadow-sm border border-border rounded p-4">
          <ResponsiveContainer width="100%" height={280}>
            <Treemap
              data={treemapData}
              dataKey="size"
              content={<BasicTreemapContent />}
            />
          </ResponsiveContainer>
        </div>
      ) : (
        <EmptyState
          icon={ChevronRight}
          title="No income data for the selected period"
          description="Income reports populate from categorized deposits and income transactions."
          action={() => navigate('/transactions')}
          actionLabel="Review Transactions"
          secondaryAction={() => navigate('/accounts?connect=bank')}
          secondaryActionLabel="Connect Account"
        />
      )}
      <div className="bg-surface shadow-sm border border-border rounded overflow-hidden">
        <table className="w-full text-xs">
          <thead className="border-b border-border">
            <tr>
              <th className="text-left px-4 py-2 text-muted font-medium">Category</th>
              <th className="text-right px-4 py-2 text-muted font-medium">Amount</th>
              <th className="text-right px-4 py-2 text-muted font-medium">% of Total</th>
            </tr>
          </thead>
          <tbody>
            {categories.map((c, i) => (
              <tr
                key={c.category_id}
                className="border-b border-border hover:bg-black/5 cursor-pointer"
                onClick={() => setDetailTarget({
                  kind: 'income',
                  categoryId: c.category_id,
                  categoryName: c.category_name,
                })}
              >
                <td className="px-4 py-2">
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: c.color || COLORS[i % COLORS.length] }} />
                    <span className="text-text">{c.category_name}</span>
                  </div>
                </td>
                <td className="px-4 py-2 font-mono text-right text-green">{formatCurrency(c.amount)}</td>
                <td className="px-4 py-2 font-mono text-right text-muted">{formatPercent(c.percentage)}</td>
              </tr>
            ))}
          </tbody>
          {income && (
            <tfoot className="border-t border-border bg-background/30">
              <tr>
                <td className="px-4 py-2 text-sm font-medium text-text">Total</td>
                <td className="px-4 py-2 font-mono text-right text-green font-medium">{formatCurrency(income.total)}</td>
                <td />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      <ReportDrilldownModal
        target={detailTarget}
        startDate={startDate}
        endDate={endDate}
        onClose={() => setDetailTarget(null)}
      />
    </div>
  );
}

// ─── Trends Tab ───────────────────────────────────────────────────────────────

function TrendsTab({
  startDate,
  endDate,
  initialCategoryIds,
}: {
  startDate: string;
  endDate: string;
  initialCategoryIds: string[];
}) {
  const { data: categories = [] } = useQuery({
    queryKey: ['categories'],
    queryFn: categoriesApi.list,
  });

  const initialCategoryKey = initialCategoryIds.join('|');
  const [selectedCats, setSelectedCats] = useState<string[]>(initialCategoryIds);

  useEffect(() => {
    setSelectedCats(initialCategoryIds);
  }, [initialCategoryKey]);

  const { data: trends, isLoading } = useQuery({
    queryKey: ['trends', startDate, endDate, selectedCats],
    queryFn: () => reportsApi.trends({ startDate, endDate, categoryIds: selectedCats }),
    enabled: selectedCats.length > 0,
  });

  const toggleCat = (id: string) => {
    setSelectedCats((prev) =>
      prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]
    );
  };

  const chartData = trends
    ? trends.months.map((month, i) => ({
        month: format(new Date(`${month}-01`), 'MMM yy'),
        ...Object.fromEntries(
          trends.series.map((s) => [s.category_id, s.values[i] ?? 0])
        ),
      }))
    : [];

  const expenseCategories = flattenCategoryOptions(categories)
    .filter((c) => !c.is_income && !c.is_investment);
  const categoryLabels = new Map(expenseCategories.map((category) => [category.id, category.label]));

  return (
    <div className="space-y-6">
      {/* Category toggles */}
      <div className="flex flex-wrap gap-2">
        {expenseCategories.map((cat, i) => {
          const isSelected = selectedCats.includes(cat.id);
          const color = cat.color || COLORS[i % COLORS.length];
          return (
            <button
              key={cat.id}
              onClick={() => toggleCat(cat.id)}
              className="flex items-center gap-1.5 px-3 py-1 rounded text-xs border transition-all"
              style={{
                borderColor: isSelected ? color : '#dbe7e2',
                backgroundColor: isSelected ? `${color}15` : 'transparent',
                color: isSelected ? color : '#6b6b7a',
              }}
            >
              <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: color }} />
              {cat.label}
            </button>
          );
        })}
      </div>

      {selectedCats.length === 0 ? (
        <div className="bg-surface shadow-sm border border-border rounded p-12 text-center text-muted text-sm">
          Select categories above to see spending trends
        </div>
      ) : isLoading ? (
        <PageLoader />
      ) : (
        <div className="bg-surface shadow-sm border border-border rounded p-4">
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={chartData}>
              <CartesianGrid vertical={false} stroke="#dbe7e2" />
              <XAxis dataKey="month" tick={{ fill: '#6b6b7a', fontSize: 11, fontFamily: 'JetBrains Mono' }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: '#6b6b7a', fontSize: 11, fontFamily: 'JetBrains Mono' }} axisLine={false} tickLine={false} tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} />
              <Tooltip content={<ChartTooltip />} />
              <Legend wrapperStyle={{ fontSize: 11, color: '#6b6b7a' }} />
              {trends?.series.map((s, i) => (
                <Line
                  key={s.category_id}
                  dataKey={s.category_id}
                  name={categoryLabels.get(s.category_id) ?? s.category_name}
                  stroke={s.color || COLORS[i % COLORS.length]}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 3 }}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

// ─── Cash Flow Tab ───────────────────────────────────────────────────────────

function CashflowTab({ startDate, endDate }: { startDate: string; endDate: string }) {
  const [evidenceTarget, setEvidenceTarget] = useState<EvidenceTarget | null>(null);
  const { data: cashflow, isLoading } = useQuery({
    queryKey: ['cashflow', 'reports', startDate, endDate],
    queryFn: () => reportsApi.cashflow({ startDate, endDate }),
  });

  if (isLoading) return <PageLoader />;

  const months = cashflow?.months ?? [];
  const totals = months.reduce(
    (sum, month) => ({
      income: sum.income + month.income,
      expenses: sum.expenses + month.expenses,
      net: sum.net + month.net,
    }),
    { income: 0, expenses: 0, net: 0 }
  );
  const chartData = months.map((month) => ({
    month: format(new Date(`${month.month}-01`), 'MMM yy'),
    income: month.income,
    expenses: month.expenses,
    net: month.net,
  }));

  if (months.length === 0) {
    return (
      <EmptyState
        icon={ChevronRight}
        title="No cash flow for the selected period"
        description="Cash-flow reports populate from posted income and spending after report exclusions."
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <ReportMetricCard
          label="Income"
          metric={{ current: totals.income, previous: 0, delta: totals.income, delta_percent: null }}
          tone="#32bfa3"
        />
        <ReportMetricCard
          label="Spending"
          metric={{ current: totals.expenses, previous: 0, delta: totals.expenses, delta_percent: null }}
          tone="#ef6f8a"
          lowerIsBetter
        />
        <ReportMetricCard
          label="Net"
          metric={{ current: totals.net, previous: 0, delta: totals.net, delta_percent: null }}
          tone={totals.net >= 0 ? '#32bfa3' : '#ef6f8a'}
        />
      </div>

      <div className="bg-surface shadow-sm border border-border rounded p-4">
        <ResponsiveContainer width="100%" height={260}>
          <AreaChart data={chartData}>
            <defs>
              <linearGradient id="cashIncomeGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#32bfa3" stopOpacity={0.2} />
                <stop offset="95%" stopColor="#32bfa3" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="cashExpenseGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#ef6f8a" stopOpacity={0.18} />
                <stop offset="95%" stopColor="#ef6f8a" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} stroke="#dbe7e2" />
            <XAxis dataKey="month" tick={{ fill: '#6b6b7a', fontSize: 11, fontFamily: 'JetBrains Mono' }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fill: '#6b6b7a', fontSize: 11, fontFamily: 'JetBrains Mono' }} axisLine={false} tickLine={false} tickFormatter={(v) => `$${(Number(v) / 1000).toFixed(0)}k`} />
            <Tooltip content={<ChartTooltip />} />
            <Area type="monotone" dataKey="income" name="Income" stroke="#32bfa3" fill="url(#cashIncomeGrad)" strokeWidth={2} dot={false} />
            <Area type="monotone" dataKey="expenses" name="Spending" stroke="#ef6f8a" fill="url(#cashExpenseGrad)" strokeWidth={2} dot={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <div className="bg-surface shadow-sm border border-border rounded overflow-hidden">
        <table className="w-full text-xs">
          <thead className="border-b border-border">
            <tr>
              {['Month', 'Income', 'Spending', 'Net'].map((header) => (
                <th key={header} className="text-left px-4 py-2 text-muted font-medium">{header}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {months.map((month) => (
              <tr
                key={month.month}
                className="border-b border-border hover:bg-green/5 cursor-pointer focus:bg-green/5 focus:outline-none focus:ring-1 focus:ring-green/30"
                tabIndex={0}
                role="button"
                onClick={() => setEvidenceTarget({
                  kind: 'cashflow_month',
                  label: `Cash flow for ${formatMonth(month.month)}`,
                  month: month.month,
                })}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    setEvidenceTarget({
                      kind: 'cashflow_month',
                      label: `Cash flow for ${formatMonth(month.month)}`,
                      month: month.month,
                    });
                  }
                }}
              >
                <td className="px-4 py-2 font-mono text-muted">{formatMonth(month.month)}</td>
                <td className="px-4 py-2 font-mono text-green">{formatCurrency(month.income)}</td>
                <td className="px-4 py-2 font-mono text-rose">{formatCurrency(month.expenses)}</td>
                <td className="px-4 py-2 font-mono" style={{ color: month.net >= 0 ? '#32bfa3' : '#ef6f8a' }}>
                  {formatCurrency(month.net, { showSign: true })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ReportEvidenceModal
        target={evidenceTarget}
        startDate={startDate}
        endDate={endDate}
        onClose={() => setEvidenceTarget(null)}
      />
    </div>
  );
}

// ─── Net Worth Tab ────────────────────────────────────────────────────────────

const PIE_COLORS = { liquid: '#32bfa3', investments: '#6487f0', crypto: '#e2a53f', liabilities: '#ef6f8a' };

function AssetPieChart({ data, title }: { data: Array<{ name: string; value: number; color: string }>; title: string }) {
  return (
    <div className="flex-1 bg-surface shadow-sm border border-border rounded p-4">
      <p className="text-xs text-muted font-medium uppercase tracking-wider mb-3">{title}</p>
      <ResponsiveContainer width="100%" height={160}>
        <PieChart>
          <Pie data={data} cx="50%" cy="50%" innerRadius={45} outerRadius={70} dataKey="value" paddingAngle={2}>
            {data.map((entry, i) => <Cell key={i} fill={entry.color} />)}
          </Pie>
          <Tooltip formatter={(v: number) => formatCurrency(v)} />
        </PieChart>
      </ResponsiveContainer>
      <div className="flex flex-col gap-1 mt-2">
        {data.map((entry) => {
          const total = data.reduce((s, d) => s + d.value, 0);
          const pct = total > 0 ? ((entry.value / total) * 100).toFixed(0) : '0';
          return (
            <div key={entry.name} className="flex items-center justify-between text-xs">
              <div className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: entry.color }} />
                <span className="text-muted capitalize">{entry.name}</span>
              </div>
              <span className="font-mono text-text">{formatCurrency(entry.value)} <span className="text-muted">({pct}%)</span></span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function NetWorthTab() {
  const [showAssets, setShowAssets] = useState(true);
  const [showLiabilities, setShowLiabilities] = useState(true);
  const [evidenceSnapshot, setEvidenceSnapshot] = useState<NetWorthSnapshot | null>(null);

  const { data: snapshots = [], isLoading } = useQuery({
    queryKey: ['networth', 'history', 24],
    queryFn: () => networthApi.history(24),
  });

  const { data: latestSnapshot } = useQuery({
    queryKey: ['networth', 'snapshot'],
    queryFn: () => networthApi.snapshot(),
  });

  if (isLoading) return <PageLoader />;

  // Asset breakdown pie data
  const liquid = latestSnapshot?.liquid_assets ?? 0;
  const investments = latestSnapshot?.investment_assets ?? 0;
  const crypto = latestSnapshot?.crypto_assets ?? 0;
  const liabilities = latestSnapshot?.total_liabilities ?? 0;
  const hasAssetBreakdown = liquid > 0 || investments > 0 || crypto > 0;

  const grossPieData = [
    { name: 'Liquid', value: liquid, color: PIE_COLORS.liquid },
    { name: 'Investments', value: investments, color: PIE_COLORS.investments },
    { name: 'Crypto', value: crypto, color: PIE_COLORS.crypto },
  ].filter((d) => d.value > 0);

  // Net-of-debt: subtract liabilities from liquid first
  const liquidAfterDebt = Math.max(0, liquid - liabilities);
  const netPieData = [
    { name: 'Liquid (after debt)', value: liquidAfterDebt, color: PIE_COLORS.liquid },
    { name: 'Investments', value: investments, color: PIE_COLORS.investments },
    { name: 'Crypto', value: crypto, color: PIE_COLORS.crypto },
  ].filter((d) => d.value > 0);

  const chartData = snapshots.map((s) => ({
    date: format(new Date(s.date), 'MMM yy'),
    assets: s.total_assets,
    liabilities: s.total_liabilities,
    netWorth: s.net_worth,
  }));

  return (
    <div className="space-y-6">
      {/* Asset breakdown pie charts */}
      {hasAssetBreakdown && (
        <div className="flex gap-4">
          <AssetPieChart data={grossPieData} title="Gross Assets" />
          <AssetPieChart data={netPieData} title="Net Assets (after debt)" />
        </div>
      )}

      {/* Toggles */}
      <div className="flex gap-2">
        {[
          { key: 'assets', label: 'Assets', color: '#32bfa3', val: showAssets, set: setShowAssets },
          { key: 'liabilities', label: 'Liabilities', color: '#ef6f8a', val: showLiabilities, set: setShowLiabilities },
        ].map((t) => (
          <button
            key={t.key}
            onClick={() => t.set(!t.val)}
            className="flex items-center gap-1.5 px-3 py-1 rounded text-xs border transition-all"
            style={{
              borderColor: t.val ? t.color : '#dbe7e2',
              backgroundColor: t.val ? `${t.color}15` : 'transparent',
              color: t.val ? t.color : '#6b6b7a',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Area chart */}
      <div className="bg-surface shadow-sm border border-border rounded p-4">
        <ResponsiveContainer width="100%" height={240}>
          <AreaChart data={chartData}>
            <defs>
              <linearGradient id="assetsGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#32bfa3" stopOpacity={0.2} />
                <stop offset="95%" stopColor="#32bfa3" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="liabGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#ef6f8a" stopOpacity={0.2} />
                <stop offset="95%" stopColor="#ef6f8a" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="nwGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#6487f0" stopOpacity={0.2} />
                <stop offset="95%" stopColor="#6487f0" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} stroke="#dbe7e2" />
            <XAxis dataKey="date" tick={{ fill: '#6b6b7a', fontSize: 11, fontFamily: 'JetBrains Mono' }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fill: '#6b6b7a', fontSize: 11, fontFamily: 'JetBrains Mono' }} axisLine={false} tickLine={false} tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} />
            <Tooltip content={<ChartTooltip />} />
            {showAssets && (
              <Area type="monotone" dataKey="assets" name="Assets" stroke="#32bfa3" fill="url(#assetsGrad)" strokeWidth={2} dot={false} />
            )}
            {showLiabilities && (
              <Area type="monotone" dataKey="liabilities" name="Liabilities" stroke="#ef6f8a" fill="url(#liabGrad)" strokeWidth={2} dot={false} />
            )}
            <Area type="monotone" dataKey="netWorth" name="Net Worth" stroke="#6487f0" fill="url(#nwGrad)" strokeWidth={2} dot={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Monthly table */}
      <div className="bg-surface shadow-sm border border-border rounded overflow-hidden">
        <table className="w-full text-xs">
          <thead className="border-b border-border">
            <tr>
              {['Date', 'Assets', 'Liabilities', 'Net Worth', 'Delta'].map((h) => (
                <th key={h} className="text-left px-4 py-2 text-muted font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[...snapshots].reverse().map((s, i, arr) => {
              const prev = arr[i + 1];
              const delta = prev ? s.net_worth - prev.net_worth : null;
              return (
                <tr
                  key={s.id}
                  className="border-b border-border hover:bg-green/5 cursor-pointer focus:bg-green/5 focus:outline-none focus:ring-1 focus:ring-green/30"
                  tabIndex={0}
                  role="button"
                  onClick={() => setEvidenceSnapshot(s)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      setEvidenceSnapshot(s);
                    }
                  }}
                >
                  <td className="px-4 py-2 font-mono text-muted">{formatDate(s.date)}</td>
                  <td className="px-4 py-2 font-mono text-green">{formatCurrency(s.total_assets)}</td>
                  <td className="px-4 py-2 font-mono text-rose">{formatCurrency(s.total_liabilities)}</td>
                  <td className="px-4 py-2 font-mono text-text">{formatCurrency(s.net_worth)}</td>
                  <td className="px-4 py-2 font-mono" style={{ color: delta != null ? (delta >= 0 ? '#32bfa3' : '#ef6f8a') : '#6b6b7a' }}>
                    {delta != null ? `${delta >= 0 ? '+' : ''}${formatCurrency(delta)}` : '-'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {snapshots.length === 0 && (
          <div className="py-10 text-center text-muted text-sm">No net worth history available</div>
        )}
      </div>
      <NetWorthEvidenceModal
        snapshot={evidenceSnapshot}
        onClose={() => setEvidenceSnapshot(null)}
      />
    </div>
  );
}

// ─── Investments Tab ──────────────────────────────────────────────────────────

function InvestmentsTab() {
  const navigate = useNavigate();
  const { data: holdings = [], isLoading } = useQuery({
    queryKey: ['holdings'],
    queryFn: investmentsApi.holdings,
  });

  const { data: invReport } = useQuery({
    queryKey: ['inv-report'],
    queryFn: () => reportsApi.investments(),
  });

  if (isLoading) return <PageLoader />;

  const totalValue = holdings.reduce((sum, h) => sum + h.institution_value, 0);

  // Pie by security type
  const byType: Record<string, number> = {};
  holdings.forEach((h) => {
    const t = h.security_type ?? 'other';
    byType[t] = (byType[t] ?? 0) + h.institution_value;
  });
  const pieData = Object.entries(byType).map(([name, value], i) => ({
    name,
    value,
    color: COLORS[i % COLORS.length],
  }));

  // Portfolio history
  const historyData = (invReport?.history ?? []).map((h) => ({
    date: format(new Date(h.date), 'MMM yy'),
    value: h.value,
  }));

  if (holdings.length === 0) {
    return (
      <EmptyState
        icon={ChevronRight}
        title="No investment accounts connected"
        description="Connect a brokerage account or configure Coinbase before investment reports can be calculated."
        action={() => navigate('/accounts?connect=bank')}
        actionLabel="Connect Account"
        secondaryAction={() => navigate('/settings?section=coinbase')}
        secondaryActionLabel="Configure Coinbase"
      />
    );
  }

  return (
    <div className="space-y-6">
      {/* Summary + Pie */}
      <div className="grid grid-cols-2 gap-4">
        {/* Portfolio history */}
        <div className="bg-surface shadow-sm border border-border rounded p-4">
          <p className="text-xs text-muted mb-1">Portfolio Value</p>
          <p className="font-mono text-2xl text-blue mb-3">{formatCurrency(totalValue)}</p>
          {historyData.length > 0 && (
            <ResponsiveContainer width="100%" height={120}>
              <AreaChart data={historyData}>
                <defs>
                  <linearGradient id="invGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#6487f0" stopOpacity={0.2} />
                    <stop offset="95%" stopColor="#6487f0" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <Area type="monotone" dataKey="value" stroke="#6487f0" fill="url(#invGrad)" strokeWidth={2} dot={false} />
                <XAxis dataKey="date" hide />
                <YAxis hide />
                <Tooltip content={<ChartTooltip />} />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Allocation pie */}
        <div className="bg-surface shadow-sm border border-border rounded p-4">
          <p className="text-sm font-medium text-text mb-3">Allocation</p>
          {pieData.length > 0 ? (
            <ResponsiveContainer width="100%" height={160}>
              <PieChart>
                <Pie data={pieData} cx="50%" cy="50%" outerRadius={65} dataKey="value" paddingAngle={2}>
                  {pieData.map((entry, i) => (
                    <Cell key={i} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip formatter={(v: number) => formatCurrency(v)} />
                <Legend
                  formatter={(value) => <span className="text-xs text-text">{value}</span>}
                />
              </PieChart>
            </ResponsiveContainer>
          ) : null}
        </div>
      </div>

      {/* P&L table */}
      <div className="bg-surface shadow-sm border border-border rounded overflow-hidden">
        <table className="w-full text-xs">
          <thead className="border-b border-border">
            <tr>
              {['Ticker', 'Name', 'Quantity', 'Current Price', 'Value', 'Cost Basis', 'Unrealized P&L', 'P&L %'].map((h) => (
                <th key={h} className="text-left px-4 py-2 text-muted font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {holdings.map((h) => {
              const unrealized = h.cost_basis != null ? h.institution_value - h.cost_basis : null;
              const pnlPct = h.cost_basis && h.cost_basis > 0 ? ((h.institution_value - h.cost_basis) / h.cost_basis) * 100 : null;
              return (
                <tr key={h.id} className="border-b border-border hover:bg-black/5">
                  <td className="px-4 py-2 font-mono text-blue font-medium">{h.ticker ?? '-'}</td>
                  <td className="px-4 py-2 text-text max-w-[160px] truncate">{h.security_name}</td>
                  <td className="px-4 py-2 font-mono text-muted">{h.quantity.toFixed(4)}</td>
                  <td className="px-4 py-2 font-mono text-muted">{formatCurrency(h.institution_price)}</td>
                  <td className="px-4 py-2 font-mono text-text">{formatCurrency(h.institution_value)}</td>
                  <td className="px-4 py-2 font-mono text-muted">{h.cost_basis != null ? formatCurrency(h.cost_basis) : '-'}</td>
                  <td className="px-4 py-2 font-mono" style={{ color: unrealized != null ? (unrealized >= 0 ? '#32bfa3' : '#ef6f8a') : '#6b6b7a' }}>
                    {unrealized != null ? `${unrealized >= 0 ? '+' : ''}${formatCurrency(unrealized)}` : '-'}
                  </td>
                  <td className="px-4 py-2 font-mono" style={{ color: pnlPct != null ? (pnlPct >= 0 ? '#32bfa3' : '#ef6f8a') : '#6b6b7a' }}>
                    {pnlPct != null ? `${pnlPct >= 0 ? '+' : ''}${formatPercent(pnlPct)}` : '-'}
                  </td>
                </tr>
              );
            })}
          </tbody>
          {(() => {
            const totalV = holdings.reduce((s, h) => s + h.institution_value, 0);
            const totalPnl = holdings.reduce((s, h) => h.cost_basis != null ? s + h.institution_value - h.cost_basis : s, 0);
            const hasCB = holdings.some((h) => h.cost_basis != null);
            const totalCB = holdings.reduce((s, h) => s + (h.cost_basis ?? 0), 0);
            const totalPct = hasCB && totalCB > 0 ? ((totalV - totalCB) / totalCB) * 100 : null;
            return (
              <tfoot className="border-t-2 border-border">
                <tr>
                  <td className="px-4 py-2 font-bold text-text" colSpan={5}>TOTAL</td>
                  <td className="px-4 py-2 font-mono font-bold text-muted">{hasCB ? formatCurrency(totalCB) : '-'}</td>
                  <td className="px-4 py-2 font-mono font-bold" style={{ color: hasCB ? (totalPnl >= 0 ? '#32bfa3' : '#ef6f8a') : '#6b6b7a' }}>
                    {hasCB ? `${totalPnl >= 0 ? '+' : ''}${formatCurrency(totalPnl)}` : '-'}
                  </td>
                  <td className="px-4 py-2 font-mono font-bold" style={{ color: totalPct != null ? (totalPct >= 0 ? '#32bfa3' : '#ef6f8a') : '#6b6b7a' }}>
                    {totalPct != null ? `${totalPct >= 0 ? '+' : ''}${formatPercent(totalPct)}` : '-'}
                  </td>
                </tr>
              </tfoot>
            );
          })()}
        </table>
      </div>
    </div>
  );
}

// ─── Main Reports View ────────────────────────────────────────────────────────

const PRESETS: { key: DatePreset; label: string }[] = [
  { key: 'this_month', label: 'This Month' },
  { key: 'last_month', label: 'Last Month' },
  { key: '3m', label: '3M' },
  { key: '6m', label: '6M' },
  { key: '12m', label: '12M' },
  { key: 'ytd', label: 'YTD' },
  { key: 'all', label: 'All Time' },
  { key: 'custom', label: 'Custom' },
];

type ReportTab = 'spending' | 'income' | 'trends' | 'cashflow' | 'networth' | 'investments';

const COMPARISON_OPTIONS: { key: ReportComparisonMode; label: string }[] = [
  { key: 'prior_period', label: 'Prior Period' },
  { key: 'prior_month', label: 'Prior Month' },
  { key: 'same_month_last_year', label: 'Last Year' },
  { key: 'trailing_3', label: 'Trailing 3M' },
  { key: 'trailing_12', label: 'Trailing 12M' },
];

type ReportViewPresetId =
  | 'monthly_spending'
  | 'food_trend'
  | 'income_stability'
  | 'subscription_total'
  | 'net_worth_change'
  | 'cash_flow_after_transfers'
  | 'investment_activity';

interface ReportViewPreset {
  id: ReportViewPresetId;
  label: string;
  tab: ReportTab;
  datePreset: DatePreset;
  comparison: ReportComparisonMode;
  categoryIds?: string[];
}

const REPORT_VIEW_PRESETS: ReportViewPreset[] = [
  {
    id: 'monthly_spending',
    label: 'Monthly Spending',
    tab: 'spending',
    datePreset: 'this_month',
    comparison: 'prior_month',
  },
  {
    id: 'food_trend',
    label: 'Food Trend',
    tab: 'trends',
    datePreset: '12m',
    comparison: 'same_month_last_year',
    categoryIds: ['cat_food'],
  },
  {
    id: 'income_stability',
    label: 'Income Stability',
    tab: 'income',
    datePreset: '6m',
    comparison: 'trailing_3',
  },
  {
    id: 'subscription_total',
    label: 'Subscription Total',
    tab: 'spending',
    datePreset: 'this_month',
    comparison: 'prior_month',
  },
  {
    id: 'net_worth_change',
    label: 'Net Worth Change',
    tab: 'networth',
    datePreset: '12m',
    comparison: 'trailing_12',
  },
  {
    id: 'cash_flow_after_transfers',
    label: 'Cash Flow After Transfers',
    tab: 'cashflow',
    datePreset: '6m',
    comparison: 'trailing_3',
  },
  {
    id: 'investment_activity',
    label: 'Investment Activity',
    tab: 'investments',
    datePreset: '12m',
    comparison: 'trailing_12',
  },
];

export function Reports() {
  const navigate = useNavigate();
  const [preset, setPreset] = useState<DatePreset>('this_month');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [tab, setTab] = useState<ReportTab>('spending');
  const [comparison, setComparison] = useState<ReportComparisonMode>('prior_period');
  const [trendCategoryIds, setTrendCategoryIds] = useState<string[]>([]);
  const [evidenceTarget, setEvidenceTarget] = useState<EvidenceTarget | null>(null);

  const { startDate, endDate } = getDateRange(preset, customStart, customEnd);
  const { data: summary } = useQuery({
    queryKey: ['reports', 'summary', startDate, endDate, comparison],
    queryFn: () => reportsApi.summary({ startDate, endDate, comparison }),
  });

  const applyReportView = (view: ReportViewPreset) => {
    setPreset(view.datePreset);
    setComparison(view.comparison);
    setTab(view.tab);
    setTrendCategoryIds(view.categoryIds ?? []);
  };
  const askAdvisorAboutReport = (report: ReportSummary) => {
    navigate('/advisor', {
      state: advisorRouteState({
        source: 'reports',
        prompt: `Explain this ${tab === 'cashflow' ? 'cash-flow' : tab} report from ${report.start_date ?? startDate} to ${report.end_date ?? endDate}. Focus on income, spending, net cash flow, excluded flows, and what changed versus ${report.comparison_label}.`,
        recordKind: 'report_summary',
        recordId: `${report.start_date ?? startDate}:${report.end_date ?? endDate}`,
        params: {
          tab,
          startDate: report.start_date ?? startDate,
          endDate: report.end_date ?? endDate,
          comparison: report.comparison,
        },
      }),
    });
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-text">Reports</h1>
      </div>

      <div className="space-y-2">
        <p className="text-xs text-muted">Saved views</p>
        <div className="flex items-center gap-2 flex-wrap">
          {REPORT_VIEW_PRESETS.map((view) => (
            <button
              key={view.id}
              onClick={() => applyReportView(view)}
              className="px-3 py-1.5 text-xs rounded border border-border text-muted hover:text-text hover:bg-green/5"
            >
              {view.label}
            </button>
          ))}
        </div>
      </div>

      {/* Date range picker */}
      <div className="flex items-start gap-6 flex-wrap">
        <div className="space-y-2">
          <p className="text-xs text-muted">Period</p>
          <div className="flex items-center gap-2 flex-wrap">
            {PRESETS.map((p) => (
              <button
                key={p.key}
                onClick={() => setPreset(p.key)}
                className={`px-3 py-1.5 text-xs rounded border transition-all ${
                  preset === p.key
                    ? 'bg-green-10 text-green border-green/40'
                    : 'text-muted border-border hover:text-text'
                }`}
              >
                {p.label}
              </button>
            ))}
            {preset === 'custom' && (
              <div className="flex items-center gap-2">
                <input
                  type="date"
                  className="bg-background border border-border rounded px-2 py-1 text-xs text-text font-mono focus:outline-none"
                  value={customStart}
                  onChange={(e) => setCustomStart(e.target.value)}
                />
                <span className="text-muted text-xs">to</span>
                <input
                  type="date"
                  className="bg-background border border-border rounded px-2 py-1 text-xs text-text font-mono focus:outline-none"
                  value={customEnd}
                  onChange={(e) => setCustomEnd(e.target.value)}
                />
              </div>
            )}
          </div>
        </div>

        <div className="space-y-2">
          <p className="text-xs text-muted">Compare</p>
          <div className="flex items-center gap-2 flex-wrap">
            {COMPARISON_OPTIONS.map((option) => (
              <button
                key={option.key}
                onClick={() => setComparison(option.key)}
                className={`px-3 py-1.5 text-xs rounded border transition-all ${
                  comparison === option.key
                    ? 'bg-blue/10 text-blue border-blue/40'
                    : 'text-muted border-border hover:text-text'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <ReportSummaryPanel
        summary={summary}
        onAsk={askAdvisorAboutReport}
        onExcludedFlow={(flow) => setEvidenceTarget({
          kind: 'excluded_flow',
          label: `Excluded ${flow.flow_type}`,
          flowType: flow.flow_type,
        })}
      />
      <ReportEvidenceModal
        target={evidenceTarget}
        startDate={startDate}
        endDate={endDate}
        onClose={() => setEvidenceTarget(null)}
      />

      {/* Tab selector */}
      <div className="flex gap-1 bg-surface shadow-sm border border-border rounded p-0.5 w-fit">
        {(['spending', 'income', 'trends', 'cashflow', 'networth', 'investments'] as ReportTab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-1.5 text-xs rounded capitalize transition-all ${
              tab === t ? 'bg-green-10 text-green' : 'text-muted hover:text-text'
            }`}
          >
            {t === 'networth' ? 'Net Worth' : t === 'cashflow' ? 'Cash Flow' : t}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === 'spending' && <SpendingTab startDate={startDate} endDate={endDate} />}
      {tab === 'income' && <IncomeTab startDate={startDate} endDate={endDate} />}
      {tab === 'trends' && <TrendsTab startDate={startDate} endDate={endDate} initialCategoryIds={trendCategoryIds} />}
      {tab === 'cashflow' && <CashflowTab startDate={startDate} endDate={endDate} />}
      {tab === 'networth' && <NetWorthTab />}
      {tab === 'investments' && <InvestmentsTab />}
    </div>
  );
}
