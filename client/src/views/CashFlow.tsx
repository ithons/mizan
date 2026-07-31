import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { endOfMonth, format, parseISO, startOfMonth, subMonths } from 'date-fns';
import { reportsApi } from '../lib/api';
import { formatWholeCurrency } from '../lib/formatters';
import { QueryErrorBanner } from '../components/QueryErrorBanner';
import {
  Screen,
  ScreenHeader,
  SectionLabel,
  Card,
  Figure,
  SignedBar,
  signedBarScale,
  bySignedMagnitude,
} from '../components/balance';

const RANGES = [
  { id: 'month', label: 'Month', months: 1 },
  { id: 'six-months', label: '6 months', months: 6 },
  { id: 'year', label: 'Year', months: 12 },
  { id: 'two-years', label: '2 years', months: 24 },
  // Wide enough to cover all imported history (back to 2023); the date math below just works.
  { id: 'all', label: 'All', months: 120 },
] as const;
type RangeId = (typeof RANGES)[number]['id'];

export function CashFlow() {
  const [range, setRange] = useState<RangeId>('six-months');
  const [hovered, setHovered] = useState<string | null>(null);
  const months = RANGES.find((r) => r.id === range)!.months;
  const currentMonth = format(new Date(), 'yyyy-MM');

  const startDate = format(startOfMonth(subMonths(new Date(), months - 1)), 'yyyy-MM-dd');
  const endDate = format(new Date(), 'yyyy-MM-dd');

  const cashflowQ = useQuery({
    queryKey: ['cashflow', startDate, endDate],
    queryFn: () => reportsApi.cashflow({ startDate, endDate }),
  });
  const cashflow = cashflowQ.data;
  // An explicit window, not `{ month }`: the /spending route only ever read startDate/endDate,
  // so the month was serialized, sent, and silently dropped, and this panel rendered the ALL-TIME
  // rollup under a heading that named the current month ($80,798.16 where July was $2,836.46).
  const monthStart = format(startOfMonth(new Date()), 'yyyy-MM-dd');
  const monthEnd = format(endOfMonth(new Date()), 'yyyy-MM-dd');
  const spendingQ = useQuery({
    queryKey: ['spending', monthStart, monthEnd],
    queryFn: () => reportsApi.spending({ startDate: monthStart, endDate: monthEnd }),
  });
  const spending = spendingQ.data;

  // A failed request used to render as an empty section, indistinguishable from no data.
  const failableQueries = [
    { query: cashflowQ, label: 'cash flow' },
    { query: spendingQ, label: 'spending' },
  ];

  const series = cashflow?.months ?? [];
  const income = series.reduce((s, m) => s + m.income, 0);
  const expenses = series.reduce((s, m) => s + Math.abs(m.expenses), 0);
  const net = income - expenses;

  const monthCF = series.find((m) => m.month === currentMonth);
  const maxBar = useMemo(
    () => Math.max(1, ...series.map((m) => Math.max(m.income, Math.abs(m.expenses)))),
    [series]
  );

  // Ranked, not truncated-then-ranked: a category total is signed now (July 2026 Shopping is
  // -$1,203.63, because that month's Amazon and REI credits exceed its purchases), and slicing an
  // amount-descending list to six drops the largest single movement of money off the bottom.
  const rankedCategories = [...(spending?.categories ?? [])].sort((a, b) => bySignedMagnitude(a.amount, b.amount));
  const credits = rankedCategories.filter((c) => c.amount < 0);
  const topCategories = [...rankedCategories.filter((c) => c.amount >= 0).slice(0, 6), ...credits];
  const categoryScale = signedBarScale(topCategories.map((c) => c.amount));

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
            className={`text-body transition-colors ${r.id === range ? 'text-ink' : 'text-muted hover:text-ink'}`}
          >
            {r.label}
          </button>
        ))}
        className="mb-6"
      />
      <QueryErrorBanner items={failableQueries} className="mb-5" />

      {/* The subject gets the band and its two terms sit under it, rather than all three sharing a
          row as equals. Three tiles of the same width say the three numbers are the same kind of
          thing; income and expenses are the terms, net is the answer. The full width is also what
          makes 44px safe: a seven-figure total needs about 290px and a third of this column is
          326px before padding.

          `net` is signed and the two directions are different states, so the word carries the
          direction and the numeral carries only the size. */}
      <div className="mb-8 flex-shrink-0 space-y-3 lg:space-y-4">
        <Card padding="lg" elevation={2}>
          <Figure
            scale="subject"
            label="Net"
            value={net}
            states={{ positive: 'saved over this period', negative: 'spent beyond income', zero: 'exactly level' }}
          >
            {formatWholeCurrency(Math.abs(net))}
          </Figure>
        </Card>
        <div className="grid gap-3 sm:grid-cols-2 lg:gap-4">
          <Card padding="lg">
            <Figure scale="lead" tone="positive" label="Income">
              {formatWholeCurrency(income)}
            </Figure>
          </Card>
          <Card padding="lg">
            <Figure scale="lead" tone="negative" label="Expenses">
              {formatWholeCurrency(-expenses)}
            </Figure>
          </Card>
        </div>
      </div>

      {/* Paired bar chart */}
      <div className="mb-8 flex-shrink-0">
        <div className="flex h-[150px] items-end gap-7">
          {series.map((m) => {
            const monthNet = m.income - Math.abs(m.expenses);
            const dimmed = hovered != null && hovered !== m.month;
            return (
              <div
                key={m.month}
                className={`relative flex flex-1 flex-col items-center gap-2 transition-opacity duration-150 ${dimmed ? 'opacity-40' : ''}`}
                onMouseEnter={() => setHovered(m.month)}
                onMouseLeave={() => setHovered(null)}
              >
                {hovered === m.month && (
                  <div className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-1 -translate-x-1/2 whitespace-nowrap rounded-lg border border-line-2 bg-card px-3 py-2 text-note">
                    <div className="mb-0.5 font-medium text-ink">{format(parseISO(`${m.month}-01`), 'MMMM yyyy')}</div>
                    <div className="tabular-nums text-muted">
                      <span className="text-sage-deep">{formatWholeCurrency(m.income)}</span> in ·{' '}
                      <span className="text-clay">{formatWholeCurrency(Math.abs(m.expenses))}</span> out ·{' '}
                      <span className={monthNet >= 0 ? 'text-sage-deep' : 'text-clay'}>
                        {formatWholeCurrency(monthNet, { showSign: monthNet > 0 })}
                      </span>
                    </div>
                  </div>
                )}
                <div className="flex h-[120px] items-end gap-[5px]">
                  <div className="mz-grow w-[15px] rounded-t-[3px] bg-sage" style={{ height: `${Math.max(2, (m.income / maxBar) * 120)}px` }} />
                  <div
                    className="mz-grow w-[15px] rounded-t-[3px] bg-tan"
                    style={{ height: `${Math.max(2, (Math.abs(m.expenses) / maxBar) * 120)}px` }}
                  />
                </div>
                <span className="text-micro text-muted-2">{format(parseISO(`${m.month}-01`), 'MMM')}</span>
              </div>
            );
          })}
          {series.length === 0 && <div className="pb-10 text-body text-muted-2">No cash flow recorded for this period.</div>}
        </div>
        <div className="mt-3.5 flex gap-5 text-note text-muted">
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
      <div className="flex-1">
        <SectionLabel className="mb-2.5">Where it went · {format(new Date(), 'MMMM')}</SectionLabel>
        {topCategories.map((c) => (
          <div key={c.category_id} className="flex items-center gap-5 border-b border-line px-1 py-3">
            <span className="w-[130px] truncate text-body-lg text-ink">{c.category_name}</span>
            <SignedBar value={c.amount} {...categoryScale} className="flex-1" />
            <span
              className={`w-[90px] text-right text-body-lg tabular-nums ${c.amount < 0 ? 'text-sage-deep' : 'text-ink'}`}
            >
              {formatWholeCurrency(c.amount)}
            </span>
          </div>
        ))}
        {/* Said only when the code found one. A category ends up here because its refunds outweigh
            its purchases, and without the sentence the bar reads as an unexplained backwards mark. */}
        {credits.length > 0 && (
          <div className="pt-2.5 text-note text-muted">
            {credits.length === 1 ? 'One category came back' : `${credits.length} categories came back`} net positive
            this month: refunds and credits there outweighed the purchases.
          </div>
        )}
        {topCategories.length === 0 && <div className="py-3 text-body text-muted-2">No categorized spending yet this month.</div>}
      </div>
    </Screen>
  );
}
