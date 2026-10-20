import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { format, subYears } from 'date-fns';
import type { Account, NetWorthTimelinePoint, NetWorthTimelineStep } from '@shared/types';
import { networthApi } from '../../lib/api';
import { formatDateShort, formatWholeCurrency } from '../../lib/formatters';
import { Explain, Select, SectionLabel, TrendChart, type SelectOption } from '../../components/balance';

const RANGES = [
  { id: '1Y', years: 1 },
  { id: '2Y', years: 2 },
  { id: 'All', years: null },
  { id: 'Custom', years: null },
] as const;
type RangeId = (typeof RANGES)[number]['id'];

const STEPS: Array<{ id: NetWorthTimelineStep; label: string }> = [
  { id: 'day', label: 'Daily' },
  { id: 'week', label: 'Weekly' },
  { id: 'month', label: 'Monthly' },
];

const TOTALS: Array<{ id: string; label: string; read: (p: NetWorthTimelinePoint) => number }> = [
  { id: 'net_worth', label: 'Net worth', read: (p) => p.net_worth },
  { id: 'assets', label: 'Held', read: (p) => p.assets },
  { id: 'liabilities', label: 'Owed', read: (p) => p.liabilities },
  { id: 'liquid', label: 'Cash accounts', read: (p) => p.liquid },
  { id: 'invested', label: 'Invested', read: (p) => p.invested },
  { id: 'crypto', label: 'Crypto', read: (p) => p.crypto },
];

/** The largest estimated share of any point, and which accounts it ever came from. */
function largestEstimatedPart(points: NetWorthTimelinePoint[], accounts: Account[]): { amount: number; names: string } | null {
  let amount = 0;
  const ids = new Set<string>();
  for (const p of points) {
    const part = p.estimated_accounts.reduce((sum, id) => sum + Math.abs(p.by_account[id] ?? 0), 0);
    amount = Math.max(amount, part);
    p.estimated_accounts.forEach((id) => ids.add(id));
  }
  if (ids.size === 0) return null;
  const names = accounts.filter((a) => ids.has(a.id)).map((a) => a.account_name).join(', ');
  return { amount, names };
}

const pressed = (on: boolean) => `px-2 py-1 text-note transition-colors ${on ? 'text-ink' : 'text-muted hover:text-ink'}`;

