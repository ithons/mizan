import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  ArrowDownCircle,
  ArrowUpCircle,
  Ban,
  CalendarDays,
  CalendarClock,
  CheckCircle2,
  Clock3,
  CircleAlert,
  Pencil,
  RefreshCw,
  RotateCcw,
  Sparkles,
  TrendingUp,
  Wallet,
  XCircle,
} from 'lucide-react';
import { addDays, format, parseISO } from 'date-fns';
import type { Account, RecurringForecast, RecurringForecastOccurrence, SubscriptionInsights } from '@shared/types';
import { accountsApi, recurringApi } from '../lib/api';
import { advisorRouteState } from '../lib/advisorRouteState';
import {
  buildRecurringForecastAdvisorPrompt,
  buildRecurringOccurrenceAdvisorPrompt,
} from '../lib/advisorPrompts';
import { formatCurrency, formatDate } from '../lib/formatters';
import { PageLoader } from '../components/LoadingSpinner';
import { EmptyState } from '../components/EmptyState';
import { Modal } from '../components/Modal';
import { invalidateFinancialData } from '../lib/queryInvalidation';
import { parseDecimalInput } from '../lib/numberInput';
import { useAppStore } from '../store';

const FREQUENCY_LABELS: Record<RecurringForecastOccurrence['frequency'], string> = {
  weekly: 'Weekly',
  biweekly: 'Biweekly',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  annual: 'Annual',
};

const LIQUID_ACCOUNT_TYPES = new Set(['checking', 'savings', 'cash']);
const confidenceTone: Record<RecurringForecastOccurrence['confidence_label'], { text: string; border: string }> = {
  confirmed: { text: 'text-green', border: 'border-green/40' },
  likely: { text: 'text-blue', border: 'border-blue/40' },
  uncertain: { text: 'text-amber', border: 'border-amber/40' },
};

interface ProjectionPoint {
  date: string;
  delta: number;
  balance: number;
}

type AdjustmentMode = 'snooze' | 'adjust';

interface AdjustmentDraft {
  occurrence: RecurringForecastOccurrence;
  mode: AdjustmentMode;
  dateValue: string;
  amountValue: string;
  note: string;
}

function originalOccurrenceDate(occurrence: RecurringForecastOccurrence): string {
  return occurrence.original_expected_date ?? occurrence.expected_date;
}

function isLiquidAccount(account: Account): boolean {
  return !account.is_hidden && !account.is_liability && LIQUID_ACCOUNT_TYPES.has(account.type);
}

function buildProjection(
  startingBalance: number,
  occurrences: RecurringForecastOccurrence[]
): ProjectionPoint[] {
  const deltaByDate = new Map<string, number>();
  const today = format(new Date(), 'yyyy-MM-dd');

  for (const occurrence of occurrences) {
    const projectionDate = occurrence.status === 'overdue' ? today : occurrence.expected_date;
    deltaByDate.set(
      projectionDate,
      (deltaByDate.get(projectionDate) ?? 0) + occurrence.amount
    );
  }

  let balance = startingBalance;
  return Array.from(deltaByDate.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, delta]) => {
      balance += delta;
      return { date, delta, balance };
    });
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'income' | 'bill' | 'net';
}) {
  const valueClass = tone === 'bill' ? 'text-rose' : value >= 0 ? 'text-green' : 'text-rose';

  return (
    <div className="border border-border bg-surface rounded p-4">
      <p className="text-xs text-muted mb-1">{label}</p>
      <p className={`font-mono text-xl ${valueClass}`}>
        {formatCurrency(value)}
      </p>
    </div>
  );
}

