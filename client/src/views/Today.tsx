import { useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format, startOfMonth, endOfMonth, subMonths, differenceInCalendarDays, parseISO } from 'date-fns';
import type { AdvisorDraftAction, Insight } from '@shared/types';
import {
  aiApi,
  budgetsApi,
  goalsApi,
  insightsApi,
  networthApi,
  recurringApi,
  reportsApi,
  transactionsApi,
} from '../lib/api';
import { formatCurrency, formatWholeCurrency } from '../lib/formatters';
import { computeSafeToSpend } from '../lib/safeToSpend';
import { useAppStore } from '../store';
import { QueryErrorBanner } from '../components/QueryErrorBanner';
import { Screen, BalanceScale, TextButton } from '../components/balance';

const SPARK_W = 62;
const SPARK_H = 16;

/** Six months of shape behind a figure. Scaled to its own maximum: trend, not magnitude. */
function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return <span className="text-faint">—</span>;
  const max = Math.max(...values, 1);
  const step = SPARK_W / (values.length - 1);
  const points = values.map((v, i) => `${(i * step).toFixed(1)},${(SPARK_H - (v / max) * SPARK_H).toFixed(1)}`).join(' ');
  return (
    <svg width={SPARK_W} height={SPARK_H} className="overflow-visible" aria-hidden>
      <polyline points={points} fill="none" stroke="var(--mz-muted-2)" strokeWidth="1.25" />
      <circle cx={SPARK_W} cy={SPARK_H - (values[values.length - 1] / max) * SPARK_H} r="1.75" fill="var(--mz-ink)" />
    </svg>
  );
}

/**
 * Block rather than flex. A flex container makes every child a flex item and drops the
 * whitespace-only text nodes between them, which runs the separators into the figures:
 * "Latest · 18 uncategorized · advisor set 26 today" renders as "Latest ·18 uncategorized·".
 */
function SectionRule({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <Link
      to={to}
      className="mb-3.5 block border-b border-line-2 pb-2.5 text-[10.5px] uppercase tracking-[0.16em] text-muted transition-colors hover:text-ink"
    >
      {children}
    </Link>
  );
}

function RailRow({ to, label, value, tone }: { to: string; label: string; value: string; tone?: string }) {
  return (
    <Link to={to} className="group flex items-baseline justify-between gap-4 text-[13px]">
      <span className={`truncate transition-colors group-hover:text-ink ${tone ?? 'text-muted'}`}>{label}</span>
      <span className={`whitespace-nowrap font-mono tabular-nums ${tone ?? 'text-ink'}`}>{value}</span>
    </Link>
  );
}

function Skeleton({ rows }: { rows: number }) {
  return (
    <div className="space-y-3" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-[13px] rounded bg-line" style={{ width: `${92 - i * 6}%` }} />
      ))}
    </div>
  );
}

