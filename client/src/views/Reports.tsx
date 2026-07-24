import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format, startOfMonth, endOfMonth, subMonths, startOfYear } from 'date-fns';
import { networthApi, reportsApi } from '../lib/api';
import { ASSET_COLORS } from '../lib/chartColors';
import { formatWholeCurrency } from '../lib/formatters';
import { Screen, ScreenHeader, SectionLabel, Select, TrendChart } from '../components/balance';
import { QueryState } from '../components/QueryState';
import type { NetWorthSnapshot, ReportMetricSummary } from '@shared/types';

const LIABILITY_COLOR = '#b5654a'; // clay
const INCOME_COLOR = '#5c7050'; // deep sage
const [LIQUID_COLOR, EQUITY_COLOR, CRYPTO_COLOR, OTHER_COLOR] = ASSET_COLORS;

const RANGES = [
  { id: 'this-month', label: 'This month' },
  { id: 'last-month', label: 'Last month' },
  { id: 'three-months', label: 'Last 3 months' },
  { id: 'this-year', label: 'This year' },
] as const;
type RangeId = (typeof RANGES)[number]['id'];

// Net-worth trend window. `undefined` months = full history (server applies no floor), so the
// chart can show data back to the earliest snapshot (2023) instead of a hardcoded year.
const TREND_RANGES = [
  { id: '1y', label: '1Y', months: 12 as number | undefined },
  { id: '2y', label: '2Y', months: 24 as number | undefined },
  { id: 'all', label: 'All', months: undefined as number | undefined },
] as const;

function rangeDates(id: RangeId): { startDate: string; endDate: string } {
  const now = new Date();
  const fmt = (d: Date) => format(d, 'yyyy-MM-dd');
  switch (id) {
    case 'this-month': return { startDate: fmt(startOfMonth(now)), endDate: fmt(endOfMonth(now)) };
    case 'last-month': { const p = subMonths(now, 1); return { startDate: fmt(startOfMonth(p)), endDate: fmt(endOfMonth(p)) }; }
    case 'three-months': return { startDate: fmt(startOfMonth(subMonths(now, 2))), endDate: fmt(endOfMonth(now)) };
    case 'this-year': return { startDate: fmt(startOfYear(now)), endDate: fmt(now) };
  }
}

// ── Debt-payoff distribution (unchanged behavior) ──
interface Buckets { liquid: number; equity: number; crypto: number; other: number; liabilities: number; netWorth: number; }
function before(s: NetWorthSnapshot): Buckets {
  const liquid = s.liquid_assets ?? 0, equity = s.investment_assets ?? 0, crypto = s.crypto_assets ?? 0;
  const other = Math.max(0, s.total_assets - (liquid + equity + crypto));
  return { liquid, equity, crypto, other, liabilities: s.total_liabilities, netWorth: s.net_worth };
}
function afterPayoff(b: Buckets): Buckets {
  return { ...b, liquid: Math.max(0, b.liquid - b.liabilities), liabilities: Math.max(0, b.liabilities - b.liquid) };
}
const SEGMENTS: Array<{ key: keyof Buckets; label: string; color: string }> = [
  { key: 'liquid', label: 'Cash', color: LIQUID_COLOR },
  { key: 'equity', label: 'Stocks', color: EQUITY_COLOR },
  { key: 'crypto', label: 'Crypto', color: CRYPTO_COLOR },
  { key: 'other', label: 'Other', color: OTHER_COLOR },
];
function Distribution({ b, scaleMax }: { b: Buckets; scaleMax: number }) {
  const assetTotal = b.liquid + b.equity + b.crypto + b.other;
  const pct = (v: number) => (scaleMax > 0 ? (v / scaleMax) * 100 : 0);
  return (
    <div className="space-y-3">
      <div>
        <div className="mb-1 flex items-baseline justify-between text-[13px] text-muted">
          <span>Assets</span><span className="tabular-nums text-ink">{formatWholeCurrency(assetTotal)}</span>
        </div>
        <div className="flex h-7 w-full overflow-hidden rounded-md bg-rail">
          {SEGMENTS.map((seg) => b[seg.key] > 0 ? (
            <div key={seg.key} title={`${seg.label}: ${formatWholeCurrency(b[seg.key])}`} style={{ width: `${pct(b[seg.key])}%`, background: seg.color }} />
          ) : null)}
        </div>
      </div>
      <div>
        <div className="mb-1 flex items-baseline justify-between text-[13px] text-muted">
          <span>Liabilities</span><span className="tabular-nums text-ink">{formatWholeCurrency(b.liabilities)}</span>
        </div>
        <div className="flex h-7 w-full overflow-hidden rounded-md bg-rail">
          {b.liabilities > 0 && <div style={{ width: `${pct(b.liabilities)}%`, background: LIABILITY_COLOR }} />}
        </div>
      </div>
    </div>
  );
}

