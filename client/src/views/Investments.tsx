import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format, subMonths } from 'date-fns';
import type { Holding } from '@shared/types';
import { accountsApi, investmentsApi, reportsApi } from '../lib/api';
import { formatWholeCurrency, formatPercent, formatDateShort, formatUnitPrice, formatAdaptiveCurrency, formatQuantity } from '../lib/formatters';
import { parseDecimalInput } from '../lib/numberInput';
import {
  ALLOCATION_LENSES,
  getAllocationSlices,
  getCostBasisStats,
  isLivePosition,
  getPortfolioDelta,
  holdingGain,
  type AllocationLens,
} from '../lib/investmentAnalytics';
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
            {accountName ?? 'Investment account'} · {formatQuantity(holding.quantity)} share
            {holding.quantity === 1 ? '' : 's'} @ {formatUnitPrice(holding.institution_price)}
          </span>
          <span className="font-serif text-display font-light leading-none tabular-nums text-ink">{formatWholeCurrency(holding.institution_value)}</span>
        </div>
        {gain && (
          <div className={`text-body tabular-nums ${gain.gain >= 0 ? 'text-sage-deep' : 'text-clay'}`}>
            {formatWholeCurrency(gain.gain, { showSign: gain.gain > 0 })} · {formatPercent(Math.abs(gain.pct))} against{' '}
            {holding.cost_basis_quality === 'manual' ? 'your manual basis' : 'provider basis'}
          </div>
        )}
        <div className="flex gap-4">
          <div className="flex-1">
            <label htmlFor="investments-manual-cost-basis" className="mz-label">Manual cost basis</label>
            <input id="investments-manual-cost-basis"
              type="number"
              className="mz-field tabular-nums"
              placeholder={holding.provider_cost_basis != null ? `Provider: ${holding.provider_cost_basis.toFixed(2)}` : 'Total paid'}
              value={costBasis}
              onChange={(e) => setCostBasis(e.target.value)}
            />
          </div>
          <div className="flex-1">
            <label htmlFor="investments-sector" className="mz-label">Sector</label>
            <input id="investments-sector" className="mz-field" placeholder="Technology" value={sector} onChange={(e) => setSector(e.target.value)} />
          </div>
        </div>
        <div>
          <label htmlFor="investments-basis-note" className="mz-label">Basis note</label>
          <input id="investments-basis-note" className="mz-field" placeholder="e.g. average of two lots" value={note} onChange={(e) => setNote(e.target.value)} />
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

export interface InvestmentNotesInput {
  /** The headline: every visible portfolio account's balance. */
  portfolioValue: number | null;
  /** The part of it held by accounts that carry at least one position. */
  investedBalance: number | null;
  /** What those positions add up to. */
  holdingsValue: number | null;
  /** The part of the headline held in crypto wallets. */
  cryptoValue: number | null;
}

export interface InvestmentNotes {
  crypto: string | null;
  uninvested: string | null;
  reconciliation: string | null;
}

/**
 * The three sentences under the headline, or null for each one there is nothing to say about.
 *
 * Pure and exported so the silence can be tested. Each of these fired, or failed to fire, on an
 * ordinary healthy ledger at some point:
 *
 * - `reconciliation` compares positions against the balances of the accounts HOLDING those
 *   positions, never against the headline. Compared against the headline, an IRA funded and not
 *   yet invested reported the whole of its cash as a discrepancy, which is an ordinary account
 *   doing nothing wrong. `aiContext.ts` names that same case as ordinary in so many words.
 * - `uninvested` is what explains that money instead, and it accuses nothing: it says where the
 *   difference between the headline and this list is, in the one place the owner would otherwise
 *   have to work it out by subtraction.
 * - `crypto` exists because two surfaces of this app count the portfolio differently on purpose.
 *   Cmd+K reports a crypto-free portfolio figure, since its net-worth section reports crypto as
 *   its own bucket; this headline includes it, because the list below includes the coins. Both
 *   were true, and until now the only thing saying so was a source comment neither audience reads.
 *
 * The dollar thresholds are the rounding the copy itself uses: these figures come from integer
 * cents, and a sentence about a difference the reader cannot see in the numerals beside it is
 * noise. Crypto is judged at half a cent because it is a component, not a difference.
 */
