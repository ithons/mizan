import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format, differenceInCalendarDays, parseISO } from 'date-fns';
import type { AdvisorDraftAction, Insight } from '@shared/types';
import {
  accountsApi,
  aiApi,
  budgetsApi,
  goalsApi,
  insightsApi,
  networthApi,
  recurringApi,
  reportsApi,
  transactionsApi,
} from '../lib/api';
import { formatWholeCurrency } from '../lib/formatters';
import { computeSafeToSpend } from '../lib/safeToSpend';
import { useAppStore } from '../store';
import { Screen, SectionLabel, Card, KpiTile, BalanceScale, Row, TextButton, InkButton } from '../components/balance';

function reviewSummaryLine(queues: Array<{ label: string; count: number }>): string {
  const parts = queues.filter((q) => q.count > 0).slice(0, 3);
  if (parts.length === 0) return 'Nothing waiting on you.';
  return parts.map((q) => `${q.count} ${q.label.toLowerCase()}`).join(' · ');
}

export function Today() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const addToast = useAppStore((s) => s.addToast);
  const currentMonth = format(new Date(), 'yyyy-MM');

  const { data: snapshot } = useQuery({ queryKey: ['networth', 'snapshot'], queryFn: () => networthApi.snapshot(), retry: false });
  const { data: history } = useQuery({ queryKey: ['networth', 'history', 1], queryFn: () => networthApi.history(1), retry: false });
  const { data: cashflow } = useQuery({ queryKey: ['cashflow', 'today'], queryFn: () => reportsApi.cashflow() });
  const { data: reviewSummary } = useQuery({ queryKey: ['transactions', 'review'], queryFn: () => transactionsApi.review() });
  const { data: accounts } = useQuery({ queryKey: ['accounts'], queryFn: () => accountsApi.list() });
  const { data: forecast } = useQuery({ queryKey: ['recurring', 'forecast', 30], queryFn: () => recurringApi.forecast(30) });
  const { data: budgets } = useQuery({ queryKey: ['budgets', currentMonth], queryFn: () => budgetsApi.getMonth(currentMonth) });
  const { data: goals } = useQuery({ queryKey: ['goals'], queryFn: () => goalsApi.list() });
  const { data: insights } = useQuery({ queryKey: ['insights'], queryFn: () => insightsApi.list() });

  const netWorth = snapshot?.net_worth ?? 0;
  const totalAssets = snapshot?.total_assets ?? 0;
  const totalLiabilities = snapshot?.total_liabilities ?? 0;

  const weekDelta = useMemo(() => {
    const snapshots = history ?? [];
    if (snapshots.length < 2) return null;
    const latest = snapshots[snapshots.length - 1];
    const weekAgo = [...snapshots]
      .reverse()
      .find((s) => differenceInCalendarDays(parseISO(latest.date), parseISO(s.date)) >= 7);
    return weekAgo ? latest.net_worth - weekAgo.net_worth : null;
  }, [history]);

  const monthCF = (cashflow?.months ?? []).find((m) => m.month === currentMonth);
  const safeToSpend = computeSafeToSpend({ snapshot, forecast, budgets, goals });
  const reviewCount = reviewSummary?.total_open ?? 0;

  const visibleAccounts = (accounts ?? []).filter((a) => !a.is_hidden);
  const topAccounts = [...visibleAccounts]
    .sort((a, b) => Math.abs(b.current_balance) - Math.abs(a.current_balance))
    .slice(0, 4);

  const upcomingBills = (forecast?.occurrences ?? [])
    .filter((o) => !o.is_income && o.days_until <= 14 && o.adjustment_action !== 'skip')
    .slice(0, 4);

  const draft: AdvisorDraftAction | undefined = reviewSummary?.ai_drafts?.[0];
  const insight: Insight | undefined = insights?.[0];

  const confirmDraft = useMutation({
    mutationFn: (d: AdvisorDraftAction) => aiApi.confirmDraft(d),
    onSuccess: (res) => {
      addToast({ type: 'success', message: res.message || 'Applied.' });
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      queryClient.invalidateQueries({ queryKey: ['insights'] });
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });
  const dismissDraft = useMutation({
    mutationFn: (id: string) => aiApi.dismissDraft(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['transactions', 'review'] }),
  });

  return (
    <Screen>
      {/* Header: wordmark + date, search-or-ask */}
      <div className="flex flex-shrink-0 items-center justify-between">
        <div className="flex items-baseline gap-4">
          <span className="font-serif text-2xl text-ink">mizān</span>
          <span className="text-[13px] text-muted">{format(new Date(), 'EEEE, MMMM d')}</span>
        </div>
        <button
          type="button"
          onClick={() => navigate('/advisor')}
          className="flex items-center gap-2.5 rounded-lg border border-line-2 bg-card-alt px-3.5 py-2 text-[13px] text-muted transition-colors hover:text-ink"
        >
          Search or ask a question
          <span className="font-mono text-[11px] text-faint">⌘K</span>
        </button>
      </div>

      {/* KPI row */}
      <div className="mt-7 grid flex-shrink-0 grid-cols-2 gap-4 xl:grid-cols-4">
        <KpiTile
          label="Net worth"
          value={formatWholeCurrency(netWorth)}
          delta={weekDelta != null ? `${weekDelta >= 0 ? '▲' : '▼'} ${formatWholeCurrency(Math.abs(weekDelta))} this week` : undefined}
          deltaTone={weekDelta != null && weekDelta < 0 ? 'clay' : 'sage'}
          to="/accounts"
        />
        <KpiTile label="Safe to spend" value={formatWholeCurrency(safeToSpend)} delta="after bills & budgets" to="/budget" />
        <KpiTile
          label={`Cash flow · ${format(new Date(), 'MMMM')}`}
          value={
            <span className={monthCF && monthCF.net < 0 ? 'text-clay' : 'text-sage-deep'}>
              {formatWholeCurrency(monthCF?.net ?? 0, { showSign: true })}
            </span>
          }
          delta={`${formatWholeCurrency(monthCF?.income ?? 0)} in · ${formatWholeCurrency(Math.abs(monthCF?.expenses ?? 0))} out`}
          to="/cash-flow"
        />
        <KpiTile
          label="To review"
          value={String(reviewCount)}
          delta={reviewCount === 0 ? 'all caught up' : 'transactions & suggestions'}
          to="/transactions"
        />
      </div>

      {/* Two-column grid */}
      <div className="mt-5 grid flex-1 grid-cols-1 items-start gap-5 xl:grid-cols-[1.15fr,1fr]">
        <div className="flex min-w-0 flex-col gap-5">
          {/* Balance scale card */}
          <Card padding="lg">
            <div className="flex items-center gap-6">
              <BalanceScale assets={totalAssets} liabilities={totalLiabilities} className="w-[46%] min-w-[220px] flex-shrink" />
              <div className="min-w-0 flex-1">
                {[
                  { label: 'Assets', value: formatWholeCurrency(totalAssets), tone: 'text-ink' },
                  { label: 'Liabilities', value: formatWholeCurrency(-Math.abs(totalLiabilities)), tone: 'text-clay' },
                  { label: 'Net worth', value: formatWholeCurrency(netWorth), tone: 'text-ink' },
                ].map((row, i) => (
                  <div
                    key={row.label}
                    className={`flex items-baseline justify-between py-2.5 ${i < 2 ? 'border-b border-line' : ''}`}
                  >
                    <span className="text-[13.5px] text-muted">{row.label}</span>
                    <span className={`font-serif text-[19px] tabular-nums ${row.tone}`}>{row.value}</span>
                  </div>
                ))}
              </div>
            </div>
          </Card>

          {/* Accounts card */}
          <Card padding="lg">
            <SectionLabel
              summary={
                <button type="button" onClick={() => navigate('/accounts')} className="text-muted transition-colors hover:text-ink">
                  All {visibleAccounts.length} →
                </button>
              }
              className="mb-2"
            >
              Accounts
            </SectionLabel>
            {topAccounts.map((a, i) => (
              <Row
                key={a.id}
                onClick={() => navigate('/accounts')}
                className={`justify-between px-1 py-3 ${i === topAccounts.length - 1 ? 'border-b-0' : ''}`}
              >
                <div className="min-w-0">
                  <div className="truncate text-[14.5px] text-ink">{a.account_name}</div>
                  <div className="mt-0.5 text-xs text-muted-2">{a.institution_name}</div>
                </div>
                <span className={`font-serif text-[17px] tabular-nums ${a.current_balance < 0 || a.is_liability ? 'text-clay' : 'text-ink'}`}>
                  {formatWholeCurrency(a.is_liability ? -Math.abs(a.current_balance) : a.current_balance)}
                </span>
              </Row>
            ))}
            {topAccounts.length === 0 && (
              <div className="py-3 text-[13.5px] text-muted-2">
                No accounts yet.{' '}
                <button type="button" onClick={() => navigate('/settings')} className="text-muted underline hover:text-ink">
                  Connect one in Settings.
                </button>
              </div>
            )}
          </Card>
        </div>

        <div className="flex min-w-0 flex-col gap-5">
          {/* Upcoming bills */}
          <Card padding="lg">
            <SectionLabel className="mb-2">Upcoming bills · 14 days</SectionLabel>
            {upcomingBills.map((o, i) => (
              <Row
                key={o.id}
                onClick={() => navigate('/bills')}
                className={`justify-between px-1 py-3 ${i === upcomingBills.length - 1 ? 'border-b-0' : ''}`}
              >
                <div className="min-w-0">
                  <div className="truncate text-[14.5px] text-ink">{o.merchant_name}</div>
                  <div className="mt-0.5 text-xs text-muted-2">
                    {o.days_until <= 0 ? 'due today' : o.days_until === 1 ? 'in 1 day' : `in ${o.days_until} days`}
                  </div>
                </div>
                <span className="font-serif text-[17px] tabular-nums text-ink">{formatWholeCurrency(Math.abs(o.amount))}</span>
              </Row>
            ))}
            {upcomingBills.length === 0 && <div className="py-3 text-[13.5px] text-muted-2">Nothing due in the next two weeks.</div>}
          </Card>

          {/* Needs review */}
          <Card padding="lg" onClick={() => navigate('/transactions')}>
            <SectionLabel summary={reviewCount > 0 ? String(reviewCount) : undefined} className="mb-2">
              Needs review
            </SectionLabel>
            <p className="text-[14px] leading-relaxed text-ink-soft">
              {reviewCount === 0 ? 'All caught up.' : reviewSummaryLine(reviewSummary?.queues ?? [])}
            </p>
            {reviewCount > 0 && <div className="mt-2 text-[13px] text-muted">Review in Transactions →</div>}
          </Card>

          {/* Advisor suggestion */}
          {(draft || insight) && (
            <div className="rounded-xl border border-sage-panel-border bg-sage-panel p-[22px]">
              <div className="mb-2 text-[11px] uppercase tracking-[0.2em] text-sage-soft">Advisor</div>
              <p className="font-serif text-[18px] font-light leading-normal text-ink">
                {draft ? draft.summary : `${insight!.title}. ${insight!.message}`}
              </p>
              <div className="mt-3.5 flex items-center gap-5">
                {draft ? (
                  <>
                    <InkButton onClick={() => confirmDraft.mutate(draft)} disabled={confirmDraft.isPending}>
                      {draft.label}
                    </InkButton>
                    <TextButton onClick={() => navigate('/advisor')}>Ask advisor</TextButton>
                    <TextButton onClick={() => dismissDraft.mutate(draft.id)}>Dismiss</TextButton>
                  </>
                ) : (
                  <>
                    {insight!.action_route && (
                      <TextButton variant="primary" onClick={() => navigate(insight!.action_route!)}>
                        {insight!.action_label ?? 'Take a look'}
                      </TextButton>
                    )}
                    <TextButton onClick={() => navigate('/advisor')}>Ask advisor</TextButton>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </Screen>
  );
}
