import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
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
import { format, subMonths, startOfMonth, endOfMonth, startOfYear } from 'date-fns';
import { reportsApi, networthApi, investmentsApi, categoriesApi } from '../lib/api';
import { formatCurrency, formatMonth, formatDate, formatPercent } from '../lib/formatters';
import { PageLoader } from '../components/LoadingSpinner';
const COLORS = [
  '#4ecba3', '#5b8dee', '#d4a44c', '#e07070', '#a78bfa',
  '#f472b6', '#34d399', '#fb923c', '#60a5fa', '#f87171',
];

type DatePreset = 'this_month' | 'last_month' | '3m' | '6m' | '12m' | 'ytd' | 'all' | 'custom';

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

function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-surface border border-border rounded px-3 py-2 text-xs">
      <p className="text-muted mb-1 font-mono">{label}</p>
      {payload.map((p: any) => (
        <div key={p.dataKey} className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: p.color }} />
          <span className="text-text">{p.name}:</span>
          <span className="font-mono" style={{ color: p.color }}>{formatCurrency(Math.abs(p.value))}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Spending Tab ─────────────────────────────────────────────────────────────

function SpendingTab({ startDate, endDate }: { startDate: string; endDate: string }) {
  const [drillId, setDrillId] = useState<string | null>(null);

  const { data: spending, isLoading } = useQuery({
    queryKey: ['spending', startDate, endDate],
    queryFn: () => reportsApi.spending({ startDate, endDate }),
  });

  if (isLoading) return <PageLoader />;

  const categories = spending?.categories ?? [];
  const displayCats = drillId
    ? categories.find((c) => c.category_id === drillId)?.children ?? []
    : categories;

  const treemapData = displayCats.map((c, i) => ({
    name: c.category_name,
    size: c.amount,
    color: c.color || COLORS[i % COLORS.length],
  }));

  return (
    <div className="space-y-6">
      {drillId && (
        <button
          className="text-xs text-[#4ecba3] hover:opacity-80"
          onClick={() => setDrillId(null)}
        >
          ← Back to all categories
        </button>
      )}
      {treemapData.length > 0 ? (
        <div className="bg-surface border border-border rounded p-4">
          <ResponsiveContainer width="100%" height={280}>
            <Treemap
              data={treemapData}
              dataKey="size"
              aspectRatio={4 / 3}
              // eslint-disable-next-line @typescript-eslint/ban-ts-comment
              // @ts-ignore Recharts type is overly restrictive for content
              content={({ x, y, width, height, name, color, value }: any) => (
                <g>
                  <rect
                    x={x + 1}
                    y={y + 1}
                    width={width - 2}
                    height={height - 2}
                    style={{ fill: color, opacity: 0.85, cursor: 'pointer' }}
                    onClick={() => {
                      const cat = categories.find((c) => c.category_name === name);
                      if (cat?.children?.length) setDrillId(cat.category_id);
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
              )}
            />
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="bg-surface border border-border rounded p-12 text-center text-muted text-sm">
          No spending data for the selected period
        </div>
      )}

      {/* Data table */}
      <div className="bg-surface border border-border rounded overflow-hidden">
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
              <tr key={c.category_id} className="border-b border-border hover:bg-white/2">
                <td className="px-4 py-2">
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: c.color || COLORS[i % COLORS.length] }} />
                    <span className="text-text">{c.category_name}</span>
                  </div>
                </td>
                <td className="px-4 py-2 font-mono text-right text-[#e07070]">{formatCurrency(c.amount)}</td>
                <td className="px-4 py-2 font-mono text-right text-muted">{formatPercent(c.percentage)}</td>
              </tr>
            ))}
          </tbody>
          {spending && (
            <tfoot className="border-t border-border bg-background/30">
              <tr>
                <td className="px-4 py-2 text-sm font-medium text-text">Total</td>
                <td className="px-4 py-2 font-mono text-right text-[#e07070] font-medium">{formatCurrency(spending.total)}</td>
                <td />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}

// ─── Income Tab ───────────────────────────────────────────────────────────────

function IncomeTab({ startDate, endDate }: { startDate: string; endDate: string }) {
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
        <div className="bg-surface border border-border rounded p-4">
          <ResponsiveContainer width="100%" height={280}>
            <Treemap
              data={treemapData}
              dataKey="size"
              // @ts-ignore Recharts type is overly restrictive for content
              content={({ x, y, width, height, name, color, value }: any) => (
                <g>
                  <rect x={x + 1} y={y + 1} width={width - 2} height={height - 2} style={{ fill: color, opacity: 0.85 }} />
                  {width > 60 && height > 30 && (
                    <text x={x + 8} y={y + 18} fill="#e8e8ec" fontSize={11}>{name}</text>
                  )}
                </g>
              )}
            />
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="bg-surface border border-border rounded p-12 text-center text-muted text-sm">
          No income data for the selected period
        </div>
      )}
      <div className="bg-surface border border-border rounded overflow-hidden">
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
              <tr key={c.category_id} className="border-b border-border hover:bg-white/2">
                <td className="px-4 py-2">
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: c.color || COLORS[i % COLORS.length] }} />
                    <span className="text-text">{c.category_name}</span>
                  </div>
                </td>
                <td className="px-4 py-2 font-mono text-right text-[#4ecba3]">{formatCurrency(c.amount)}</td>
                <td className="px-4 py-2 font-mono text-right text-muted">{formatPercent(c.percentage)}</td>
              </tr>
            ))}
          </tbody>
          {income && (
            <tfoot className="border-t border-border bg-background/30">
              <tr>
                <td className="px-4 py-2 text-sm font-medium text-text">Total</td>
                <td className="px-4 py-2 font-mono text-right text-[#4ecba3] font-medium">{formatCurrency(income.total)}</td>
                <td />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}

// ─── Trends Tab ───────────────────────────────────────────────────────────────

function TrendsTab({ startDate, endDate }: { startDate: string; endDate: string }) {
  const { data: categories = [] } = useQuery({
    queryKey: ['categories'],
    queryFn: categoriesApi.list,
  });

  const [selectedCats, setSelectedCats] = useState<string[]>([]);

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

  const expenseCategories = categories.filter((c) => !c.is_income && !c.is_investment);

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
                borderColor: isSelected ? color : '#2a2a2f',
                backgroundColor: isSelected ? `${color}15` : 'transparent',
                color: isSelected ? color : '#6b6b7a',
              }}
            >
              <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: color }} />
              {cat.name}
            </button>
          );
        })}
      </div>

      {selectedCats.length === 0 ? (
        <div className="bg-surface border border-border rounded p-12 text-center text-muted text-sm">
          Select categories above to see spending trends
        </div>
      ) : isLoading ? (
        <PageLoader />
      ) : (
        <div className="bg-surface border border-border rounded p-4">
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={chartData}>
              <CartesianGrid vertical={false} stroke="#2a2a2f" />
              <XAxis dataKey="month" tick={{ fill: '#6b6b7a', fontSize: 11, fontFamily: 'JetBrains Mono' }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: '#6b6b7a', fontSize: 11, fontFamily: 'JetBrains Mono' }} axisLine={false} tickLine={false} tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} />
              <Tooltip content={<ChartTooltip />} />
              <Legend wrapperStyle={{ fontSize: 11, color: '#6b6b7a' }} />
              {trends?.series.map((s, i) => (
                <Line
                  key={s.category_id}
                  dataKey={s.category_id}
                  name={s.category_name}
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

// ─── Net Worth Tab ────────────────────────────────────────────────────────────

function NetWorthTab() {
  const [showAssets, setShowAssets] = useState(true);
  const [showLiabilities, setShowLiabilities] = useState(true);

  const { data: snapshots = [], isLoading } = useQuery({
    queryKey: ['networth', 'history', 24],
    queryFn: () => networthApi.history(24),
  });

  if (isLoading) return <PageLoader />;

  const chartData = snapshots.map((s) => ({
    date: format(new Date(s.date), 'MMM yy'),
    assets: s.total_assets,
    liabilities: s.total_liabilities,
    netWorth: s.net_worth,
  }));

  return (
    <div className="space-y-6">
      {/* Toggles */}
      <div className="flex gap-2">
        {[
          { key: 'assets', label: 'Assets', color: '#4ecba3', val: showAssets, set: setShowAssets },
          { key: 'liabilities', label: 'Liabilities', color: '#e07070', val: showLiabilities, set: setShowLiabilities },
        ].map((t) => (
          <button
            key={t.key}
            onClick={() => t.set(!t.val)}
            className="flex items-center gap-1.5 px-3 py-1 rounded text-xs border transition-all"
            style={{
              borderColor: t.val ? t.color : '#2a2a2f',
              backgroundColor: t.val ? `${t.color}15` : 'transparent',
              color: t.val ? t.color : '#6b6b7a',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Area chart */}
      <div className="bg-surface border border-border rounded p-4">
        <ResponsiveContainer width="100%" height={240}>
          <AreaChart data={chartData}>
            <defs>
              <linearGradient id="assetsGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#4ecba3" stopOpacity={0.2} />
                <stop offset="95%" stopColor="#4ecba3" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="liabGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#e07070" stopOpacity={0.2} />
                <stop offset="95%" stopColor="#e07070" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="nwGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#5b8dee" stopOpacity={0.2} />
                <stop offset="95%" stopColor="#5b8dee" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} stroke="#2a2a2f" />
            <XAxis dataKey="date" tick={{ fill: '#6b6b7a', fontSize: 11, fontFamily: 'JetBrains Mono' }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fill: '#6b6b7a', fontSize: 11, fontFamily: 'JetBrains Mono' }} axisLine={false} tickLine={false} tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} />
            <Tooltip content={<ChartTooltip />} />
            {showAssets && (
              <Area type="monotone" dataKey="assets" name="Assets" stroke="#4ecba3" fill="url(#assetsGrad)" strokeWidth={2} dot={false} />
            )}
            {showLiabilities && (
              <Area type="monotone" dataKey="liabilities" name="Liabilities" stroke="#e07070" fill="url(#liabGrad)" strokeWidth={2} dot={false} />
            )}
            <Area type="monotone" dataKey="netWorth" name="Net Worth" stroke="#5b8dee" fill="url(#nwGrad)" strokeWidth={2} dot={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Monthly table */}
      <div className="bg-surface border border-border rounded overflow-hidden">
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
                <tr key={s.id} className="border-b border-border hover:bg-white/2">
                  <td className="px-4 py-2 font-mono text-muted">{formatDate(s.date)}</td>
                  <td className="px-4 py-2 font-mono text-[#4ecba3]">{formatCurrency(s.total_assets)}</td>
                  <td className="px-4 py-2 font-mono text-[#e07070]">{formatCurrency(s.total_liabilities)}</td>
                  <td className="px-4 py-2 font-mono text-text">{formatCurrency(s.net_worth)}</td>
                  <td className="px-4 py-2 font-mono" style={{ color: delta != null ? (delta >= 0 ? '#4ecba3' : '#e07070') : '#6b6b7a' }}>
                    {delta != null ? `${delta >= 0 ? '+' : ''}${formatCurrency(delta)}` : '—'}
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
    </div>
  );
}

// ─── Investments Tab ──────────────────────────────────────────────────────────

function InvestmentsTab() {
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
      <div className="bg-surface border border-border rounded p-12 text-center text-muted text-sm">
        No investment accounts connected
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Summary + Pie */}
      <div className="grid grid-cols-2 gap-4">
        {/* Portfolio history */}
        <div className="bg-surface border border-border rounded p-4">
          <p className="text-xs text-muted mb-1">Portfolio Value</p>
          <p className="font-mono text-2xl text-[#5b8dee] mb-3">{formatCurrency(totalValue)}</p>
          {historyData.length > 0 && (
            <ResponsiveContainer width="100%" height={120}>
              <AreaChart data={historyData}>
                <defs>
                  <linearGradient id="invGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#5b8dee" stopOpacity={0.2} />
                    <stop offset="95%" stopColor="#5b8dee" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <Area type="monotone" dataKey="value" stroke="#5b8dee" fill="url(#invGrad)" strokeWidth={2} dot={false} />
                <XAxis dataKey="date" hide />
                <YAxis hide />
                <Tooltip content={<ChartTooltip />} />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Allocation pie */}
        <div className="bg-surface border border-border rounded p-4">
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
      <div className="bg-surface border border-border rounded overflow-hidden">
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
                <tr key={h.id} className="border-b border-border hover:bg-white/2">
                  <td className="px-4 py-2 font-mono text-[#5b8dee] font-medium">{h.ticker ?? '—'}</td>
                  <td className="px-4 py-2 text-text max-w-[160px] truncate">{h.security_name}</td>
                  <td className="px-4 py-2 font-mono text-muted">{h.quantity.toFixed(4)}</td>
                  <td className="px-4 py-2 font-mono text-muted">{formatCurrency(h.institution_price)}</td>
                  <td className="px-4 py-2 font-mono text-text">{formatCurrency(h.institution_value)}</td>
                  <td className="px-4 py-2 font-mono text-muted">{h.cost_basis != null ? formatCurrency(h.cost_basis) : '—'}</td>
                  <td className="px-4 py-2 font-mono" style={{ color: unrealized != null ? (unrealized >= 0 ? '#4ecba3' : '#e07070') : '#6b6b7a' }}>
                    {unrealized != null ? `${unrealized >= 0 ? '+' : ''}${formatCurrency(unrealized)}` : '—'}
                  </td>
                  <td className="px-4 py-2 font-mono" style={{ color: pnlPct != null ? (pnlPct >= 0 ? '#4ecba3' : '#e07070') : '#6b6b7a' }}>
                    {pnlPct != null ? `${pnlPct >= 0 ? '+' : ''}${formatPercent(pnlPct)}` : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
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

type ReportTab = 'spending' | 'income' | 'trends' | 'networth' | 'investments';

export function Reports() {
  const [preset, setPreset] = useState<DatePreset>('this_month');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [tab, setTab] = useState<ReportTab>('spending');

  const { startDate, endDate } = getDateRange(preset, customStart, customEnd);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-text">Reports</h1>
      </div>

      {/* Date range picker */}
      <div className="flex items-center gap-2 flex-wrap">
        {PRESETS.map((p) => (
          <button
            key={p.key}
            onClick={() => setPreset(p.key)}
            className={`px-3 py-1.5 text-xs rounded border transition-all ${
              preset === p.key
                ? 'bg-[#4ecba3]/10 text-[#4ecba3] border-[#4ecba3]/40'
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

      {/* Tab selector */}
      <div className="flex gap-1 bg-surface border border-border rounded p-0.5 w-fit">
        {(['spending', 'income', 'trends', 'networth', 'investments'] as ReportTab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-1.5 text-xs rounded capitalize transition-all ${
              tab === t ? 'bg-[#4ecba3]/10 text-[#4ecba3]' : 'text-muted hover:text-text'
            }`}
          >
            {t === 'networth' ? 'Net Worth' : t}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === 'spending' && <SpendingTab startDate={startDate} endDate={endDate} />}
      {tab === 'income' && <IncomeTab startDate={startDate} endDate={endDate} />}
      {tab === 'trends' && <TrendsTab startDate={startDate} endDate={endDate} />}
      {tab === 'networth' && <NetWorthTab />}
      {tab === 'investments' && <InvestmentsTab />}
    </div>
  );
}
