import { useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format, differenceInCalendarDays, parseISO } from 'date-fns';
import type { AdvisorDraftAction, Insight } from '@shared/types';
import { aiApi, budgetsApi, goalsApi, insightsApi, networthApi, recurringApi, transactionsApi } from '../lib/api';
import { computeSafeToSpend } from '../lib/safeToSpend';
import { buildLetter, type LetterParagraph, type LetterToken } from '../lib/letter';
import { useAppStore } from '../store';
import { QueryErrorBanner } from '../components/QueryErrorBanner';
import { Screen, BalanceScale } from '../components/balance';

/** A figure, set apart from the prose so the eye can find it without leaving the sentence. */
function Figure({ children }: { children: React.ReactNode }) {
  return <span className="font-serif font-medium tabular-nums text-ink">{children}</span>;
}

function renderToken(token: LetterToken, i: number) {
  if (token.kind === 'figure') return <Figure key={i}>{token.value}</Figure>;
  if (token.kind === 'action') {
    return (
      <Link
        key={i}
        to={token.to}
        className="border-b border-line-3 pb-px text-ink transition-colors hover:border-ink"
      >
        {token.value}
      </Link>
    );
  }
  return <span key={i}>{token.value}</span>;
}

function Paragraph({ paragraph, lead }: { paragraph: LetterParagraph; lead?: boolean }) {
  const size = lead ? 'text-[25px] leading-[1.5]' : 'text-[17px] leading-[1.72]';
  const tone = paragraph.muted ? 'text-muted' : 'text-ink-soft';
  return <p className={`font-serif ${size} ${tone}`}>{paragraph.tokens.map(renderToken)}</p>;
}