function Metric({ label, m, invertColor, isPercent }: { label: string; m: ReportMetricSummary; invertColor?: boolean; isPercent?: boolean }) {
  const up = m.delta > 0;
  const good = invertColor ? !up : up; // for expenses, up is bad
  const fmt = (v: number) => (isPercent ? `${Math.round(v)}%` : formatWholeCurrency(v));
  return (
    <div>
      <div className="text-[12px] uppercase tracking-[0.12em] text-muted-2">{label}</div>
      <div className="mt-1 font-serif text-2xl text-ink tabular-nums">{fmt(m.current)}</div>
      {m.delta !== 0 && (
        <div className={`mt-0.5 text-[12.5px] tabular-nums ${good ? 'text-sage-deep' : 'text-clay'}`}>
          {up ? '▲' : '▼'} {fmt(Math.abs(m.delta))}
        </div>
      )}
    </div>
  );
}

export function Reports() {
  const [range, setRange] = useState<RangeId>('this-month');
  const [trendRange, setTrendRange] = useState<string>('all');
  const [showAllSpending, setShowAllSpending] = useState(false);
  const dates = rangeDates(range);
  const trendMonths = TREND_RANGES.find((r) => r.id === trendRange)?.months;

  // Query keys MUST start with a segment listed in queryInvalidation.ts's FINANCIAL_QUERY_KEYS —
  // TanStack matches by array prefix. These used to be ['networth-snapshot'], ['report-summary', …]
  // etc., which matched nothing, so a sync refreshed Accounts and Today but left Reports showing
  // stale numbers: two screens disagreeing about net worth.
  const snapshotQ = useQuery({ queryKey: ['networth', 'snapshot'], queryFn: () => networthApi.snapshot() });
  const historyQ = useQuery({ queryKey: ['networth', 'history', trendRange], queryFn: () => networthApi.history(trendMonths) });
  const summaryQ = useQuery({ queryKey: ['reports', 'summary', range], queryFn: () => reportsApi.summary(dates) });
  // The dates belong in the key, or a tab left open across a month boundary serves the old window.
  const cashflowDates = rangeDates('three-months');
  const cashflowQ = useQuery({ queryKey: ['reports', 'cashflow', cashflowDates], queryFn: () => reportsApi.cashflow(cashflowDates) });
  const spendingQ = useQuery({ queryKey: ['reports', 'spending', range], queryFn: () => reportsApi.spending(dates) });

  const { data: snapshot } = snapshotQ;
  const { data: history } = historyQ;
  const { data: summary } = summaryQ;
  const { data: cashflow } = cashflowQ;
  const { data: spending } = spendingQ;

  const trendPoints = (history ?? []).map((s) => ({ date: s.date, value: s.net_worth }));
  const cashflowMax = Math.max(1, ...(cashflow?.months ?? []).flatMap((m) => [m.income, m.expenses]));
  // Show every category (previously capped at 8 with no way to see the rest — the user could not
  // see their own spending breakdown, including the Uncategorized bucket).
  const allSpending = spending?.categories ?? [];
  const topSpending = showAllSpending ? allSpending : allSpending.slice(0, 8);
  const spendingMax = Math.max(1, ...allSpending.map((c) => c.amount));

  return (
    <Screen size="wide" contained>
      <ScreenHeader title="Reports" sub="Trends, cash flow, spending, and debt payoff" className="mb-6" />

      <div className="max-w-[860px] space-y-12">
        {/* Net worth trend */}
        <section>
          <div className="mb-2 flex items-center justify-between">
            <SectionLabel>Net worth</SectionLabel>
            <Select
              value={trendRange} onChange={setTrendRange} placeholder="Range" clearable={false}
              options={TREND_RANGES.map((r) => ({ value: r.id, label: r.label }))} align="right"
            />
          </div>
          <QueryState
            isLoading={snapshotQ.isPending || historyQ.isPending}
            isError={snapshotQ.isError || historyQ.isError}
            error={snapshotQ.error ?? historyQ.error}
            onRetry={() => { void snapshotQ.refetch(); void historyQ.refetch(); }}
            label="net worth"
          >
            {snapshot && (
              <div className="mb-3 font-serif text-3xl text-ink tabular-nums">{formatWholeCurrency(snapshot.net_worth)}</div>
            )}
            {trendPoints.length >= 2
              ? <TrendChart history={trendPoints} height={140} />
              : <p className="text-[13.5px] text-muted-2">Not enough snapshots yet for a trend — they accrue as you sync.</p>}
          </QueryState>
        </section>

        {/* Period summary with range selector */}
        <section>
          <div className="mb-3 flex items-center justify-between">
            <SectionLabel>This period</SectionLabel>
            <Select value={range} onChange={(v) => setRange(v as RangeId)} clearable={false}
              placeholder="This month" options={RANGES.map((r) => ({ value: r.id, label: r.label }))} />
          </div>
          <QueryState
            isLoading={summaryQ.isPending}
            isError={summaryQ.isError}
            error={summaryQ.error}
            onRetry={() => void summaryQ.refetch()}
            label="this period's summary"
          >
            {summary && (
              <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
                <Metric label="Income" m={summary.income} />
                <Metric label="Expenses" m={summary.expenses} invertColor />
                <Metric label="Net" m={summary.net} />
                <Metric label="Savings rate" m={summary.savings_rate} isPercent />
              </div>
            )}
          </QueryState>
        </section>

        {/* Monthly cash flow (last 3 months) */}
        <section>
          <SectionLabel className="mb-3">Cash flow · last 3 months</SectionLabel>
          <QueryState
            isLoading={cashflowQ.isPending}
            isError={cashflowQ.isError}
            error={cashflowQ.error}
            onRetry={() => void cashflowQ.refetch()}
            label="cash flow"
          >
          <div className="space-y-3">
            {(cashflow?.months ?? []).map((m) => (
              <div key={m.month}>
                <div className="mb-1 flex items-baseline justify-between text-[13px]">
                  <span className="text-muted">{m.month}</span>
                  <span className={`tabular-nums ${m.net >= 0 ? 'text-sage-deep' : 'text-clay'}`}>
                    {m.net >= 0 ? '+' : ''}{formatWholeCurrency(m.net)}
                  </span>
                </div>
                <div className="space-y-1">
                  <div className="h-3 w-full overflow-hidden rounded bg-rail">
                    <div style={{ width: `${(m.income / cashflowMax) * 100}%`, background: INCOME_COLOR }} className="h-full" title={`Income ${formatWholeCurrency(m.income)}`} />
                  </div>
                  <div className="h-3 w-full overflow-hidden rounded bg-rail">
                    <div style={{ width: `${(m.expenses / cashflowMax) * 100}%`, background: LIABILITY_COLOR }} className="h-full" title={`Expenses ${formatWholeCurrency(m.expenses)}`} />
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-2 flex gap-4 text-[11.5px] text-muted-2">
            <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: INCOME_COLOR }} />Income</span>
            <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: LIABILITY_COLOR }} />Expenses</span>
          </div>
          </QueryState>
        </section>

        {/* Spending by category */}
        <section>
          <SectionLabel className="mb-3">Spending by category · {RANGES.find((r) => r.id === range)?.label.toLowerCase()}</SectionLabel>
          <QueryState
            isLoading={spendingQ.isPending}
            isError={spendingQ.isError}
            error={spendingQ.error}
            onRetry={() => void spendingQ.refetch()}
            label="spending"
          >
            {topSpending.length > 0 ? (
              <>
                <div className="space-y-2.5">
                  {topSpending.map((c) => (
                    <div key={c.category_id}>
                      <div className="mb-1 flex items-baseline justify-between text-[13px]">
                        <span className="text-ink">{c.category_name}</span>
                        <span className="tabular-nums text-muted">{formatWholeCurrency(c.amount)}</span>
                      </div>
                      <div className="h-4 w-full overflow-hidden rounded bg-rail">
                        <div className="h-full" style={{ width: `${(c.amount / spendingMax) * 100}%`, background: c.color ?? LIQUID_COLOR }} />
                      </div>
                    </div>
                  ))}
                </div>
                {allSpending.length > 8 && (
                  <button
                    type="button"
                    onClick={() => setShowAllSpending((v) => !v)}
                    className="mt-3 text-[13px] text-muted transition-colors hover:text-ink"
                  >
                    {showAllSpending ? 'Show top 8' : `Show all ${allSpending.length} categories`}
                  </button>
                )}
              </>
            ) : <p className="text-[13.5px] text-muted-2">No spending in this period.</p>}
          </QueryState>
        </section>

        {/* Debt payoff distribution */}
        {snapshot && (() => {
          const b = before(snapshot);
          const a = afterPayoff(b);
          const scaleMax = Math.max(b.liquid + b.equity + b.crypto + b.other, b.liabilities, 1);
          return (
            <section>
              <SectionLabel className="mb-1">Net worth if you paid off debt</SectionLabel>
              {b.liabilities > 0 && (
                <p className="mb-4 text-[13.5px] leading-relaxed text-muted">
                  Paying off {formatWholeCurrency(b.liabilities)} from cash leaves net worth unchanged at{' '}
                  <span className="text-ink">{formatWholeCurrency(a.netWorth)}</span> — it reshuffles, not grows.
                </p>
              )}
              <div className="grid grid-cols-1 gap-10 sm:grid-cols-2">
                <div><SectionLabel className="mb-3">Now</SectionLabel><Distribution b={b} scaleMax={scaleMax} /></div>
                <div><SectionLabel className="mb-3">After payoff</SectionLabel><Distribution b={a} scaleMax={scaleMax} /></div>
              </div>
              <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-[12.5px] text-muted">
                {SEGMENTS.map((seg) => (
                  <span key={seg.key} className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: seg.color }} />{seg.label}</span>
                ))}
                <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: LIABILITY_COLOR }} />Liabilities</span>
              </div>
            </section>
          );
        })()}
      </div>
    </Screen>
  );
}