function SubscriptionInsightPanel({ insights }: { insights: SubscriptionInsights }) {
  return (
    <div className="border border-border bg-surface rounded p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between mb-4">
        <div>
          <h2 className="text-sm font-medium text-text">Subscriptions</h2>
          <p className="text-xs text-muted mt-1">{insights.subscription_count} recurring bills</p>
        </div>
        <span className="text-xs text-muted font-mono">{insights.days} days</span>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div>
          <p className="text-xs text-muted mb-1">Monthly</p>
          <p className="font-mono text-lg text-text">{formatCurrency(insights.total_monthly_amount)}</p>
        </div>
        <div>
          <p className="text-xs text-muted mb-1">Upcoming</p>
          <p className="font-mono text-lg text-rose">{formatCurrency(insights.total_upcoming_amount)}</p>
        </div>
        <div>
          <p className="text-xs text-muted mb-1">Increases</p>
          <p className="font-mono text-lg text-amber">{insights.increase_count}</p>
        </div>
        <div>
          <p className="text-xs text-muted mb-1">Needs review</p>
          <p className="font-mono text-lg text-blue">{insights.unconfirmed_count}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-3 mt-4">
        <div className="border border-border rounded bg-background/40">
          <div className="px-3 py-2 border-b border-border flex items-center gap-2">
            <TrendingUp size={13} className="text-amber" />
            <p className="text-xs font-medium text-text">Price increases</p>
          </div>
          {insights.increases.length > 0 ? (
            <div className="divide-y divide-border">
              {insights.increases.slice(0, 3).map((item) => (
                <div key={item.pattern_id} className="px-3 py-2 text-xs flex items-center justify-between gap-3">
                  <span className="text-text truncate">{item.merchant_name}</span>
                  <span className="font-mono text-amber flex-shrink-0">
                    +{formatCurrency(item.increase_amount ?? 0)}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="px-3 py-5 text-xs text-muted">No increases detected</div>
          )}
        </div>

        <div className="border border-border rounded bg-background/40">
          <div className="px-3 py-2 border-b border-border flex items-center gap-2">
            <CircleAlert size={13} className="text-blue" />
            <p className="text-xs font-medium text-text">Needs review</p>
          </div>
          {insights.unconfirmed.length > 0 ? (
            <div className="divide-y divide-border">
              {insights.unconfirmed.slice(0, 3).map((item) => (
                <div key={item.pattern_id} className="px-3 py-2 text-xs flex items-center justify-between gap-3">
                  <span className="text-text truncate">{item.merchant_name}</span>
                  <span className="font-mono text-muted flex-shrink-0">{Math.round(item.confidence * 100)}%</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="px-3 py-5 text-xs text-muted">All subscriptions confirmed</div>
          )}
        </div>

        <div className="border border-border rounded bg-background/40">
          <div className="px-3 py-2 border-b border-border flex items-center gap-2">
            <CalendarDays size={13} className="text-green" />
            <p className="text-xs font-medium text-text">Upcoming renewals</p>
          </div>
          {insights.upcoming.length > 0 ? (
            <div className="divide-y divide-border">
              {insights.upcoming.slice(0, 3).map((item) => (
                <div key={item.pattern_id} className="px-3 py-2 text-xs flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-text truncate">{item.merchant_name}</p>
                    <p className="text-[11px] text-muted">
                      {formatDate(item.next_expected)} · {FREQUENCY_LABELS[item.frequency]}
                    </p>
                  </div>
                  <span className="font-mono text-rose flex-shrink-0">{formatCurrency(item.average_amount)}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="px-3 py-5 text-xs text-muted">No renewals in this window</div>
          )}
        </div>
      </div>
    </div>
  );
}

function AdjustmentModal({
  draft,
  isSaving,
  onChange,
  onClose,
  onSubmit,
}: {
  draft: AdjustmentDraft | null;
  isSaving: boolean;
  onChange: (draft: AdjustmentDraft) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  if (!draft) return null;

  const isSnooze = draft.mode === 'snooze';
  const title = isSnooze ? 'Snooze Occurrence' : 'Adjust Amount';

  return (
    <Modal open={Boolean(draft)} onClose={onClose} title={title}>
      <div className="space-y-4">
        <div className="border border-border rounded bg-background/50 px-3 py-2">
          <p className="text-sm text-text">{draft.occurrence.merchant_name}</p>
          <p className="text-xs text-muted mt-1">
            {formatDate(originalOccurrenceDate(draft.occurrence))} · {formatCurrency(draft.occurrence.amount)}
          </p>
        </div>

        {isSnooze ? (
          <label className="block">
            <span className="text-xs text-muted">New expected date</span>
            <input
              type="date"
              className="mt-1 w-full rounded border border-border bg-surface px-3 py-2 text-sm text-text"
              value={draft.dateValue}
              onChange={(event) => onChange({ ...draft, dateValue: event.target.value })}
            />
          </label>
        ) : (
          <label className="block">
            <span className="text-xs text-muted">One-time amount</span>
            <input
              type="text"
              inputMode="decimal"
              className="mt-1 w-full rounded border border-border bg-surface px-3 py-2 text-sm text-text font-mono"
              value={draft.amountValue}
              onChange={(event) => onChange({ ...draft, amountValue: event.target.value })}
            />
          </label>
        )}

        <label className="block">
          <span className="text-xs text-muted">Note</span>
          <input
            type="text"
            className="mt-1 w-full rounded border border-border bg-surface px-3 py-2 text-sm text-text"
            value={draft.note}
            onChange={(event) => onChange({ ...draft, note: event.target.value })}
            placeholder="Optional"
          />
        </label>

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            className="rounded border border-border px-3 py-1.5 text-xs text-muted hover:text-text"
            onClick={onClose}
            disabled={isSaving}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded bg-green px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
            onClick={onSubmit}
            disabled={isSaving}
          >
            Save
          </button>
        </div>
      </div>
    </Modal>
  );
}

function ScheduleRow({
  occurrence,
  isMutating,
  onConfirm,
  onDismiss,
  onAsk,
  onSkip,
  onSnooze,
  onAdjust,
  onRevert,
}: {
  occurrence: RecurringForecastOccurrence;
  isMutating: boolean;
  onConfirm: (patternId: string) => void;
  onDismiss: (patternId: string) => void;
  onAsk: (occurrence: RecurringForecastOccurrence) => void;
  onSkip: (occurrence: RecurringForecastOccurrence) => void;
  onSnooze: (occurrence: RecurringForecastOccurrence) => void;
  onAdjust: (occurrence: RecurringForecastOccurrence) => void;
  onRevert: (occurrence: RecurringForecastOccurrence) => void;
}) {
  const Icon = occurrence.is_income ? ArrowUpCircle : ArrowDownCircle;
  const amountClass = occurrence.is_income ? 'text-green' : 'text-rose';
  const confidenceClass = confidenceTone[occurrence.confidence_label];
  const needsAction = occurrence.needs_review || occurrence.status === 'overdue';
  const hasAdjustment = Boolean(occurrence.adjustment_id);

  return (
    <div className="grid grid-cols-[120px_1fr_auto] gap-4 px-4 py-3 border-b border-border last:border-b-0 items-center">
      <div className="font-mono text-xs text-muted whitespace-nowrap">
        {formatDate(occurrence.expected_date)}
      </div>
      <div className="flex items-center gap-3 min-w-0">
        <Icon size={16} className={`flex-shrink-0 ${amountClass}`} />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm text-text truncate">{occurrence.merchant_name}</p>
            {occurrence.status === 'overdue' && (
              <span className="text-[10px] text-rose border border-rose/40 rounded px-1.5 py-0.5">
                overdue
              </span>
            )}
            {!occurrence.is_confirmed && (
              <span
                className={`text-[10px] border rounded px-1.5 py-0.5 ${confidenceClass.text} ${confidenceClass.border}`}
              >
                {occurrence.confidence_label}
              </span>
            )}
            {hasAdjustment && (
              <span className="text-[10px] text-blue border border-blue/40 rounded px-1.5 py-0.5">
                adjusted
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 text-xs text-muted mt-0.5">
            <span>{FREQUENCY_LABELS[occurrence.frequency]}</span>
            <span>·</span>
            <span>{Math.round(occurrence.confidence * 100)}%</span>
            {occurrence.original_expected_date && occurrence.original_expected_date !== occurrence.expected_date && (
              <>
                <span>·</span>
                <span>from {formatDate(occurrence.original_expected_date)}</span>
              </>
            )}
            {occurrence.category_name && (
              <>
                <span>·</span>
                <span>{occurrence.category_name}</span>
              </>
            )}
          </div>
        </div>
      </div>
      <div className="flex items-center justify-end gap-2">
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="p-1 text-muted hover:text-amber disabled:opacity-30"
            onClick={() => onSkip(occurrence)}
            disabled={isMutating}
            title="Skip once"
          >
            <Ban size={13} />
          </button>
          <button
            type="button"
            className="p-1 text-muted hover:text-blue disabled:opacity-30"
            onClick={() => onSnooze(occurrence)}
            disabled={isMutating}
            title="Snooze once"
          >
            <CalendarClock size={13} />
          </button>
          <button
            type="button"
            className="p-1 text-muted hover:text-green disabled:opacity-30"
            onClick={() => onAdjust(occurrence)}
            disabled={isMutating}
            title="Adjust amount once"
          >
            <Pencil size={13} />
          </button>
          {occurrence.adjustment_id && (
            <button
              type="button"
              className="p-1 text-muted hover:text-rose disabled:opacity-30"
              onClick={() => onRevert(occurrence)}
              disabled={isMutating}
              title="Revert adjustment"
            >
              <RotateCcw size={13} />
            </button>
          )}
        </div>
        <button
          type="button"
          className="p-1 text-muted hover:text-green"
          onClick={() => onAsk(occurrence)}
          title="Ask advisor"
        >
          <Sparkles size={13} />
        </button>
        <p className={`font-mono text-sm text-right ${amountClass}`}>
          {formatCurrency(occurrence.amount)}
        </p>
        {needsAction && (
          <div className="flex items-center gap-1">
            {!occurrence.is_confirmed && (
              <button
                className="p-1 text-muted hover:text-green disabled:opacity-30"
                onClick={() => onConfirm(occurrence.pattern_id)}
                disabled={isMutating}
                title="Confirm recurring pattern"
              >
                <CheckCircle2 size={13} />
              </button>
            )}
            <button
              className="p-1 text-muted hover:text-rose disabled:opacity-30"
              onClick={() => onDismiss(occurrence.pattern_id)}
              disabled={isMutating}
              title="Dismiss recurring pattern"
            >
              <XCircle size={13} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export function Bills() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { addToast } = useAppStore();
  const [days, setDays] = useState(60);
  const [adjustmentDraft, setAdjustmentDraft] = useState<AdjustmentDraft | null>(null);

  const { data: forecast, isLoading } = useQuery({
    queryKey: ['recurring', 'forecast', days],
    queryFn: () => recurringApi.forecast(days),
  });

  const { data: subscriptionInsights } = useQuery({
    queryKey: ['recurring', 'subscriptions', days],
    queryFn: () => recurringApi.subscriptions(days),
  });

  const { data: accounts = [] } = useQuery({
    queryKey: ['accounts'],
    queryFn: accountsApi.list,
  });

  const confirmMutation = useMutation({
    mutationFn: (patternId: string) => recurringApi.confirm(patternId),
    onSuccess: () => {
      invalidateFinancialData(qc);
      addToast({ type: 'success', message: 'Recurring pattern confirmed' });
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const dismissMutation = useMutation({
    mutationFn: (patternId: string) => recurringApi.dismiss(patternId),
    onSuccess: () => {
      invalidateFinancialData(qc);
      addToast({ type: 'success', message: 'Recurring pattern dismissed' });
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const adjustmentMutation = useMutation({
    mutationFn: (params: {
      patternId: string;
      body: Parameters<typeof recurringApi.upsertAdjustment>[1];
    }) => recurringApi.upsertAdjustment(params.patternId, params.body),
    onSuccess: (_data, variables) => {
      invalidateFinancialData(qc);
      setAdjustmentDraft(null);
      const action = variables.body.action === 'skip'
        ? 'skipped'
        : variables.body.action === 'snooze'
          ? 'snoozed'
          : 'adjusted';
      addToast({ type: 'success', message: `Occurrence ${action}` });
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const deleteAdjustmentMutation = useMutation({
    mutationFn: (params: { patternId: string; adjustmentId: string }) =>
      recurringApi.deleteAdjustment(params.patternId, params.adjustmentId),
    onSuccess: () => {
      invalidateFinancialData(qc);
      addToast({ type: 'success', message: 'Occurrence adjustment reverted' });
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const occurrences = forecast?.occurrences ?? [];
  const confirmedCount = occurrences.filter((occurrence) => occurrence.is_confirmed).length;
  const likelyCount = occurrences.filter((occurrence) => occurrence.confidence_label === 'likely').length;
  const reviewCount = forecast?.review_count ?? 0;
  const liquidAccounts = accounts.filter(isLiquidAccount);
  const startingBalance = liquidAccounts.reduce((sum, account) => sum + account.current_balance, 0);
  const projection = useMemo(
    () => buildProjection(startingBalance, occurrences),
    [occurrences, startingBalance]
  );
  const endingBalance = projection.at(-1)?.balance ?? startingBalance;
  const lowestPoint = projection.reduce<ProjectionPoint | null>(
    (lowest, point) => (!lowest || point.balance < lowest.balance ? point : lowest),
    null
  );
  const lowestBalance = lowestPoint?.balance ?? startingBalance;
  const askAdvisorAboutForecast = (currentForecast: RecurringForecast) => {
    navigate('/advisor', {
      state: advisorRouteState(buildRecurringForecastAdvisorPrompt(currentForecast, {
        startingBalance,
        endingBalance,
        lowestBalance,
        lowestDate: lowestPoint?.date ?? null,
        liquidAccountCount: liquidAccounts.length,
      })),
    });
  };
  const askAdvisorAboutOccurrence = (occurrence: RecurringForecastOccurrence) => {
    navigate('/advisor', {
      state: advisorRouteState(buildRecurringOccurrenceAdvisorPrompt(occurrence)),
    });
  };
  const skipOccurrence = (occurrence: RecurringForecastOccurrence) => {
    adjustmentMutation.mutate({
      patternId: occurrence.pattern_id,
      body: {
        original_date: originalOccurrenceDate(occurrence),
        action: 'skip',
      },
    });
  };
  const snoozeOccurrence = (occurrence: RecurringForecastOccurrence) => {
    setAdjustmentDraft({
      occurrence,
      mode: 'snooze',
      dateValue: format(addDays(parseISO(occurrence.expected_date), 1), 'yyyy-MM-dd'),
      amountValue: '',
      note: occurrence.adjustment_note ?? '',
    });
  };
  const adjustOccurrence = (occurrence: RecurringForecastOccurrence) => {
    setAdjustmentDraft({
      occurrence,
      mode: 'adjust',
      dateValue: '',
      amountValue: Math.abs(occurrence.amount).toFixed(2),
      note: occurrence.adjustment_note ?? '',
    });
  };
  const revertOccurrenceAdjustment = (occurrence: RecurringForecastOccurrence) => {
    if (!occurrence.adjustment_id) return;
    deleteAdjustmentMutation.mutate({
      patternId: occurrence.pattern_id,
      adjustmentId: occurrence.adjustment_id,
    });
  };
  const submitAdjustmentDraft = () => {
    if (!adjustmentDraft) return;

    if (adjustmentDraft.mode === 'snooze') {
      adjustmentMutation.mutate({
        patternId: adjustmentDraft.occurrence.pattern_id,
        body: {
          original_date: originalOccurrenceDate(adjustmentDraft.occurrence),
          action: 'snooze',
          adjusted_date: adjustmentDraft.dateValue,
          note: adjustmentDraft.note || null,
        },
      });
      return;
    }

    const parsed = parseDecimalInput(adjustmentDraft.amountValue);
    if (parsed === null) {
      addToast({ type: 'error', message: 'Enter a valid amount' });
      return;
    }
    const adjustedAmount = adjustmentDraft.occurrence.amount < 0
      ? -Math.abs(parsed)
      : Math.abs(parsed);
    adjustmentMutation.mutate({
      patternId: adjustmentDraft.occurrence.pattern_id,
      body: {
        original_date: originalOccurrenceDate(adjustmentDraft.occurrence),
        action: 'adjust',
        adjusted_amount: adjustedAmount,
        note: adjustmentDraft.note || null,
      },
    });
  };

  const nextOccurrence = occurrences[0];
  const grouped = useMemo(() => {
    const groups = new Map<string, RecurringForecastOccurrence[]>();
    for (const occurrence of occurrences) {
      const items = groups.get(occurrence.expected_date) ?? [];
      items.push(occurrence);
      groups.set(occurrence.expected_date, items);
    }
    return Array.from(groups.entries());
  }, [occurrences]);

  if (isLoading) return <PageLoader />;

  const isScheduleMutating = confirmMutation.isPending
    || dismissMutation.isPending
    || adjustmentMutation.isPending
    || deleteAdjustmentMutation.isPending;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text">Bills and Income</h1>
          <p className="text-xs text-muted mt-1">
            {nextOccurrence
              ? `Next: ${nextOccurrence.merchant_name} on ${formatDate(nextOccurrence.expected_date)}`
              : 'No upcoming recurring activity'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {forecast && (
            <button
              type="button"
              className="text-xs border border-border rounded px-3 py-1.5 text-muted hover:text-green flex items-center gap-1"
              onClick={() => askAdvisorAboutForecast(forecast)}
            >
              <Sparkles size={13} />
              Ask advisor
            </button>
          )}
          {[30, 60, 90].map((option) => (
            <button
              key={option}
              className={`text-xs border rounded px-3 py-1.5 ${
                days === option
                  ? 'border-green-50 bg-green-10 text-green'
                  : 'border-border text-muted hover:text-text'
              }`}
              onClick={() => setDays(option)}
            >
              {option}d
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Stat label="Incoming" value={forecast?.income ?? 0} tone="income" />
        <Stat label="Bills" value={-(forecast?.bills ?? 0)} tone="bill" />
        <Stat label="Net Impact" value={forecast?.net ?? 0} tone="net" />
      </div>

      {subscriptionInsights && (
        <SubscriptionInsightPanel insights={subscriptionInsights} />
      )}

      {reviewCount > 0 && (
        <div className="border border-amber/30 bg-amber/10 rounded p-4 flex items-start gap-3">
          <CircleAlert size={16} className="text-amber flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm text-text mb-1">Cash flow needs review</p>
            <p className="text-xs text-muted leading-relaxed">
              {forecast?.overdue_count ?? 0} overdue and {reviewCount} recurring items need review before this projection is fully reliable.
            </p>
          </div>
        </div>
      )}

      <div className="border border-border bg-surface rounded p-4">
        <div className="flex items-center justify-between gap-3 mb-4">
          <div>
            <h2 className="text-sm font-medium text-text">Cash Projection</h2>
            <p className="text-xs text-muted mt-1">
              {liquidAccounts.length} liquid {liquidAccounts.length === 1 ? 'account' : 'accounts'}
            </p>
          </div>
          <Wallet size={18} className="text-blue" />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
          <div>
            <p className="text-xs text-muted mb-1">Starting Cash</p>
            <p className="font-mono text-lg text-text">{formatCurrency(startingBalance)}</p>
          </div>
          <div>
            <p className="text-xs text-muted mb-1">Lowest Point</p>
            <p className={`font-mono text-lg ${lowestBalance >= 0 ? 'text-green' : 'text-rose'}`}>
              {formatCurrency(lowestBalance)}
            </p>
            {lowestPoint && (
              <p className="text-xs text-muted mt-0.5">{formatDate(lowestPoint.date)}</p>
            )}
          </div>
          <div>
            <p className="text-xs text-muted mb-1">Projected Ending</p>
            <p className={`font-mono text-lg ${endingBalance >= startingBalance ? 'text-green' : 'text-rose'}`}>
              {formatCurrency(endingBalance)}
            </p>
          </div>
        </div>
        {projection.length > 0 && (
          <div className="divide-y divide-border border border-border rounded bg-background">
            {projection.slice(0, 5).map((point) => (
              <div key={point.date} className="grid grid-cols-[120px_1fr_auto] gap-3 px-3 py-2 text-xs items-center">
                <span className="font-mono text-muted">{formatDate(point.date)}</span>
                <span className={point.delta >= 0 ? 'text-green' : 'text-rose'}>
                  {formatCurrency(point.delta, { showSign: true })}
                </span>
                <span className="font-mono text-text">{formatCurrency(point.balance)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="border border-border bg-surface rounded p-4 flex items-center gap-3">
          <CalendarDays size={18} className="text-blue" />
          <div>
            <p className="text-xs text-muted">Scheduled</p>
            <p className="font-mono text-lg text-text">{occurrences.length}</p>
          </div>
        </div>
        <div className="border border-border bg-surface rounded p-4 flex items-center gap-3">
          <CheckCircle2 size={18} className="text-green" />
          <div>
            <p className="text-xs text-muted">Confirmed</p>
            <p className="font-mono text-lg text-text">{confirmedCount}</p>
            <p className="text-[11px] text-muted">
              {formatCurrency((forecast?.confirmed_income ?? 0) - (forecast?.confirmed_bills ?? 0))}
            </p>
          </div>
        </div>
        <div className="border border-border bg-surface rounded p-4 flex items-center gap-3">
          <Clock3 size={18} className="text-blue" />
          <div>
            <p className="text-xs text-muted">Likely</p>
            <p className="font-mono text-lg text-text">{likelyCount}</p>
            <p className="text-[11px] text-muted">
              {formatCurrency((forecast?.likely_income ?? 0) - (forecast?.likely_bills ?? 0))}
            </p>
          </div>
        </div>
      </div>

      <div className="border border-border bg-surface rounded overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-sm font-medium text-text">Upcoming Schedule</h2>
          <span className="text-xs text-muted font-mono">{days} days</span>
        </div>
        {occurrences.length === 0 ? (
          <EmptyState
            icon={RefreshCw}
            title="No recurring activity scheduled"
            description="Confirm recurring candidates from review, or inspect transactions for missing bills and income."
            action={() => navigate('/review?queue=recurring_candidates')}
            actionLabel="Review Candidates"
            secondaryAction={() => navigate('/transactions')}
            secondaryActionLabel="View Transactions"
          />
        ) : (
          <div>
            {grouped.map(([date, items]) => (
              <div key={date}>
                {items.map((occurrence) => (
                  <ScheduleRow
                    key={occurrence.id}
                    occurrence={occurrence}
                    isMutating={isScheduleMutating}
                    onConfirm={(patternId) => confirmMutation.mutate(patternId)}
                    onDismiss={(patternId) => dismissMutation.mutate(patternId)}
                    onAsk={askAdvisorAboutOccurrence}
                    onSkip={skipOccurrence}
                    onSnooze={snoozeOccurrence}
                    onAdjust={adjustOccurrence}
                    onRevert={revertOccurrenceAdjustment}
                  />
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
      <AdjustmentModal
        draft={adjustmentDraft}
        isSaving={adjustmentMutation.isPending}
        onChange={setAdjustmentDraft}
        onClose={() => setAdjustmentDraft(null)}
        onSubmit={submitAdjustmentDraft}
      />
    </div>
  );
}
