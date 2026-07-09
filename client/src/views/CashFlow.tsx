import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format, parseISO, startOfMonth, subMonths } from 'date-fns';
import { reportsApi } from '../lib/api';
import { formatWholeCurrency } from '../lib/formatters';
import { Screen, ScreenHeader, SectionLabel, ProgressBar } from '../components/balance';

const RANGES = [
  { id: 'month', label: 'Month', months: 1 },
  { id: 'six-months', label: '6 months', months: 6 },
  { id: 'year', label: 'Year', months: 12 },
] as const;
type RangeId = (typeof RANGES)[number]['id'];

export function CashFlow() {
  const [range, setRange] = useState<RangeId>('six-months');
  const months = RANGES.find((r) => r.id === range)!.months;
  const currentMonth = format(new Date(), 'yyyy-MM');

  const startDate = format(startOfMonth(subMonths(new Date(), months - 1)), 'yyyy-MM-dd');
  const endDate = format(new Date(), 'yyyy-MM-dd');

  const { data: cashflow } = useQuery({
    queryKey: ['cashflow', startDate, endDate],
    queryFn: () => reportsApi.cashflow({ startDate, endDate }),
  });
  const { data: spending } = useQuery({
    queryKey: ['spending', currentMonth],
    queryFn: () => reportsApi.spending({ month: currentMonth }),
  });

  const series = cashflow?.months ?? [];
  const income = series.reduce((s, m) => s + m.income, 0);
  const expenses = series.reduce((s, m) => s + Math.abs(m.expenses), 0);
  const net = income - expenses;

  const monthCF = series.find((m) => m.month === currentMonth);
  const maxBar = useMemo(
    () => Math.max(1, ...series.map((m) => Math.max(m.income, Math.abs(m.expenses)))),
    [series]
  );

  const topCategories = (spending?.categories ?? []).slice(0, 6);
  const maxCategory = Math.max(1, ...topCategories.map((c) => c.amount));

  return (
    <Screen>
      <ScreenHeader
        title="Cash flow"
        sub={
          monthCF ? (
            <>
              {format(new Date(), 'MMMM')} · <span className="tabular-nums">{formatWholeCurrency(monthCF.income)}</span> in ·{' '}
              <span className="tabular-nums">{formatWholeCurrency(Math.abs(monthCF.expenses))}</span> out ·{' '}
              <span className={monthCF.net >= 0 ? 'text-sage-deep' : 'text-clay'}>
                {formatWholeCurrency(monthCF.net, { showSign: true })} {monthCF.net >= 0 ? 'saved' : ''}
              </span>
            </>
          ) : (
            'No activity yet this month'
          )
        }
        actions={RANGES.map((r) => (
          <button
            key={r.id}
            type="button"
            onClick={() => setRange(r.id)}
            className={`text-[13.5px] transition-colors ${r.id === range ? 'text-ink' : 'text-muted hover:text-ink'}`}
          >
            {r.label}
          </button>
        ))}
        className="mb-7"
      />

      {/* 3-up summary for the selected period */}
      <div className="mb-8 grid max-w-[720px] flex-shrink-0 grid-cols-3 gap-4">
        {[
          { label: 'Income', value: formatWholeCurrency(income), tone: 'text-sage-deep' },
          { label: 'Expenses', value: formatWholeCurrency(-expenses), tone: 'text-clay' },
          { label: 'Net saved', value: formatWholeCurrency(net, { showSign: net > 0 }), tone: net >= 0 ? 'text-ink' : 'text-clay' },
        ].map((s) => (
          <div key={s.label} className="rounded-xl border border-line-2 bg-card p-4">
            <div className="text-xs text-muted">{s.label}</div>
            <div className={`mt-1.5 font-serif text-[22px] leading-tight tabular-nums ${s.tone}`}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Paired bar chart */}
      <div className="mb-9 max-w-[720px] flex-shrink-0">
        <div className="flex h-[150px] items-end gap-7">
          {series.map((m) => (
            <div key={m.month} className="flex flex-1 flex-col items-center gap-2">
              <div className="flex h-[120px] items-end gap-[5px]">
                <div
                  className="w-[15px] rounded-t-[3px] bg-sage"
                  style={{ height: `${Math.max(2, (m.income / maxBar) * 120)}px` }}
                  title={`Income ${formatWholeCurrency(m.income)}`}
                />
                <div
                  className="w-[15px] rounded-t-[3px] bg-tan"
                  style={{ height: `${Math.max(2, (Math.abs(m.expenses) / maxBar) * 120)}px` }}
                  title={`Expenses ${formatWholeCurrency(Math.abs(m.expenses))}`}
                />
              </div>
              <span className="text-[11.5px] text-muted-2">{format(parseISO(`${m.month}-01`), months > 6 ? 'MMM' : 'MMM')}</span>
            </div>
          ))}
          {series.length === 0 && <div className="pb-10 text-[13.5px] text-muted-2">No cash flow recorded for this period.</div>}
        </div>
        <div className="mt-3.5 flex gap-5 text-xs text-muted">
          <span className="flex items-center gap-1.5">
            <span className="h-[9px] w-[9px] rounded-[2px] bg-sage" />
            Income
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-[9px] w-[9px] rounded-[2px] bg-tan" />
            Expenses
          </span>
        </div>
      </div>

      {/* Top spending */}
      <div className="max-w-[720px] flex-1 overflow-y-auto">
        <SectionLabel className="mb-2.5">Top spending · {format(new Date(), 'MMMM')}</SectionLabel>
        {topCategories.map((c) => (
          <div key={c.category_id} className="flex items-center gap-5 border-b border-line px-1 py-3">
            <span className="w-[130px] truncate text-[14.5px] text-ink">{c.category_name}</span>
            <ProgressBar fraction={c.amount / maxCategory} className="flex-1" />
            <span className="w-[80px] text-right text-[14.5px] tabular-nums text-ink">{formatWholeCurrency(c.amount)}</span>
          </div>
        ))}
        {topCategories.length === 0 && <div className="py-3 text-[13.5px] text-muted-2">No categorized spending yet this month.</div>}
      </div>
    </Screen>
  );
}