/** Underlined verb inside a sentence. The letter is answerable, not just readable. */
function Verb({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="border-b border-line-3 pb-px text-ink transition-colors hover:border-ink disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function LetterSkeleton() {
  return (
    <div className="space-y-5" aria-hidden>
      {[92, 78, 64, 84].map((w, i) => (
        <div key={i} className="h-[13px] rounded bg-line" style={{ width: `${w}%` }} />
      ))}
    </div>
  );
}

export function Today() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const addToast = useAppStore((s) => s.addToast);
  const currentMonth = format(new Date(), 'yyyy-MM');

  const snapshotQ = useQuery({ queryKey: ['networth', 'snapshot'], queryFn: () => networthApi.snapshot(), retry: false });
  // Twelve months, not one: the closing footnote needs to know where reconstruction ends.
  const historyQ = useQuery({ queryKey: ['networth', 'history', 12], queryFn: () => networthApi.history(12), retry: false });
  const reviewQ = useQuery({ queryKey: ['transactions', 'review'], queryFn: () => transactionsApi.review() });
  const forecastQ = useQuery({ queryKey: ['recurring', 'forecast', 30], queryFn: () => recurringApi.forecast(30) });
  const budgetsQ = useQuery({ queryKey: ['budgets', currentMonth], queryFn: () => budgetsApi.getMonth(currentMonth) });
  const goalsQ = useQuery({ queryKey: ['goals'], queryFn: () => goalsApi.list() });
  const insightsQ = useQuery({ queryKey: ['insights'], queryFn: () => insightsApi.list() });
  const aiActionsQ = useQuery({ queryKey: ['ai-actions'], queryFn: () => aiApi.listActions(), retry: false });

  const snapshot = snapshotQ.data;
  const history = historyQ.data;
  const reviewSummary = reviewQ.data;
  const forecast = forecastQ.data;

  // Without this every failure below renders as prose rather than as an empty state, which is
  // worse: "$0" merely looks empty, "You have $0.00 this afternoon" sounds certain.
  const failableQueries = [
    { query: snapshotQ, label: 'net worth' },
    { query: historyQ, label: 'net worth history' },
    { query: reviewQ, label: 'review queue' },
    { query: forecastQ, label: 'upcoming bills' },
    { query: budgetsQ, label: 'budgets' },
    { query: goalsQ, label: 'goals' },
    { query: insightsQ, label: 'insights' },
  ];

  const weekDelta = useMemo(() => {
    const snapshots = history ?? [];
    if (snapshots.length < 2) return null;
    const latest = snapshots[snapshots.length - 1];
    const weekAgo = [...snapshots]
      .reverse()
      .find((s) => differenceInCalendarDays(parseISO(latest.date), parseISO(s.date)) >= 7);
    return weekAgo ? latest.net_worth - weekAgo.net_worth : null;
  }, [history]);

  const bills = (forecast?.occurrences ?? []).filter((o) => !o.is_income && o.adjustment_action !== 'skip');
  // Split, because taking the first occurrence and calling it "next" labels a bill that was due
  // last week as though it were still ahead of you.
  const oldestOverdue = bills.find((o) => o.status === 'overdue') ?? null;
  const nextBill = bills.find((o) => o.status !== 'overdue') ?? null;
  const toLetterBill = (o: typeof bills[number]) => ({
    pattern_id: o.pattern_id,
    merchant_name: o.merchant_name,
    expected_date: o.expected_date,
    amount: o.adjusted_amount ?? o.amount,
    amount_varies: o.amount_varies,
  });

  const topGoal = (goalsQ.data ?? []).find((g) => !g.is_archived && g.target_amount > 0 && g.remaining_amount > 0);
  const recentAiCount = (aiActionsQ.data ?? []).filter(
    (a) => differenceInCalendarDays(new Date(), parseISO(a.created_at)) <= 1
  ).length;

  const paragraphs = buildLetter({
    now: new Date(),
    netWorth: snapshot ? snapshot.net_worth : null,
    owed: snapshot ? snapshot.total_liabilities : null,
    weekDelta,
    reviewCount: reviewSummary ? reviewSummary.total_open : null,
    overdueCount: forecast?.overdue_count ?? 0,
    oldestOverdue: oldestOverdue ? toLetterBill(oldestOverdue) : null,
    nextBill: nextBill ? toLetterBill(nextBill) : null,
    safeToSpend: snapshot
      ? computeSafeToSpend({ snapshot, forecast, budgets: budgetsQ.data, goals: goalsQ.data })
      : null,
    topGoal: topGoal ? { name: topGoal.name, remaining_amount: topGoal.remaining_amount } : null,
    recentAiCount,
    measuredFrom: (history ?? []).find((s) => !s.is_estimated)?.date ?? null,
  });

  const substance = paragraphs.filter((p) => !p.muted);
  const closing = paragraphs.filter((p) => p.muted);

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

  const stillLoading = snapshotQ.isLoading || reviewQ.isLoading || forecastQ.isLoading;

  return (
    <Screen size="wide">
      <header className="flex flex-shrink-0 items-baseline justify-between gap-4 border-b border-line-2 pb-4">
        <div className="flex items-baseline gap-4">
          <span className="font-serif text-[21px] text-ink">mizān</span>
          <span className="text-[12px] uppercase tracking-[0.09em] text-muted">
            {format(new Date(), 'EEEE, d MMMM')}
          </span>
        </div>
        <button
          type="button"
          onClick={() => window.dispatchEvent(new Event('mizan:open-palette'))}
          className="flex items-center gap-2.5 text-[13px] text-muted transition-colors hover:text-ink"
        >
          Search or ask
          <span className="font-mono text-[11px] text-faint">⌘K</span>
        </button>
      </header>

      <QueryErrorBanner items={failableQueries} className="mt-6" />

      {/* Reversed while stacked: with no margin to sit in, the plate leads rather than stranding
          itself below a letter it is supposed to illustrate. */}
      <div className="mt-12 flex flex-col-reverse gap-12 lg:mt-12 lg:flex-row lg:items-start lg:gap-20">
        <div className="min-w-0 max-w-[34em] flex-1 space-y-[26px]">
          {stillLoading ? (
            <LetterSkeleton />
          ) : (
            substance.map((p, i) => <Paragraph key={p.id} paragraph={p} lead={i === 0 && p.id === 'standing'} />)
          )}

          {!stillLoading && draft && (
            <p className="font-serif text-[17px] leading-[1.72] text-ink-soft">
              {draft.summary}{' '}
              <Verb onClick={() => confirmDraft.mutate(draft)} disabled={confirmDraft.isPending}>
                {draft.label}
              </Verb>
              , or <Verb onClick={() => dismissDraft.mutate(draft.id)}>leave it</Verb>.
            </p>
          )}

          {!stillLoading && !draft && insight && (
            <p className="font-serif text-[17px] leading-[1.72] text-ink-soft">
              {insight.title}. {insight.message}
              {insight.action_route && (
                <>
                  {' '}
                  <Verb onClick={() => navigate(insight.action_route!)}>
                    {insight.action_label ?? 'Take a look'}
                  </Verb>
                  .
                </>
              )}
            </p>
          )}

          {/* Provenance and the measurement footnote close the letter, after anything it is
              asking you to decide. */}
          {!stillLoading && closing.map((p) => <Paragraph key={p.id} paragraph={p} />)}
        </div>

        {/* The plate in the margin. The letter states both figures, so the scale carries the
            shape of the thing rather than repeating the numbers. */}
        <div className="flex flex-shrink-0 justify-center lg:w-[320px] lg:pt-2">
          <BalanceScale
            assets={snapshot?.total_assets ?? 0}
            liabilities={snapshot?.total_liabilities ?? 0}
            className="h-auto w-full max-w-[260px] lg:max-w-[320px]"
          />
        </div>
      </div>
    </Screen>
  );
}