export function investmentNotes({
  portfolioValue,
  investedBalance,
  holdingsValue,
  cryptoValue,
}: InvestmentNotesInput): InvestmentNotes {
  const uninvested =
    portfolioValue != null && investedBalance != null ? portfolioValue - investedBalance : null;
  const gap = holdingsValue != null && investedBalance != null ? holdingsValue - investedBalance : null;

  return {
    crypto:
      portfolioValue != null && cryptoValue != null && Math.abs(cryptoValue) >= 0.005
        ? `Includes ${formatWholeCurrency(cryptoValue)} crypto · investment accounts ${formatWholeCurrency(portfolioValue - cryptoValue)}`
        : null,
    uninvested:
      uninvested != null && Math.abs(uninvested) >= 1
        ? `${formatWholeCurrency(uninvested)} of the balance above sits in accounts holding no positions, so it is not in this list.`
        : null,
    reconciliation:
      gap != null && holdingsValue != null && investedBalance != null && Math.abs(gap) >= 1
        ? `Holdings sum to ${formatWholeCurrency(holdingsValue)}, ${formatWholeCurrency(Math.abs(gap))} ${gap > 0 ? 'above' : 'below'} the ${formatWholeCurrency(investedBalance)} your institutions report for the accounts those positions sit in. The balance is the figure used for net worth.`
        : null,
  };
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
    // The headline now comes out of this response, and only the series depends on the range.
    // Without this, switching 1M/1Y blanks the headline for a round trip.
    placeholderData: (previous) => previous,
  });
  const report = reportQ.data;

  // A failed request used to render as an empty section, indistinguishable from no data.
  const failableQueries = [
    { query: holdingsQ, label: 'holdings' },
    { query: accountsQ, label: 'accounts' },
    { query: reportQ, label: 'investment report' },
  ];

  // Headline, reconciliation, series and the list below them all come from the server's one
  // portfolio account set, so the number above the chart, the number the chart ends at and the
  // rows the owner can add up describe the same accounts. They did not: the headline included
  // the Coinbase wallet and the series excluded it, and no note on the screen could fire to
  // explain the $391.17 between them. Rendering nothing derived until the response lands is
  // deliberate; a placeholder assembled from a different set is how the two definitions got here.
  const marketValue = report?.portfolio_value ?? null;
  const notes = investmentNotes({
    portfolioValue: marketValue,
    investedBalance: report?.invested_balance ?? null,
    holdingsValue: report?.holdings_value ?? null,
    cryptoValue: report?.crypto_value ?? null,
  });

  const allHoldings = holdings ?? [];
  // Until the response lands there is no set to judge membership against, so the list shows what
  // it has rather than claiming a portfolio it cannot see is empty. `/api/investments/holdings`
  // serves every position, including those of an account that has been disconnected or archived,
  // whose balance is deliberately out of the headline.
  const portfolioHoldings = useMemo(() => {
    if (!report) return allHoldings;
    const ids = new Set(report.portfolio_account_ids);
    return allHoldings.filter((h) => ids.has(h.account_id));
  }, [allHoldings, report]);
  const stats = useMemo(() => getCostBasisStats(portfolioHoldings), [portfolioHoldings]);

  const history = report?.history ?? [];
  const delta = getPortfolioDelta(marketValue, history, report?.portfolio_account_ids.length ?? null);
  // Looked up by date rather than read off `delta.baseline`, because `PortfolioSeriesPoint` is the
  // shape `getPortfolioDelta` reasons about (value, estimated, coverage) and provenance is not part
  // of that arithmetic. `date` is UNIQUE on net_worth_snapshots and that function already refuses a
  // series that is not strictly ascending, so this finds the same point it returned.
  const baselineMembership = delta ? history.find((p) => p.date === delta.baseline.date)?.membership : undefined;

  const [lens, setLens] = useState<AllocationLens>('asset_type');
  const [selectedHolding, setSelectedHolding] = useState<Holding | null>(null);

  const slices = useMemo(() => {
    const accountById = new Map((accounts ?? []).map((a) => [a.id, a]));
    return getAllocationSlices(portfolioHoldings, lens, accountById);
  }, [portfolioHoldings, accounts, lens]);

  const accountNameById = useMemo(() => new Map((accounts ?? []).map((a) => [a.id, a.account_name])), [accounts]);

  return (
    <Screen size="wide">
      <QueryErrorBanner items={failableQueries} className="mb-5" />
      <div className="mb-3 flex flex-shrink-0 items-end justify-between">
        <div>
          <h1 className="font-serif text-title font-normal leading-tight text-ink">Investments</h1>
          <div className="mt-1 text-body text-muted">
            {stats.unrealized != null ? (
              <>
                Cost basis <span className="tabular-nums">{formatWholeCurrency(stats.knownCostBasis)}</span> ·{' '}
                <span className={stats.unrealized >= 0 ? 'text-sage-deep' : 'text-clay'}>
                  {stats.unrealized >= 0 ? '↑' : '↓'} {formatWholeCurrency(Math.abs(stats.unrealized))}
                  {stats.returnPct != null && <> · {formatPercent(Math.abs(stats.returnPct))}</>}
                </span>
                {stats.missingCount > 0 && <> · basis missing on {stats.missingCount}</>}
              </>
            ) : (
              `${portfolioHoldings.length} holding${portfolioHoldings.length === 1 ? '' : 's'}`
            )}
          </div>
        </div>
        <div className="text-right">
          {marketValue != null && (
            <div className="font-serif text-hero-lg font-light leading-none tabular-nums text-ink">{formatWholeCurrency(marketValue)}</div>
          )}
          {delta != null && (
            // `sage-deep`, not `sage`: this is a money numeral and the ground is `paper`, where
            // `sage` measures 3.93:1 light and 5.29:1 dark. That is under AA on light and over it
            // on dark, so `sage` is a tone this numeral would carry in one theme and lose in the
            // other. `sage-deep` is 4.87:1 light and 6.89:1 dark, which is what every other
            // positive numeral in this view already uses.
            //
            // [historical] The 2026-08-01 palette moved both figures and left the argument where
            // it was: `sage` on `paper` read 3.91 light / 6.96 dark before it and was under AA on
            // light then too. Re-derivable, not remembered:
            //   git show HEAD:client/src/index.css   ->  the previous triplets, through the same
            //   WCAG 2.1 arithmetic tests/helpers/palette.ts runs.
            //
            // The baseline is named rather than called "last snapshot": which snapshot it is
            // depends on whether the newest one already carries today's balances, and a label
            // that hides that is a claim the screen did not check.
            <div className={`mt-1.5 text-body tabular-nums ${delta.change >= 0 ? 'text-sage-deep' : 'text-clay'}`}>
              {delta.change >= 0 ? '↑' : '↓'} {formatWholeCurrency(Math.abs(delta.change))} since{' '}
              {delta.baseline.estimated ? 'the estimated ' : ''}
              {formatDateShort(delta.baseline.date)}
            </div>
          )}
          {/*
            Which accounts the baseline point was a sum over is a fact about the day it was written,
            and every snapshot taken before migration 056 was written without recording it. For those
            the set was worked out afterwards from an accounts table that postdates them, so the
            delta is measured from a point whose membership is a reconstruction, and saying so is the
            same courtesy `estimated` gets one line up.

            It says nothing on a healthy ledger and it clears itself: `takeSnapshot` records the set
            from now on, so once the baseline is a snapshot taken after 056 this is silent forever.
            The chart is deliberately left unmarked. Seventeen measured rows on the live ledger will
            carry a reconstructed membership for as long as they exist and nothing can ever observe
            what the portfolio was on a day that has passed, so painting them would be a permanent
            mark on the one thing the owner cannot act on.
          */}
          {baselineMembership === 'reconstructed' && (
            <div className="mt-1 text-note leading-relaxed text-muted-2">
              Which accounts that point covered was reconstructed from your accounts as they are now,
              not recorded when it was taken.
            </div>
          )}
          {notes.crypto && <div className="mt-1 text-note tabular-nums text-muted-2">{notes.crypto}</div>}
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
        {/*
          The coverage passed here is the endpoint's own per-point count of PORTFOLIO accounts,
          not the snapshot row's whole-sheet `covered_accounts`, which counts accounts this series
          does not draw. Where it changes, two consecutive points are sums over different sets of
          accounts, and TrendChart withholds the join rather than drawing the difference as money
          moving: an account created mid-history, or hidden and unhidden, does exactly that.
        */}
        {history.length >= 2 ? (
          <TrendChart
            history={history.map((point) => ({
              date: point.date,
              value: point.value,
              estimated: point.estimated,
              coverage: point.covered_accounts,
            }))}
            label="Portfolio value"
          />
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
          {notes.uninvested && (
            <div className="mb-2 text-note leading-relaxed tabular-nums text-muted-2">{notes.uninvested}</div>
          )}
          {notes.reconciliation && (
            <div className="mb-2 text-note leading-relaxed tabular-nums text-muted-2">{notes.reconciliation}</div>
          )}
          {portfolioHoldings
            .filter(isLivePosition)
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
                      {formatQuantity(h.quantity)} share{h.quantity === 1 ? '' : 's'}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-serif text-sub tabular-nums text-ink">{formatAdaptiveCurrency(h.institution_value)}</div>
                    {gain && (
                      <div className={`mt-0.5 text-note tabular-nums ${gain.gain >= 0 ? 'text-sage-deep' : 'text-clay'}`}>
                        {formatAdaptiveCurrency(gain.gain, { showSign: gain.gain > 0 })} · {formatPercent(Math.abs(gain.pct))}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          {portfolioHoldings.length === 0 && (
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
