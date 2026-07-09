import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format, parseISO } from 'date-fns';
import type { RecurringForecastOccurrence, RecurringPattern } from '@shared/types';
import { recurringApi } from '../lib/api';
import { formatCurrency, formatWholeCurrency } from '../lib/formatters';
import { useAppStore } from '../store';
import { Screen, ScreenHeader, SectionLabel, TextButton } from '../components/balance';

const FREQUENCY_PER_MONTH: Record<RecurringPattern['frequency'], number> = {
  weekly: 52 / 12,
  biweekly: 26 / 12,
  monthly: 1,
  quarterly: 1 / 3,
  annual: 1 / 12,
};

function monthlyAmount(p: RecurringPattern): number {
  return Math.abs(p.average_amount) * FREQUENCY_PER_MONTH[p.frequency];
}

function isBillPattern(p: RecurringPattern): boolean {
  const signed = p.average_signed_amount ?? -Math.abs(p.average_amount);
  return p.is_active && signed < 0;
}

function occurrenceMeta(o: RecurringForecastOccurrence): string {
  const freq = o.frequency.charAt(0).toUpperCase() + o.frequency.slice(1);
  return `${freq} · ${o.confidence_label}${o.status === 'overdue' ? ' · overdue' : ''}`;
}

export function Bills() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { addToast } = useAppStore();

  const { data: forecast } = useQuery({ queryKey: ['recurring', 'forecast', 30], queryFn: () => recurringApi.forecast(30) });
  const { data: patterns } = useQuery({ queryKey: ['recurring'], queryFn: () => recurringApi.list() });

  const bills = useMemo(() => (patterns ?? []).filter(isBillPattern), [patterns]);
  const monthlyTotal = bills.reduce((s, p) => s + monthlyAmount(p), 0);

  const upcoming = (forecast?.occurrences ?? []).filter((o) => !o.is_income && o.adjustment_action !== 'skip');

  const breakdown = useMemo(() => {
    const byCategory = new Map<string, number>();
    for (const p of bills) {
      const key = p.category_name ?? 'Other';
      byCategory.set(key, (byCategory.get(key) ?? 0) + monthlyAmount(p));
    }
    return [...byCategory.entries()].sort((a, b) => b[1] - a[1]);
  }, [bills]);

  const skipOccurrence = useMutation({
    mutationFn: (o: RecurringForecastOccurrence) =>
      recurringApi.upsertAdjustment(o.pattern_id, {
        original_date: o.original_expected_date ?? o.expected_date,
        action: 'skip',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['recurring'] });
      addToast({ type: 'success', message: 'Occurrence skipped' });
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  return (
    <Screen>
      <ScreenHeader
        title="Bills & subscriptions"
        sub={
          bills.length > 0 ? (
            <>
              <span className="tabular-nums">{formatWholeCurrency(monthlyTotal)}</span> per month · {bills.length} recurring
            </>
          ) : (
            'Recurring charges are detected automatically from your transactions'
          )
        }
        className="mb-7"
      />

      <div className="flex min-h-0 flex-1 flex-col gap-10 lg:flex-row lg:gap-12">
        {/* Upcoming list */}
        <div className="min-w-0 lg:flex-[1.5]">
          <SectionLabel className="mb-2.5">Upcoming · next 30 days</SectionLabel>
          {upcoming.map((o) => {
            const d = parseISO(o.adjusted_date ?? o.expected_date);
            return (
              <div
                key={o.id}
                className="group flex items-center gap-5 rounded-lg border-b border-line px-3 py-3.5 transition-colors hover:bg-rail"
              >
                <div className="w-[38px] flex-shrink-0 text-center">
                  <div className="text-[10.5px] uppercase tracking-[0.1em] text-muted-2">{format(d, 'MMM')}</div>
                  <div className="font-serif text-[19px] leading-none text-ink">{format(d, 'd')}</div>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[15px] text-ink">{o.merchant_name}</div>
                  <div className="mt-0.5 text-[12.5px] text-muted-2">{occurrenceMeta(o)}</div>
                </div>
                <span className="font-serif text-[18px] tabular-nums text-ink">
                  {formatCurrency(Math.abs(o.adjusted_amount ?? o.amount))}
                </span>
                <button
                  type="button"
                  onClick={() => skipOccurrence.mutate(o)}
                  disabled={skipOccurrence.isPending}
                  className="rounded-md border border-pill-border bg-pill-bg px-2.5 py-1 text-[12px] text-muted opacity-0 transition-opacity hover:text-ink group-hover:opacity-100"
                >
                  Skip
                </button>
              </div>
            );
          })}
          {upcoming.length === 0 && (
            <div className="py-6 text-[14px] text-muted">
              Nothing due in the next 30 days. New recurring charges appear here once they are detected and confirmed.
            </div>
          )}
        </div>

        {/* Monthly total card */}
        <div className="min-w-0 self-start lg:sticky lg:top-6 lg:flex-1">
          <div className="rounded-xl border border-line-2 bg-card p-[22px]">
            <SectionLabel className="mb-3">Monthly total</SectionLabel>
            <div className="font-serif text-[34px] font-light leading-tight tabular-nums text-ink">
              {formatWholeCurrency(monthlyTotal)}
            </div>
            <div className="mt-5">
              {breakdown.map(([name, amount], i) => (
                <div
                  key={name}
                  className={`flex items-baseline justify-between py-2.5 ${i < breakdown.length - 1 ? 'border-b border-line' : ''}`}
                >
                  <span className="text-[13.5px] text-muted">{name}</span>
                  <span className="text-[14px] tabular-nums text-ink">{formatWholeCurrency(amount)}</span>
                </div>
              ))}
              {breakdown.length === 0 && <div className="py-2 text-[13px] text-muted-2">No recurring charges yet.</div>}
            </div>
          </div>
          {forecast && forecast.review_count > 0 && (
            <div className="mt-4 text-[13px] text-muted">
              {forecast.review_count} recurring suggestion{forecast.review_count === 1 ? '' : 's'} waiting in{' '}
              <TextButton className="!text-[13px] underline underline-offset-2" onClick={() => navigate('/transactions')}>
                review
              </TextButton>
              .
            </div>
          )}
        </div>
      </div>
    </Screen>
  );
}
