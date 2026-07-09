import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format, subMonths } from 'date-fns';
import type { Holding } from '@shared/types';
import { accountsApi, investmentsApi, reportsApi } from '../lib/api';
import { formatWholeCurrency, formatPercent } from '../lib/formatters';
import { getAllocationSlices, getCostBasisStats } from '../lib/investmentAnalytics';
import { Screen, SectionLabel } from '../components/balance';

const RANGES = [
  { id: '1M', months: 1 },
  { id: '3M', months: 3 },
  { id: '1Y', months: 12 },
  { id: 'All', months: null },
] as const;
type RangeId = (typeof RANGES)[number]['id'];

function holdingName(h: Holding): string {
  const name = h.security_name ?? h.ticker ?? 'Unknown holding';
  return h.ticker && h.security_name ? `${h.security_name} · ${h.ticker}` : name;
}

function holdingGain(h: Holding): { gain: number; pct: number } | null {
  const basis = h.effective_cost_basis ?? h.cost_basis;
  if (basis == null || basis <= 0) return null;
  const gain = h.institution_value - basis;
  return { gain, pct: (gain / basis) * 100 };
}

/** Map a value series into polyline points inside a 1000x140 viewBox. */
function trendPoints(history: Array<{ date: string; value: number }>): string {
  if (history.length < 2) return '';
  const values = history.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = 1000 / (history.length - 1);
  return history
    .map((p, i) => {
      const x = i * step;
      const y = 128 - ((p.value - min) / span) * 116;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

export function Investments() {
  const [range, setRange] = useState<RangeId>('1Y');
  const months = RANGES.find((r) => r.id === range)!.months;
  const startDate = months ? format(subMonths(new Date(), months), 'yyyy-MM-dd') : undefined;

  const { data: holdings } = useQuery({ queryKey: ['holdings'], queryFn: () => investmentsApi.holdings() });
  const { data: accounts } = useQuery({ queryKey: ['accounts'], queryFn: () => accountsApi.list() });
  const { data: report } = useQuery({
    queryKey: ['reports-investments', range],
    queryFn: () => reportsApi.investments(startDate ? { startDate } : undefined),
  });

  const allHoldings = holdings ?? [];
  const marketValue = allHoldings.reduce((s, h) => s + h.institution_value, 0);
  const stats = useMemo(() => getCostBasisStats(allHoldings), [allHoldings]);

  const history = report?.history ?? [];
  const dayChange = history.length >= 2 ? history[history.length - 1].value - history[history.length - 2].value : null;

  const points = useMemo(() => trendPoints(history), [history]);
  const area = points ? `${points} 1000,140 0,140` : '';

  const slices = useMemo(() => {
    const accountById = new Map((accounts ?? []).map((a) => [a.id, a]));
    return getAllocationSlices(allHoldings, 'asset_type', accountById);
  }, [allHoldings, accounts]);

  const accountNameById = useMemo(() => new Map((accounts ?? []).map((a) => [a.id, a.account_name])), [accounts]);

  return (
    <Screen>
      <div className="mb-3 flex flex-shrink-0 items-end justify-between">
        <div>
          <h1 className="font-serif text-[27px] font-normal leading-tight text-ink">Investments</h1>
          <div className="mt-1 text-[13.5px] text-muted">
            {stats.unrealized != null ? (
              <>
                Cost basis <span className="tabular-nums">{formatWholeCurrency(stats.knownCostBasis)}</span> ·{' '}
                <span className={stats.unrealized >= 0 ? 'text-sage-deep' : 'text-clay'}>
                  {stats.unrealized >= 0 ? '▲' : '▼'} {formatWholeCurrency(Math.abs(stats.unrealized))}
                  {stats.returnPct != null && <> · {formatPercent(Math.abs(stats.returnPct))}</>}
                </span>
                {stats.missingCount > 0 && <> · basis missing on {stats.missingCount}</>}
              </>
            ) : (
              `${allHoldings.length} holding${allHoldings.length === 1 ? '' : 's'}`
            )}
          </div>
        </div>
        <div className="text-right">
          <div className="font-serif text-[44px] font-light leading-none tabular-nums text-ink">{formatWholeCurrency(marketValue)}</div>
          {dayChange != null && (
            <div className={`mt-1.5 text-[13.5px] tabular-nums ${dayChange >= 0 ? 'text-sage' : 'text-clay'}`}>
              {dayChange >= 0 ? '▲' : '▼'} {formatWholeCurrency(Math.abs(dayChange))} since last snapshot
            </div>
          )}
        </div>
      </div>

      {/* Trend chart with range tabs */}
      <div className="mb-8 mt-5 flex-shrink-0">
        <div className="mb-2 flex justify-end gap-1.5">
          {RANGES.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => setRange(r.id)}
              className={`px-2 py-1 text-[12.5px] transition-colors ${r.id === range ? 'text-ink' : 'text-muted hover:text-ink'}`}
            >
              {r.id}
            </button>
          ))}
        </div>
        {points ? (
          <svg viewBox="0 0 1000 140" width="100%" height="120" preserveAspectRatio="none" className="overflow-visible">
            <polyline points={area} fill="var(--mz-sage-soft)" opacity="0.07" stroke="none" />
            <polyline points={points} fill="none" stroke="var(--mz-sage)" strokeWidth="2.5" />
          </svg>
        ) : (
          <div className="flex h-[120px] items-center text-[13.5px] text-muted-2">
            Portfolio history builds up from daily net worth snapshots as syncs run.
          </div>
        )}
      </div>

      <div className="flex min-h-0 flex-1 gap-12">
        {/* Holdings */}
        <div className="min-w-0 max-w-[620px] flex-1 overflow-y-auto">
          <SectionLabel className="mb-2">Holdings</SectionLabel>
          {allHoldings
            .slice()
            .sort((a, b) => b.institution_value - a.institution_value)
            .map((h) => {
              const gain = holdingGain(h);
              return (
                <div key={h.id} className="flex items-center rounded-lg border-b border-line px-1 py-3.5 transition-colors hover:bg-rail">
                  <div className="min-w-0 flex-1 pr-3">
                    <div className="truncate text-[15px] text-ink">{holdingName(h)}</div>
                    <div className="mt-0.5 text-xs text-muted-2">
                      {accountNameById.get(h.account_id) ?? 'Investment account'} ·{' '}
                      {h.quantity.toLocaleString('en-US', { maximumFractionDigits: 4 })} share{h.quantity === 1 ? '' : 's'}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-serif text-[18px] tabular-nums text-ink">{formatWholeCurrency(h.institution_value)}</div>
                    {gain && (
                      <div className={`mt-0.5 text-[12.5px] tabular-nums ${gain.gain >= 0 ? 'text-sage-deep' : 'text-clay'}`}>
                        {formatWholeCurrency(gain.gain, { showSign: gain.gain > 0 })} · {formatPercent(Math.abs(gain.pct))}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          {allHoldings.length === 0 && (
            <div className="py-6 text-[14px] text-muted">No holdings yet. They appear after a SimpleFIN or Coinbase sync.</div>
          )}
        </div>

        {/* Allocation */}
        <div className="w-[260px] flex-shrink-0">
          <SectionLabel className="mb-4">Allocation</SectionLabel>
          {slices.length > 0 ? (
            <>
              <div className="mb-5 flex h-[10px] overflow-hidden rounded-[5px]">
                {slices.map((s) => (
                  <div key={s.key} style={{ width: `${s.pct}%`, background: s.color }} />
                ))}
              </div>
              {slices.map((s, i) => (
                <div
                  key={s.key}
                  className={`flex justify-between py-[7px] text-sm ${i < slices.length - 1 ? 'border-b border-line' : ''}`}
                >
                  <span className="flex items-center gap-2.5">
                    <span className="h-[9px] w-[9px] rounded-[2px]" style={{ background: s.color }} />
                    {s.label}
                  </span>
                  <span className="tabular-nums text-muted">{Math.round(s.pct)}%</span>
                </div>
              ))}
            </>
          ) : (
            <div className="text-[13px] text-muted-2">Allocation appears once holdings are synced.</div>
          )}
        </div>
      </div>
    </Screen>
  );
}
