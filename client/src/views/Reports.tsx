import { useQuery } from '@tanstack/react-query';
import { networthApi } from '../lib/api';
import { ASSET_COLORS } from '../lib/chartColors';
import { formatWholeCurrency } from '../lib/formatters';
import { Screen, ScreenHeader, SectionLabel } from '../components/balance';
import type { NetWorthSnapshot } from '@shared/types';

const LIABILITY_COLOR = '#b5654a'; // clay
const [LIQUID_COLOR, EQUITY_COLOR, CRYPTO_COLOR, OTHER_COLOR] = ASSET_COLORS;

interface Buckets {
  liquid: number;
  equity: number;
  crypto: number;
  other: number;
  liabilities: number;
  netWorth: number;
}

function before(s: NetWorthSnapshot): Buckets {
  const liquid = s.liquid_assets ?? 0;
  const equity = s.investment_assets ?? 0;
  const crypto = s.crypto_assets ?? 0;
  const other = Math.max(0, s.total_assets - (liquid + equity + crypto));
  return { liquid, equity, crypto, other, liabilities: s.total_liabilities, netWorth: s.net_worth };
}

// Pay every liability out of liquid cash. Net worth is invariant (assets and liabilities
// fall by the same amount); what changes is the composition — cash shrinks, debt clears.
function afterPayoff(b: Buckets): Buckets {
  const liquid = Math.max(0, b.liquid - b.liabilities);
  const residualDebt = Math.max(0, b.liabilities - b.liquid);
  return { ...b, liquid, liabilities: residualDebt };
}

const SEGMENTS: Array<{ key: keyof Buckets; label: string; color: string }> = [
  { key: 'liquid', label: 'Cash', color: LIQUID_COLOR },
  { key: 'equity', label: 'Stocks', color: EQUITY_COLOR },
  { key: 'crypto', label: 'Crypto', color: CRYPTO_COLOR },
  { key: 'other', label: 'Other', color: OTHER_COLOR },
];

function Distribution({ b, scaleMax }: { b: Buckets; scaleMax: number }) {
  const assetTotal = b.liquid + b.equity + b.crypto + b.other;
  const pct = (v: number) => (scaleMax > 0 ? (v / scaleMax) * 100 : 0);
  return (
    <div className="space-y-3">
      <div>
        <div className="mb-1 flex items-baseline justify-between text-[13px] text-muted">
          <span>Assets</span>
          <span className="tabular-nums text-ink">{formatWholeCurrency(assetTotal)}</span>
        </div>
        <div className="flex h-7 w-full overflow-hidden rounded-md bg-rail">
          {SEGMENTS.map((seg) =>
            b[seg.key] > 0 ? (
              <div
                key={seg.key}
                title={`${seg.label}: ${formatWholeCurrency(b[seg.key])}`}
                style={{ width: `${pct(b[seg.key])}%`, background: seg.color }}
              />
            ) : null
          )}
        </div>
      </div>
      <div>
        <div className="mb-1 flex items-baseline justify-between text-[13px] text-muted">
          <span>Liabilities</span>
          <span className="tabular-nums text-ink">{formatWholeCurrency(b.liabilities)}</span>
        </div>
        <div className="flex h-7 w-full overflow-hidden rounded-md bg-rail">
          {b.liabilities > 0 && (
            <div style={{ width: `${pct(b.liabilities)}%`, background: LIABILITY_COLOR }} />
          )}
        </div>
      </div>
    </div>
  );
}

export function Reports() {
  const { data: snapshot, isLoading } = useQuery({
    queryKey: ['networth-snapshot'],
    queryFn: () => networthApi.snapshot(),
  });

  return (
    <Screen contained>
      <ScreenHeader
        title="Reports"
        sub="How your net worth is composed, before and after paying off debt"
        className="mb-6"
      />

      {isLoading && <div className="text-[14px] text-muted">Loading…</div>}

      {!isLoading && !snapshot && (
        <div className="text-[14px] text-muted">
          No net-worth snapshot yet. Run a sync to generate one.
        </div>
      )}

      {snapshot && (() => {
        const b = before(snapshot);
        const a = afterPayoff(b);
        const scaleMax = Math.max(b.liquid + b.equity + b.crypto + b.other, b.liabilities, 1);

        return (
          <div className="max-w-[720px] space-y-10">
            <div>
              <SectionLabel className="mb-1.5">Net worth</SectionLabel>
              <div className="font-serif text-4xl text-ink tabular-nums">{formatWholeCurrency(b.netWorth)}</div>
              {b.liabilities > 0 && (
                <p className="mt-2 text-[14px] leading-relaxed text-muted">
                  Paying off {formatWholeCurrency(b.liabilities)} in liabilities from cash leaves your net
                  worth unchanged at <span className="text-ink">{formatWholeCurrency(a.netWorth)}</span> — it
                  reshuffles the composition rather than growing it.
                </p>
              )}
            </div>

            <div className="grid grid-cols-1 gap-10 sm:grid-cols-2">
              <div>
                <SectionLabel className="mb-3">Now</SectionLabel>
                <Distribution b={b} scaleMax={scaleMax} />
              </div>
              <div>
                <SectionLabel className="mb-3">After paying off debt</SectionLabel>
                <Distribution b={a} scaleMax={scaleMax} />
              </div>
            </div>

            <div className="flex flex-wrap gap-x-6 gap-y-2 text-[12.5px] text-muted">
              {SEGMENTS.map((seg) => (
                <span key={seg.key} className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-sm" style={{ background: seg.color }} />
                  {seg.label}
                </span>
              ))}
              <span className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-sm" style={{ background: LIABILITY_COLOR }} />
                Liabilities
              </span>
            </div>
          </div>
        );
      })()}
    </Screen>
  );
}