/** Every day of the ledger, with the range, the quantity, the step and the accounts all chosen in the URL. */
export function NetWorthHistory({ accounts }: { accounts: Account[] }) {
  const [params, setParams] = useSearchParams();
  const range = (RANGES.find((r) => r.id === params.get('hr'))?.id ?? 'All') as RangeId;
  const step = (STEPS.find((s) => s.id === params.get('hstep'))?.id ?? 'day') as NetWorthTimelineStep;
  const series = params.get('hs') ?? 'net_worth';
  const excluded = useMemo(() => new Set((params.get('hx') ?? '').split(',').filter(Boolean)), [params]);
  const set = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value === null || value === '') next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  const eligible = useMemo(() => accounts.filter((a) => !a.is_hidden), [accounts]);
  const included = eligible.filter((a) => !excluded.has(a.id)).map((a) => a.id);
  const years = RANGES.find((r) => r.id === range)!.years;
  const from = range === 'Custom' ? params.get('hfrom') ?? undefined : years ? format(subYears(new Date(), years), 'yyyy-MM-dd') : undefined;
  const to = range === 'Custom' ? params.get('hto') ?? undefined : undefined;

  const timelineQ = useQuery({
    queryKey: ['networth', 'timeline', from, to, step, included.join(',')],
    queryFn: () => networthApi.timeline({ from, to, step, accounts: included }),
    enabled: included.length > 0,
    placeholderData: (previous) => previous,
  });
  const timeline = timelineQ.data;

  const seriesOptions: SelectOption[] = [
    ...TOTALS.map((t) => ({ value: t.id, label: t.label })),
    ...eligible.filter((a) => !excluded.has(a.id)).map((a) => ({ value: `acct:${a.id}`, label: a.account_name })),
  ];
  const total = TOTALS.find((t) => t.id === series);
  const accountId = series.startsWith('acct:') ? series.slice(5) : null;
  const liability = accountId ? eligible.find((a) => a.id === accountId)?.is_liability : false;
  const read = (p: NetWorthTimelinePoint): number | null => {
    if (total) return total.read(p);
    if (!accountId || p.by_account[accountId] === undefined) return null;
    return liability ? -p.by_account[accountId] : p.by_account[accountId];
  };
  const label = total?.label ?? (liability ? `${seriesOptions.find((o) => o.value === series)?.label} owed` : seriesOptions.find((o) => o.value === series)?.label) ?? 'Net worth';

  const history = (timeline?.points ?? []).flatMap((p) => {
    const value = read(p);
    const estimated = accountId ? p.estimated_accounts.includes(accountId) : p.estimated;
    return value === null ? [] : [{ date: p.date, value, estimated, coverage: total ? p.coverage : undefined }];
  });
  const first = history[0];
  const last = history.at(-1);
  const estimatedPart = total ? largestEstimatedPart(timeline?.points ?? [], eligible) : null;

  return (
    <div className="mb-8 flex-shrink-0">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <SectionLabel>{label} · {range === 'All' ? 'all history' : range === 'Custom' ? 'chosen dates' : `last ${range.replace('Y', ' year').replace('2 year', '2 years')}`}</SectionLabel>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="flex" role="group" aria-label="Range">
            {RANGES.map((r) => (
              <button key={r.id} type="button" aria-pressed={r.id === range} onClick={() => set('hr', r.id === 'All' ? null : r.id)} className={pressed(r.id === range)}>
                {r.id}
              </button>
            ))}
          </div>
          <div className="flex" role="group" aria-label="Step">
            {STEPS.map((s) => (
              <button key={s.id} type="button" aria-pressed={s.id === step} onClick={() => set('hstep', s.id === 'day' ? null : s.id)} className={pressed(s.id === step)}>
                {s.label}
              </button>
            ))}
          </div>
          <Select value={series} options={seriesOptions} onChange={(v) => set("hs", v === "net_worth" ? null : v)} placeholder="Net worth" clearable={false} align="right" />
        </div>
      </div>

      {range === 'Custom' && (
        <div className="mb-3 flex flex-wrap items-center gap-3 text-note text-muted">
          <label className="flex items-center gap-2">From
            <input type="date" className="mz-field" value={params.get('hfrom') ?? ''} max={params.get('hto') ?? undefined} onChange={(e) => set('hfrom', e.target.value)} />
          </label>
          <label className="flex items-center gap-2">To
            <input type="date" className="mz-field" value={params.get('hto') ?? ''} min={params.get('hfrom') ?? undefined} onChange={(e) => set('hto', e.target.value)} />
          </label>
        </div>
      )}

      {included.length === 0 ? (
        <p className="py-6 text-body text-muted">No accounts chosen. Pick at least one below.</p>
      ) : history.length >= 2 ? (
        <TrendChart history={history} height={160} label={label} />
      ) : (
        <p className="py-6 text-body text-muted">{timelineQ.isLoading ? 'Loading history.' : 'Nothing recorded in this range.'}</p>
      )}

      {first && last && (
        <p className="mt-2 text-note tabular-nums text-muted">
          {formatDateShort(first.date)} {formatWholeCurrency(first.value)} to {formatDateShort(last.date)} {formatWholeCurrency(last.value)}
          {' · '}
          {last.value - first.value >= 0 ? 'up' : 'down'} {formatWholeCurrency(Math.abs(last.value - first.value))}
          {estimatedPart ? ` · dashed days carry at most ${formatWholeCurrency(estimatedPart.amount)} of estimated value, from ${estimatedPart.names}` : ''}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-start gap-x-8 gap-y-2">
        <details className="group">
          <summary className="flex cursor-pointer list-none items-center gap-2 text-note text-muted transition-colors hover:text-ink [&::-webkit-details-marker]:hidden">
            <span aria-hidden className="inline-block transition-transform group-open:rotate-90">›</span>
            Accounts in the chart ({included.length} of {eligible.length})
          </summary>
          <div className="mt-3 grid grid-cols-1 gap-x-8 gap-y-1.5 sm:grid-cols-2">
            {eligible.map((a) => (
              <label key={a.id} className="flex cursor-pointer items-center gap-2 text-body">
                <input
                  type="checkbox"
                  checked={!excluded.has(a.id)}
                  onChange={(e) => {
                    const next = new Set(excluded);
                    if (e.target.checked) next.delete(a.id);
                    else next.add(a.id);
                    set('hx', [...next].join(','));
                  }}
                  className="rounded border-line-3 text-sage focus:ring-0"
                />
                <span className={a.type === 'closed' ? 'text-muted' : 'text-ink'}>{a.account_name}{a.type === 'closed' ? ' (closed)' : ''}</span>
              </label>
            ))}
          </div>
        </details>
        {timeline && <Explain label="How this is built">{timeline.method}</Explain>}
      </div>
    </div>
  );
}
