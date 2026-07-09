import { useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format, differenceInCalendarDays, parseISO } from 'date-fns';
import type { AdvisorDraftAction, Insight } from '@shared/types';
import { aiApi, budgetsApi, goalsApi, insightsApi, networthApi, recurringApi, transactionsApi } from '../lib/api';
import { formatWholeCurrency } from '../lib/formatters';
import { computeSafeToSpend } from '../lib/safeToSpend';
import { useEasedValue } from '../lib/useEasedValue';
import { useAppStore } from '../store';
import { Screen, BalanceScale, TextButton } from '../components/balance';

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 5) return 'Up late.';
  if (hour < 12) return 'Good morning.';
  if (hour < 18) return 'Good afternoon.';
  return 'Good evening.';
}

function StatLink({ to, label, children }: { to: string; label: string; children: React.ReactNode }) {
  return (
    <Link to={to} className="group block">
      <div className="mb-1 text-xs text-muted transition-colors group-hover:text-ink">{label}</div>
      {children}
    </Link>
  );
}

export function Today() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const addToast = useAppStore((s) => s.addToast);
  const currentMonth = format(new Date(), 'yyyy-MM');

  const { data: snapshot } = useQuery({ queryKey: ['networth', 'snapshot'], queryFn: () => networthApi.snapshot(), retry: false });
  const { data: history } = useQuery({ queryKey: ['networth', 'history', 1], queryFn: () => networthApi.history(1), retry: false });
  const { data: reviewSummary } = useQuery({ queryKey: ['transactions', 'review'], queryFn: () => transactionsApi.review() });
  const { data: forecast } = useQuery({ queryKey: ['recurring', 'forecast', 30], queryFn: () => recurringApi.forecast(30) });
  const { data: budgets } = useQuery({ queryKey: ['budgets', currentMonth], queryFn: () => budgetsApi.getMonth(currentMonth) });
  const { data: goals } = useQuery({ queryKey: ['goals'], queryFn: () => goalsApi.list() });
  const { data: insights } = useQuery({ queryKey: ['insights'], queryFn: () => insightsApi.list() });

  const netWorth = snapshot?.net_worth ?? 0;
  const totalAssets = snapshot?.total_assets ?? 0;
  const totalLiabilities = snapshot?.total_liabilities ?? 0;
  const easedNetWorth = useEasedValue(netWorth, 900);

  const weekDelta = useMemo(() => {
    const snapshots = history ?? [];
    if (snapshots.length < 2) return null;
    const latest = snapshots[snapshots.length - 1];
    const weekAgo = [...snapshots]
      .reverse()
      .find((s) => differenceInCalendarDays(parseISO(latest.date), parseISO(s.date)) >= 7);
    return weekAgo ? latest.net_worth - weekAgo.net_worth : null;
  }, [history]);

  const reviewCount = reviewSummary?.total_open ?? 0;
  const overdueCount = forecast?.overdue_count ?? 0;
  const safeToSpend = computeSafeToSpend({ snapshot, forecast, budgets, goals });

  const nextBill = (forecast?.occurrences ?? []).find((o) => !o.is_income && o.adjustment_action !== 'skip');
  const topGoal = (goals ?? []).find((g) => !g.is_archived && g.target_amount > 0 && g.remaining_amount > 0);

  const statusLine =
    reviewCount > 0
      ? `${reviewCount} to review · ${overdueCount > 0 ? `${overdueCount} bill${overdueCount === 1 ? '' : 's'} overdue` : 'nothing urgent'} →`
      : overdueCount > 0
        ? `${overdueCount} bill${overdueCount === 1 ? '' : 's'} overdue →`
        : 'Nothing to review · all caught up →';

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
    <Screen size="wide">
      {/* Header: wordmark + date, search-or-ask */}
      <div className="flex flex-shrink-0 items-center justify-between gap-4">
        <div className="flex items-baseline gap-4">
          <span className="font-serif text-2xl text-ink">mizān</span>
          <span className="text-[13px] text-muted">{format(new Date(), 'EEEE, MMMM d')}</span>
        </div>
        <button
          type="button"
          onClick={() => window.dispatchEvent(new Event('mizan:open-palette'))}
          className="flex items-center gap-2.5 text-[13px] text-muted transition-colors hover:text-ink"
        >
          Search or ask
          <span className="font-mono text-[11px] text-faint">⌘K</span>
        </button>
      </div>

      {/* Greeting */}
      <div className="mt-7 flex-shrink-0">
        <div className="font-serif text-[30px] font-light text-ink">{greeting()}</div>
        <Link to="/transactions" className="mt-1.5 inline-block text-sm text-muted transition-colors hover:text-ink">
          {statusLine}
        </Link>
      </div>

      {/* Hero: scale + net worth + advisor */}
      <div className="my-3 flex min-h-0 flex-1 flex-col items-center gap-8 py-6 md:flex-row md:gap-12">
        <BalanceScale
          assets={totalAssets}
          liabilities={totalLiabilities}
          className="h-auto w-full max-w-[420px] flex-shrink md:w-[46%] md:max-w-[500px]"
        />
        <div className="min-w-0 flex-1">
          <div className="mb-2 text-xs uppercase tracking-[0.2em] text-muted">Net worth</div>
          <div
            className="font-serif font-light leading-[0.98] tracking-[-0.01em] text-ink tabular-nums"
            style={{ fontSize: 'clamp(44px, 5.6vw, 68px)' }}
          >
            {formatWholeCurrency(easedNetWorth)}
          </div>
          {weekDelta != null && (
            <div className={`mt-2.5 text-[15px] tabular-nums ${weekDelta >= 0 ? 'text-sage' : 'text-clay'}`}>
              {weekDelta >= 0 ? '▲' : '▼'} {formatWholeCurrency(Math.abs(weekDelta))} this week
            </div>
          )}

          {(draft || insight) && (
            <div className="mt-7 max-w-[420px] border-l-2 border-sage-soft pl-[18px]">
              <div className="mb-2 text-[11px] uppercase tracking-[0.2em] text-sage-soft">Advisor</div>
              <p className="font-serif text-[19px] font-light leading-normal text-ink">
                {draft ? draft.summary : `${insight!.title}. ${insight!.message}`}
              </p>
              <div className="mt-3.5 flex items-center gap-5 text-sm">
                {draft ? (
                  <>
                    <TextButton variant="primary" onClick={() => confirmDraft.mutate(draft)} disabled={confirmDraft.isPending}>
                      {draft.label}
                    </TextButton>
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

      {/* Stat strip */}
      <div className="flex flex-shrink-0 flex-wrap gap-x-16 gap-y-5 border-t border-line-2 pt-6">
        <StatLink to="/budget" label="Safe to spend">
          <div className="font-serif text-[22px] leading-tight text-ink tabular-nums">{formatWholeCurrency(safeToSpend)}</div>
        </StatLink>
        {nextBill && (
          <StatLink to="/bills" label="Next bill">
            <div className="mt-[5px] text-base text-ink">
              {nextBill.merchant_name} ·{' '}
              {nextBill.days_until <= 0 ? 'due today' : nextBill.days_until === 1 ? 'in 1 day' : `in ${nextBill.days_until} days`} ·{' '}
              <span className="tabular-nums">{formatWholeCurrency(Math.abs(nextBill.adjusted_amount ?? nextBill.amount))}</span>
            </div>
          </StatLink>
        )}
        {topGoal && (
          <StatLink to="/goals" label={topGoal.name}>
            <div className="mt-[5px] text-base text-ink">
              {Math.round(Math.min(100, Math.max(0, topGoal.progress_percent)))}% of{' '}
              <span className="tabular-nums">{formatWholeCurrency(topGoal.target_amount)}</span>
            </div>
          </StatLink>
        )}
        <StatLink to="/transactions" label="To review">
          <div className="font-serif text-[22px] leading-tight text-ink tabular-nums">{reviewCount}</div>
        </StatLink>
      </div>
    </Screen>
  );
}
