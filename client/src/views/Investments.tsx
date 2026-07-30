import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format, subMonths } from 'date-fns';
import type { Holding } from '@shared/types';
import { accountsApi, investmentsApi, reportsApi } from '../lib/api';
import { formatWholeCurrency, formatPercent } from '../lib/formatters';
import { parseDecimalInput } from '../lib/numberInput';
import { ALLOCATION_LENSES, getAllocationSlices, getCostBasisStats, holdingGain, type AllocationLens } from '../lib/investmentAnalytics';
import { useAppStore } from '../store';
import { Modal } from '../components/Modal';
import { QueryErrorBanner } from '../components/QueryErrorBanner';
import { Screen, SectionLabel, InkButton, TextButton, TrendChart } from '../components/balance';

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

function HoldingModal({ holding, accountName, onClose }: { holding: Holding | null; accountName?: string; onClose: () => void }) {
  const qc = useQueryClient();
  const { addToast } = useAppStore();
  const [costBasis, setCostBasis] = useState('');
  const [note, setNote] = useState('');
  const [sector, setSector] = useState('');

  useEffect(() => {
    if (holding) {
      setCostBasis(holding.manual_cost_basis != null ? String(holding.manual_cost_basis) : '');
      setNote(holding.manual_cost_basis_note ?? '');
      setSector(holding.sector ?? '');
    }
  }, [holding]);

  const onDone = (message: string) => {
    qc.invalidateQueries({ queryKey: ['holdings'] });
    qc.invalidateQueries({ queryKey: ['reports-investments'] });
    addToast({ type: 'success', message });
  };
  const onError = (err: Error) => addToast({ type: 'error', message: err.message });

  const save = useMutation({
    mutationFn: async () => {
      const parsed = costBasis.trim() ? parseDecimalInput(costBasis) : null;
      if (costBasis.trim() && (parsed === null || parsed < 0)) throw new Error('Enter a valid cost basis');
      const basisChanged =
        parsed !== (holding!.manual_cost_basis ?? null) || (note || null) !== (holding!.manual_cost_basis_note ?? null);
      const sectorChanged = (sector.trim() || null) !== (holding!.sector ?? null);
      if (basisChanged) {
        await investmentsApi.updateHoldingCostBasis(holding!.id, {
          manual_cost_basis: parsed,
          manual_cost_basis_note: note.trim() || null,
        });
      }
      if (sectorChanged) {
        await investmentsApi.updateSecurityMetadata(holding!.security_id, {
          sector: sector.trim() || null,
          sector_source: sector.trim() ? 'manual' : null,
        });
      }
    },
    onSuccess: () => {
      onDone('Holding updated');
      onClose();
    },
    onError,
  });

  if (!holding) return null;
  const gain = holdingGain(holding);

  return (
    <Modal open onClose={onClose} title={holdingName(holding)}>
      <div className="space-y-4">
        <div className="flex items-baseline justify-between">
          <span className="text-body text-muted">
            {accountName ?? 'Investment account'} · {holding.quantity.toLocaleString('en-US', { maximumFractionDigits: 4 })} share
            {holding.quantity === 1 ? '' : 's'} @ {formatWholeCurrency(holding.institution_price)}
          </span>
          <span className="font-serif text-figure tabular-nums text-ink">{formatWholeCurrency(holding.institution_value)}</span>
        </div>
        {gain && (
          <div className={`text-body tabular-nums ${gain.gain >= 0 ? 'text-sage-deep' : 'text-clay'}`}>
            {formatWholeCurrency(gain.gain, { showSign: gain.gain > 0 })} · {formatPercent(Math.abs(gain.pct))} against{' '}
            {holding.cost_basis_quality === 'manual' ? 'your manual basis' : 'provider basis'}
          </div>
        )}
        <div className="flex gap-4">
          <div className="flex-1">
            <label className="mz-label">Manual cost basis</label>
            <input
              type="number"
              className="mz-field tabular-nums"
              placeholder={holding.provider_cost_basis != null ? `Provider: ${holding.provider_cost_basis.toFixed(2)}` : 'Total paid'}
              value={costBasis}
              onChange={(e) => setCostBasis(e.target.value)}
            />
          </div>
          <div className="flex-1">
            <label className="mz-label">Sector</label>
            <input className="mz-field" placeholder="Technology" value={sector} onChange={(e) => setSector(e.target.value)} />
          </div>
        </div>
        <div>
          <label className="mz-label">Basis note</label>
          <input className="mz-field" placeholder="e.g. average of two lots" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        <div className="text-note leading-relaxed text-muted-2">
          Manual basis overrides the provider's number everywhere gains are shown. Clear the field to fall back
          {holding.provider_cost_basis != null ? ' to the provider basis.' : '.'}
        </div>
        <div className="flex items-center gap-5 pt-1">
          <InkButton onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </InkButton>
          <TextButton onClick={onClose}>Cancel</TextButton>
        </div>
      </div>
    </Modal>
  );
}