export function Today() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const addToast = useAppStore((s) => s.addToast);

  const now = new Date();
  const currentMonth = format(now, 'yyyy-MM');
  const monthStart = format(startOfMonth(now), 'yyyy-MM-dd');
  const monthEnd = format(endOfMonth(now), 'yyyy-MM-dd');
  const trendStart = format(startOfMonth(subMonths(now, 5)), 'yyyy-MM-dd');

  const snapshotQ = useQuery({ queryKey: ['networth', 'snapshot'], queryFn: () => networthApi.snapshot(), retry: false });
  const historyQ = useQuery({ queryKey: ['networth', 'history', 12], queryFn: () => networthApi.history(12), retry: false });
  const reviewQ = useQuery({ queryKey: ['transactions', 'review'], queryFn: () => transactionsApi.review() });
  const forecastQ = useQuery({ queryKey: ['recurring', 'forecast', 30], queryFn: () => recurringApi.forecast(30) });
  const budgetsQ = useQuery({ queryKey: ['budgets', currentMonth], queryFn: () => budgetsApi.getMonth(currentMonth) });
  const goalsQ = useQuery({ queryKey: ['goals'], queryFn: () => goalsApi.list() });
  const insightsQ = useQuery({ queryKey: ['insights'], queryFn: () => insightsApi.list() });
  const aiActionsQ = useQuery({ queryKey: ['ai-actions'], queryFn: () => aiApi.listActions(), retry: false });
  const cashflowQ = useQuery({
    queryKey: ['reports', 'cashflow', monthStart, monthEnd],
    queryFn: () => reportsApi.cashflow({ startDate: monthStart, endDate: monthEnd }),
  });
  const spendingQ = useQuery({
    queryKey: ['reports', 'spending', monthStart, monthEnd],
    queryFn: () => reportsApi.spending({ startDate: monthStart, endDate: monthEnd }),
  });
  const trendsQ = useQuery({
    queryKey: ['reports', 'trends', trendStart, monthEnd],
    queryFn: () => reportsApi.trends({ startDate: trendStart, endDate: monthEnd }),
  });
  const transactionsQ = useQuery({
    queryKey: ['transactions', 'today-recent'],
    queryFn: () => transactionsApi.list({ page: 1, limit: 10, sortBy: 'date', sortDir: 'desc' }),
  });

  const snapshot = snapshotQ.data;
  const forecast = forecastQ.data;
  const reviewSummary = reviewQ.data;

  // A dead request must not render as a quiet zero — the banner names what is missing.
  const failableQueries = [
    { query: snapshotQ, label: 'net worth' },
    { query: historyQ, label: 'net worth history' },
    { query: reviewQ, label: 'review queue' },
    { query: forecastQ, label: 'upcoming bills' },
    { query: budgetsQ, label: 'budgets' },
    { query: goalsQ, label: 'goals' },
    { query: cashflowQ, label: 'this month' },
    { query: spendingQ, label: 'spending by category' },
    { query: trendsQ, label: 'category trends' },
    { query: transactionsQ, label: 'recent transactions' },
  ];

  const weekDelta = useMemo(() => {
    const snapshots = historyQ.data ?? [];
    if (snapshots.length < 2) return null;
    const latest = snapshots[snapshots.length - 1];
    const weekAgo = [...snapshots]
      .reverse()
      .find((s) => differenceInCalendarDays(parseISO(latest.date), parseISO(s.date)) >= 7);
    return weekAgo ? latest.net_worth - weekAgo.net_worth : null;
  }, [historyQ.data]);

  const monthTotals = (cashflowQ.data?.months ?? []).reduce(
    (totals, m) => ({ income: totals.income + m.income, expenses: totals.expenses + m.expenses }),
    { income: 0, expenses: 0 }
  );
  const monthNet = monthTotals.income - monthTotals.expenses;

  // Matched on id, not display name: two categories can share a name across different parents.
  const trendById = useMemo(
    () => new Map((trendsQ.data?.series ?? []).map((s) => [s.category_id, s.values])),
    [trendsQ.data]
  );

  const bills = (forecast?.occurrences ?? []).filter((o) => !o.is_income && o.adjustment_action !== 'skip');
  const oldestOverdue = bills.find((o) => o.status === 'overdue') ?? null;
  // Split from the overdue one, so a bill that was due last week is not labelled as still ahead.
  const nextBill = bills.find((o) => o.status !== 'overdue') ?? null;
  const topGoal = (goalsQ.data ?? []).find((g) => !g.is_archived && g.target_amount > 0 && g.remaining_amount > 0);
  const safeToSpend = computeSafeToSpend({ snapshot, forecast, budgets: budgetsQ.data, goals: goalsQ.data });
  const recentAiCount = (aiActionsQ.data ?? []).filter(
    (a) => differenceInCalendarDays(new Date(), parseISO(a.created_at)) <= 1
  ).length;

  const reviewCount = reviewSummary?.total_open ?? 0;
  const topSpending = (spendingQ.data?.categories ?? []).slice(0, 7);
  const recent = transactionsQ.data?.data ?? [];

  const draft: AdvisorDraftAction | undefined = reviewSummary?.ai_drafts?.[0];
  const insight: Insight | undefined = insightsQ.data?.[0];

  const confirmDraft = useMutation({
    mutationFn: (d: AdvisorDraftAction) => aiApi.confirmDraft(d),
    onSuccess: (res) => {
      addToast({ type: 'success', message: res.message || 'Applied.' });
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      queryClient.invalidateQueries({ queryKey: ['insights'] });
      queryClient.invalidateQueries({ queryKey: ['ai-actions'] });
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });
  const dismissDraft = useMutation({
    mutationFn: (id: string) => aiApi.dismissDraft(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['transactions', 'review'] }),
  });

  const sheetLoading = snapshotQ.isLoading;

  return (
    <Screen size="wide">
      <header className="flex flex-shrink-0 items-baseline justify-between gap-4 border-b border-line-2 pb-5">
        <span className="font-mono text-[14px] font-medium tracking-[0.16em] text-ink">MIZĀN</span>
        <button
          type="button"
          onClick={() => window.dispatchEvent(new Event('mizan:open-palette'))}
          className="text-[12px] uppercase tracking-[0.09em] text-muted transition-colors hover:text-ink"
        >
          {format(now, 'EEEE d MMMM')} · <span className="font-mono">⌘K</span>
        </button>
      </header>

      <QueryErrorBanner items={failableQueries} className="mt-6" />

      <div className="mt-9 flex flex-col gap-12 lg:flex-row lg:items-start lg:gap-16">
        {/* The sheet, read off the instrument: the pans carry assets against owed, the base
            carries the net. This replaced a four-across stat row that said the same thing. */}
        {/* Capped when stacked too, or the rail takes the full column and the scale blows up to
            the width of the screen with its two figures stranded at opposite edges. */}
        <div className="w-full max-w-[332px] flex-shrink-0 lg:w-[332px]">
          <BalanceScale
            assets={snapshot?.total_assets ?? 0}
            liabilities={snapshot?.total_liabilities ?? 0}
            className="h-auto w-full"
          />
          <Link to="/accounts" className="group mt-0.5 flex items-start justify-between gap-4">
            <div>
              <div className="text-[10.5px] uppercase tracking-[0.16em] text-muted transition-colors group-hover:text-ink">
                Assets
              </div>
              <div className="font-mono text-[15px] leading-[1.4] tabular-nums text-ink">
                {formatCurrency(snapshot?.total_assets ?? 0)}
              </div>
            </div>
            <div className="text-right">
              <div className="text-[10.5px] uppercase tracking-[0.16em] text-muted transition-colors group-hover:text-ink">
                Owed
              </div>
              <div className="font-mono text-[15px] leading-[1.4] tabular-nums text-clay">
                {formatCurrency(snapshot?.total_liabilities ?? 0)}
              </div>
            </div>
          </Link>

          <div className="mt-6 border-t border-line-2 pt-5">
            <div className="mb-2.5 text-[10.5px] uppercase tracking-[0.16em] text-muted">Net worth</div>
            {sheetLoading ? (
              <div className="h-[38px] w-3/4 rounded bg-line" aria-hidden />
            ) : (
              <>
                <div className="font-mono text-[38px] font-light leading-none tracking-[-0.02em] tabular-nums text-ink">
                  {formatCurrency(snapshot?.net_worth ?? 0)}
                </div>
                <div className={`mt-2.5 font-mono text-[13px] ${weekDelta != null && weekDelta < 0 ? 'text-clay' : 'text-sage-deep'}`}>
                  {weekDelta == null
                    ? '—'
                    : `${weekDelta < 0 ? '−' : '+'}${formatWholeCurrency(Math.abs(weekDelta))} this week`}
                </div>
              </>
            )}
          </div>

          {/* Stacked in the rail rather than run along the foot: one fewer horizontal band, and
              the rail would otherwise run out well before the tables beside it do. */}
          <div className="mt-6 grid gap-[11px] border-t border-line-2 pt-5">
            <RailRow to="/budget" label="Free to spend" value={formatWholeCurrency(safeToSpend)} />
            {topGoal && (
              <RailRow
                to="/goals"
                label={topGoal.name}
                value={`${formatWholeCurrency(topGoal.remaining_amount)} to go`}
              />
            )}
            {oldestOverdue && (
              <RailRow
                to="/bills"
                label={`${oldestOverdue.merchant_name} overdue`}
                value={formatWholeCurrency(Math.abs(oldestOverdue.adjusted_amount ?? oldestOverdue.amount))}
                tone="text-clay"
              />
            )}
            {nextBill && (
              <RailRow
                to="/bills"
                label={`Next ${nextBill.merchant_name}`}
                value={`${formatWholeCurrency(Math.abs(nextBill.adjusted_amount ?? nextBill.amount))} ${
                  nextBill.days_until <= 0 ? 'today' : `in ${nextBill.days_until}d`
                }`}
              />
            )}
          </div>

          {/* The one thing on this screen asking for a decision, so it sits at the end of the
              column that holds what needs you rather than inside the tables. */}
          {(draft || insight) && (
            <div className="mt-6 border-t border-line-2 pt-5">
              <div className="mb-2.5 text-[10.5px] uppercase tracking-[0.16em] text-muted">Advisor</div>
              <p className="text-[13.5px] leading-relaxed text-ink-soft">
                {draft ? draft.summary : `${insight!.title}. ${insight!.message}`}
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px]">
                {draft ? (
                  <>
                    <TextButton variant="primary" onClick={() => confirmDraft.mutate(draft)} disabled={confirmDraft.isPending}>
                      {draft.label}
                    </TextButton>
                    <TextButton onClick={() => dismissDraft.mutate(draft.id)}>Dismiss</TextButton>
                  </>
                ) : (
                  insight!.action_route && (
                    <TextButton variant="primary" onClick={() => navigate(insight!.action_route!)}>
                      {insight!.action_label ?? 'Take a look'}
                    </TextButton>
                  )
                )}
              </div>
            </div>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <SectionRule to="/cash-flow">
            {format(now, 'MMMM')} · {formatWholeCurrency(monthTotals.expenses)} out ·{' '}
            {formatWholeCurrency(monthTotals.income)} in ·{' '}
            <span className={monthNet < 0 ? 'text-clay' : 'text-sage-deep'}>
              {monthNet < 0 ? '−' : '+'}
              {formatWholeCurrency(Math.abs(monthNet))}
            </span>
          </SectionRule>

          {spendingQ.isLoading ? (
            <Skeleton rows={5} />
          ) : topSpending.length === 0 ? (
            <p className="text-[13.5px] text-muted">No spending recorded this month yet.</p>
          ) : (
            /* Capped: full-bleed, the name and its figure sat at opposite edges of the column
               and read as two unrelated lists. */
            <div className="max-w-[560px]">
              {topSpending.map((category) => (
                <Link
                  key={category.category_id}
                  to="/reports"
                  className="group grid grid-cols-[1fr_auto_62px] items-center gap-x-[22px] py-[7px]"
                >
                  <span className="truncate text-[13.5px] text-ink-soft transition-colors group-hover:text-ink">
                    {category.category_name}
                  </span>
                  <span className="whitespace-nowrap text-right font-mono text-[13.5px] tabular-nums text-ink">
                    {formatWholeCurrency(category.amount)}
                  </span>
                  <Sparkline values={trendById.get(category.category_id) ?? []} />
                </Link>
              ))}
            </div>
          )}

          <div className="mt-9">
            <SectionRule to="/review">
              Latest ·{' '}
              <span className={reviewCount > 0 ? 'text-clay' : 'text-muted'}>{reviewCount} uncategorized</span>
              {recentAiCount > 0 && <> · advisor set {recentAiCount} today</>}
            </SectionRule>

            {transactionsQ.isLoading ? (
              <Skeleton rows={6} />
            ) : recent.length === 0 ? (
              <p className="text-[13.5px] text-muted">No transactions yet. Connect an account to see them here.</p>
            ) : (
              recent.map((t) => (
                <Link
                  key={t.id}
                  to="/transactions"
                  className="group grid grid-cols-[58px_minmax(0,1fr)_auto_100px] items-baseline gap-x-3 py-[7px]"
                >
                  <span className="whitespace-nowrap font-mono text-[12px] text-faint">
                    {format(parseISO(t.date), 'dd MMM')}
                  </span>
                  <span className="truncate text-[13.5px] text-ink-soft transition-colors group-hover:text-ink">
                    {t.merchant_name || t.original_name}
                  </span>
                  <span className={`truncate text-right text-[11.5px] ${t.category_name ? 'text-faint' : 'text-clay'}`}>
                    {t.category_name ?? 'uncategorized'}
                  </span>
                  <span
                    className={`whitespace-nowrap text-right font-mono text-[13px] tabular-nums ${
                      t.amount < 0 ? 'text-ink' : 'text-sage-deep'
                    }`}
                  >
                    {formatCurrency(t.amount)}
                  </span>
                </Link>
              ))
            )}
          </div>
        </div>
      </div>
    </Screen>
  );
}
