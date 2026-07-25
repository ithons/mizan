import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format, parseISO } from 'date-fns';
import type { Category, RecurringForecastOccurrence, RecurringPattern } from '@shared/types';
import { categoriesApi, flattenCategories, recurringApi } from '../lib/api';
import { formatCurrency, formatWholeCurrency } from '../lib/formatters';
import { parseDecimalInput } from '../lib/numberInput';
import { useAppStore } from '../store';
import { Modal } from '../components/Modal';
import { QueryErrorBanner } from '../components/QueryErrorBanner';
import { Screen, ScreenHeader, SectionLabel, InkButton, TextButton, CategoryPicker } from '../components/balance';

const FREQUENCY_OPTIONS: Array<RecurringPattern['frequency']> = ['weekly', 'biweekly', 'monthly', 'quarterly', 'annual'];

function BillModal({ open, onClose, categories }: { open: boolean; onClose: () => void; categories: Category[] }) {
  const qc = useQueryClient();
  const { addToast } = useAppStore();
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [frequency, setFrequency] = useState<RecurringPattern['frequency']>('monthly');
  const [nextDate, setNextDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [categoryId, setCategoryId] = useState('');

  const flat = flattenCategories(categories);
  const selectedCategory = flat.find((c) => c.id === categoryId);
  const isIncome = Boolean(selectedCategory?.is_income);

  const reset = () => {
    setName('');
    setAmount('');
    setFrequency('monthly');
    setNextDate(format(new Date(), 'yyyy-MM-dd'));
    setCategoryId('');
  };

  const save = useMutation({
    mutationFn: () => {
      const parsed = parseDecimalInput(amount);
      if (!name.trim()) throw new Error('Name the item');
      if (parsed === null || parsed <= 0) throw new Error('Enter a valid amount');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(nextDate)) throw new Error('Pick the next date');
      return recurringApi.create({
        merchant_name: name.trim(),
        frequency,
        average_amount: parsed,
        next_expected: nextDate,
        category_id: categoryId || null,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['recurring'] });
      addToast({ type: 'success', message: `${isIncome ? 'Income' : 'Bill'} added` });
      reset();
      onClose();
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  return (
    <Modal open={open} onClose={onClose} title="Add recurring item">
      <div className="space-y-4">
        <div>
          <label className="mz-label">Name</label>
          <input className="mz-field" value={name} onChange={(e) => setName(e.target.value)} placeholder="Rent, Netflix, Paycheck…" autoFocus />
        </div>
        <div className="flex gap-4">
          <div className="flex-1">
            <label className="mz-label">Amount</label>
            <input type="number" className="mz-field tabular-nums" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          <div className="flex-1">
            <label className="mz-label">Frequency</label>
            <select className="mz-field" value={frequency} onChange={(e) => setFrequency(e.target.value as RecurringPattern['frequency'])}>
              {FREQUENCY_OPTIONS.map((f) => (
                <option key={f} value={f}>
                  {f.charAt(0).toUpperCase() + f.slice(1)}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="flex gap-4">
          <div className="flex-1">
            <label className="mz-label">Next date</label>
            <input type="date" className="mz-field tabular-nums" value={nextDate} onChange={(e) => setNextDate(e.target.value)} />
          </div>
          <div className="flex-1">
            <label className="mz-label">Category</label>
            <CategoryPicker
              variant="field" value={categoryId} categories={categories} onChange={setCategoryId}
              placeholder="Uncategorized (bill)"
            />
          </div>
        </div>
        <p className="text-[12px] text-muted-2">
          {isIncome ? 'Tracked as income' : 'Tracked as a bill'} · category determines whether this counts as income or an expense.
        </p>
        <div className="flex items-center gap-5 pt-1">
          <InkButton onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? 'Adding…' : 'Add item'}
          </InkButton>
          <TextButton onClick={onClose}>Cancel</TextButton>
        </div>
      </div>
    </Modal>
  );
}

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
  const varies = o.amount_varies ? ' · amount varies' : '';
  return `${freq} · ${o.confidence_label}${varies}${o.status === 'overdue' ? ' · overdue' : ''}`;
}

export function Bills() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { addToast } = useAppStore();

  const [showIncome, setShowIncome] = useState(false);
  const [showAdd, setShowAdd] = useState(false);

  const forecastQ = useQuery({ queryKey: ['recurring', 'forecast', 30], queryFn: () => recurringApi.forecast(30) });
  const forecast = forecastQ.data;
  const patternsQ = useQuery({ queryKey: ['recurring'], queryFn: () => recurringApi.list() });
  const patterns = patternsQ.data;
  const categoriesQ = useQuery({ queryKey: ['categories'], queryFn: () => categoriesApi.list() });
  const categories = categoriesQ.data;

  // A failed request used to render as an empty section, indistinguishable from no data.
  const failableQueries = [
    { query: forecastQ, label: 'upcoming bills' },
    { query: patternsQ, label: 'recurring items' },
    { query: categoriesQ, label: 'categories' },
  ];

  const bills = useMemo(() => (patterns ?? []).filter(isBillPattern), [patterns]);
  const monthlyTotal = bills.reduce((s, p) => s + monthlyAmount(p), 0);

  // Skipped occurrences stay visible (dimmed, with Undo) so a mis-click is recoverable.
  const upcoming = (forecast?.occurrences ?? []).filter((o) => showIncome || !o.is_income);

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

  const undoSkip = useMutation({
    mutationFn: (o: RecurringForecastOccurrence) => recurringApi.deleteAdjustment(o.pattern_id, o.adjustment_id!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['recurring'] });
      addToast({ type: 'success', message: 'Skip undone' });
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
        actions={<InkButton onClick={() => setShowAdd(true)}>+ Add bill</InkButton>}
        className="mb-6"
      />
      <QueryErrorBanner items={failableQueries} className="mb-5" />

      <div className="flex min-h-0 flex-1 flex-col gap-10 lg:flex-row lg:gap-12">
        {/* Upcoming list */}
        <div className="min-w-0 lg:flex-[1.5]">
          <div className="mb-2.5 flex items-baseline justify-between">
            <SectionLabel>Upcoming · next 30 days</SectionLabel>
            <button
              type="button"
              onClick={() => setShowIncome((v) => !v)}
              className={`text-[12.5px] transition-colors ${showIncome ? 'text-sage-deep' : 'text-muted-2 hover:text-muted'}`}
            >
              {showIncome ? 'Income shown' : 'Show income'}
            </button>
          </div>
          {upcoming.map((o) => {
            const d = parseISO(o.adjusted_date ?? o.expected_date);
            const skipped = o.adjustment_action === 'skip';
            return (
              <div
                key={o.id}
                className={`group flex items-center gap-5 rounded-lg border-b border-line px-3 py-3 transition-colors hover:bg-rail ${
                  skipped ? 'opacity-50' : ''
                }`}
              >
                <div className="w-[38px] flex-shrink-0 text-center">
                  <div className="text-[10.5px] uppercase tracking-[0.1em] text-muted-2">{format(d, 'MMM')}</div>
                  <div className="font-serif text-[19px] leading-none text-ink">{format(d, 'd')}</div>
                </div>
                <div className="min-w-0 flex-1">
                  <div className={`truncate text-[15px] text-ink ${skipped ? 'line-through' : ''}`}>{o.merchant_name}</div>
                  <div className="mt-0.5 text-xs text-muted-2">{skipped ? 'Skipped this occurrence' : occurrenceMeta(o)}</div>
                </div>
                <span className={`font-serif text-[18px] tabular-nums ${o.is_income ? 'text-sage-deep' : 'text-ink'}`}>
                  {/* A variable-amount pattern (paycheck, utility bill) stores a median, not a bill.
                      The tilde keeps it from reading as a figure the provider actually quoted. */}
                  {o.amount_varies ? '~' : ''}
                  {formatCurrency(Math.abs(o.adjusted_amount ?? o.amount), { showSign: o.is_income })}
                </span>
                {skipped ? (
                  <button
                    type="button"
                    onClick={() => undoSkip.mutate(o)}
                    disabled={undoSkip.isPending || !o.adjustment_id}
                    className="rounded-md border border-pill-border bg-pill-bg px-2.5 py-1 text-[12px] text-muted transition-colors hover:text-ink disabled:opacity-50"
                  >
                    Undo
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => skipOccurrence.mutate(o)}
                    disabled={skipOccurrence.isPending}
                    className="rounded-md border border-pill-border bg-pill-bg px-2.5 py-1 text-[12px] text-muted opacity-0 transition-opacity hover:text-ink group-hover:opacity-100"
                  >
                    Skip
                  </button>
                )}
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

      <BillModal open={showAdd} onClose={() => setShowAdd(false)} categories={categories ?? []} />
    </Screen>
  );
}