export function Investments() {
  const [range, setRange] = useState<RangeId>('1Y');
  const months = RANGES.find((r) => r.id === range)!.months;
  const startDate = months ? format(subMonths(new Date(), months), 'yyyy-MM-dd') : undefined;

  const holdingsQ = useQuery({ queryKey: ['holdings'], queryFn: () => investmentsApi.holdings() });
  const holdings = holdingsQ.data;
  const accountsQ = useQuery({ queryKey: ['accounts'], queryFn: () => accountsApi.list() });
  const accounts = accountsQ.data;
  const reportQ = useQuery({
    queryKey: ['reports-investments', range],
    queryFn: () => reportsApi.investments(startDate ? { startDate } : undefined),
  });
  const report = reportQ.data;

  // A failed request used to render as an empty section, indistinguishable from no data.
  const failableQueries = [
    { query: holdingsQ, label: 'holdings' },
    { query: accountsQ, label: 'accounts' },
    { query: reportQ, label: 'investment report' },
  ];

  const allHoldings = holdings ?? [];
  const holdingsValue = allHoldings.reduce((s, h) => s + h.institution_value, 0);
  // The institution's own account balance is the trusted total — it's what net worth and the
  // snapshot-based trend below use. A provider's holdings list can sum to a slightly different
  // number than the balance it reports for the same account (e.g. a money-market sweep that
  // hasn't settled), so the headline uses the account balance and any gap is surfaced, rather
  // than a holdings sum that silently disagrees with net worth and its own chart.
  const heldAccountIds = new Set(allHoldings.map((h) => h.account_id));
  const accountsWithHoldings = (accounts ?? []).filter((a) => heldAccountIds.has(a.id));
  const trustedValue = accountsWithHoldings.length
    ? accountsWithHoldings.reduce((s, a) => s + a.current_balance, 0)
    : holdingsValue;
  const reconciliationGap = holdingsValue - trustedValue; // positive => holdings exceed balances
  const marketValue = trustedValue;
  const stats = useMemo(() => getCostBasisStats(allHoldings), [allHoldings]);

  const history = report?.history ?? [];
  const dayChange = history.length >= 2 ? history[history.length - 1].value - history[history.length - 2].value : null;

  const [lens, setLens] = useState<AllocationLens>('asset_type');
  const [selectedHolding, setSelectedHolding] = useState<Holding | null>(null);

  const slices = useMemo(() => {
    const accountById = new Map((accounts ?? []).map((a) => [a.id, a]));
    return getAllocationSlices(allHoldings, lens, accountById);
  }, [allHoldings, accounts, lens]);

  const accountNameById = useMemo(() => new Map((accounts ?? []).map((a) => [a.id, a.account_name])), [accounts]);

  return (
    <Screen size="wide">
      <QueryErrorBanner items={failableQueries} className="mb-5" />
      <div className="mb-3 flex flex-shrink-0 items-end justify-between">
        <div>
          <h1 className="font-serif text-display font-normal leading-tight text-ink">Investments</h1>
          <div className="mt-1 text-body text-muted">
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
          <div className="font-serif text-hero-lg font-light leading-none tabular-nums text-ink">{formatWholeCurrency(marketValue)}</div>
          {dayChange != null && (
            <div className={`mt-1.5 text-body tabular-nums ${dayChange >= 0 ? 'text-sage' : 'text-clay'}`}>
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
              className={`px-2 py-1 text-note transition-colors ${r.id === range ? 'text-ink' : 'text-muted hover:text-ink'}`}
            >
              {r.id}
            </button>
          ))}
        </div>
        {history.length >= 2 ? (
          <TrendChart history={history} />
        ) : (
          <div className="flex h-[120px] items-center text-body text-muted-2">
            Portfolio history builds up from daily net worth snapshots as syncs run.
          </div>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-10 lg:flex-row lg:gap-12">
        {/* Holdings */}
        <div className="min-w-0 flex-1">
          <SectionLabel className="mb-2">Holdings</SectionLabel>
          {Math.abs(reconciliationGap) >= 1 && (
            <div className="mb-2 text-note leading-relaxed text-muted-2">
              Holdings sum to <span className="tabular-nums">{formatWholeCurrency(holdingsValue)}</span>,{' '}
              <span className="tabular-nums">{formatWholeCurrency(Math.abs(reconciliationGap))}</span>{' '}
              {reconciliationGap > 0 ? 'above' : 'below'} the account balance your institution reports. The
              balance is the figure used for net worth.
            </div>
          )}
          {allHoldings
            .slice()
            .sort((a, b) => b.institution_value - a.institution_value)
            .map((h) => {
              const gain = holdingGain(h);
              return (
                <div
                  key={h.id}
                  onClick={() => setSelectedHolding(h)}
                  className="flex cursor-pointer items-center rounded-lg border-b border-line px-1 py-3 transition-colors hover:bg-well"
                >
                  <div className="min-w-0 flex-1 pr-3">
                    <div className="truncate text-body-lg text-ink">{holdingName(h)}</div>
                    <div className="mt-0.5 text-note text-muted-2">
                      {accountNameById.get(h.account_id) ?? 'Investment account'} ·{' '}
                      {h.quantity.toLocaleString('en-US', { maximumFractionDigits: 4 })} share{h.quantity === 1 ? '' : 's'}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-serif text-sub tabular-nums text-ink">{formatWholeCurrency(h.institution_value)}</div>
                    {gain && (
                      <div className={`mt-0.5 text-note tabular-nums ${gain.gain >= 0 ? 'text-sage-deep' : 'text-clay'}`}>
                        {formatWholeCurrency(gain.gain, { showSign: gain.gain > 0 })} · {formatPercent(Math.abs(gain.pct))}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          {allHoldings.length === 0 && (
            <div className="py-6 text-body-lg text-muted">No holdings yet. They appear after a SimpleFIN or Coinbase sync.</div>
          )}
        </div>

        {/* Allocation */}
        <div className="w-full flex-shrink-0 self-start border-t border-line-2 pt-6 lg:sticky lg:top-6 lg:w-[260px] lg:border-t-0 lg:pt-0">
          <div className="mb-4 flex flex-wrap items-baseline justify-between gap-y-1">
            <SectionLabel>Allocation</SectionLabel>
            <div className="flex flex-wrap gap-0.5">
              {ALLOCATION_LENSES.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  onClick={() => setLens(l.id)}
                  className={`px-1.5 py-0.5 text-micro transition-colors ${
                    l.id === lens ? 'text-ink' : 'text-muted-2 hover:text-muted'
                  }`}
                >
                  {l.label}
                </button>
              ))}
            </div>
          </div>
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
                  className={`flex justify-between py-[7px] text-body-lg ${i < slices.length - 1 ? 'border-b border-line' : ''}`}
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
            <div className="text-body text-muted-2">Allocation appears once holdings are synced.</div>
          )}
        </div>
      </div>

      <HoldingModal
        holding={selectedHolding}
        accountName={selectedHolding ? accountNameById.get(selectedHolding.account_id) : undefined}
        onClose={() => setSelectedHolding(null)}
      />
    </Screen>
  );
}
