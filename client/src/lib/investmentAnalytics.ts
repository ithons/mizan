import type { Account, Holding } from '@shared/types';

export type AllocationLens = 'asset_type' | 'sector' | 'account_type' | 'tax_treatment' | 'symbol';

export const ALLOCATION_LENSES: Array<{ id: AllocationLens; label: string }> = [
  { id: 'asset_type', label: 'Asset' },
  { id: 'sector', label: 'Sector' },
  { id: 'account_type', label: 'Account' },
  { id: 'tax_treatment', label: 'Tax' },
  { id: 'symbol', label: 'Symbol' },
];

import { CHART_COLORS as ALLOCATION_COLORS, seriesColor } from './chartColors';
export { ALLOCATION_COLORS };

/** How many identities the ramp actually has. Past this the tail folds; it never wraps. */
export const ALLOCATION_SLOTS = ALLOCATION_COLORS.length;

/**
 * The key namespace each lens groups under.
 *
 * The value half of a key is normalized (`lensKey`), so a group is decided by identity rather
 * than by how the owner happened to type it.
 */
const LENS_PREFIX: Record<AllocationLens, string> = {
  asset_type: 'asset',
  sector: 'sector',
  account_type: 'account',
  tax_treatment: 'tax',
  symbol: 'symbol',
};

/**
 * A group key: the lens namespace plus a normalized token.
 *
 * Case folding is load-bearing. `sector` is a free-text field the owner types on the holding
 * modal, so `Other` and `other` are the same sector and used not to be the same key: a portfolio
 * whose largest sector was typed `Other` rendered `sector:Other` at slot 1 and the fold's
 * `sector:other` at slot 8, two slices of one bar with the same label and different colours.
 */
function lensKey(lens: AllocationLens, value: string): string {
  return `${LENS_PREFIX[lens]}:${value.trim().toLowerCase()}`;
}

/**
 * Where a lens puts everything it could not give its own slot.
 *
 * Lens-scoped so the fold merges with a group that already means "other" under that lens
 * (`security_type = 'other'` is a real asset class) instead of rendering a second row with the
 * same name and a different colour.
 */
const LENS_OTHER_KEY: Record<AllocationLens, string> = {
  asset_type: 'asset:other',
  sector: 'sector:other',
  account_type: 'account:other',
  tax_treatment: 'tax:other',
  symbol: 'symbol:other',
};

/**
 * The key for "the provider sent no sector at all".
 *
 * NOT `sector:unavailable`, and not anything else `lensKey` can produce: that key means missing
 * metadata, which is a different claim from "a real sector too small to plot", and since sector
 * is free text an owner can type the word `Unavailable`. The sentinel carries characters the
 * normalizer never emits, so no typed sector can land on it.
 */
const SECTOR_MISSING_KEY = 'sector:<none>';

export interface PortfolioSeriesPoint {
  date: string;
  value: number;
  estimated: boolean;
  /**
   * How many of the headline's accounts this point actually carries a balance for, as counted by
   * `/api/reports/investments`. A point covering fewer is a sum over a different set of accounts,
   * not a smaller portfolio.
   */
  covered_accounts: number;
  /** Which accounts those are. Two points with the same count over different accounts are not comparable. */
  covered_account_ids: readonly string[];
}

export interface PortfolioDelta {
  /** What the market did: the value change less the money moved in or out since the baseline. */
  change: number;
  /** Money the owner moved in (positive) or out since the baseline, kept out of `change`. */
  deposited: number;
  /** The snapshot the change is measured from, so the screen can name the date it used. */
  baseline: PortfolioSeriesPoint;
}

/**
 * The headline measured against the series it sits on, or null when it cannot be.
 *
 * `/api/reports/investments` derives `portfolio_value` and every point of `history` from one
 * account set, so these two numbers are comparable; before that they were not, and the screen
 * printed a delta off a series the headline was not in. On the day this was found the headline
 * moved $6.79 and the delta read $0, because the series excluded the crypto wallet the headline
 * included.
 *
 * Membership is CHECKED, not inferred. Value equality (`newest.value === marketValue`) says only
 * that two numbers match, which they also do by coincidence and which they can fail to do for
 * two unrelated reasons at once; `portfolioAccountIds` against each point's `covered_account_ids`
 * is the actual question (a count is not: one account leaving and another arriving keeps it), and
 * a point that does not cover exactly the headline's accounts yields null rather
 * than a delta measured across two different account sets.
 *
 * Straight after a sync the newest snapshot IS the headline, so the baseline is the snapshot
 * before it. When the headline has moved since the last sync, that snapshot is the baseline and
 * the delta is the movement the owner has not seen recorded yet. Taking the last two points
 * unconditionally reports zero in the first case whenever the balances have not changed and
 * hides live movement in the second.
 *
 * The ordering the route promises (`ORDER BY date ASC`, and `date` is UNIQUE on the table) is
 * asserted here rather than assumed, because this function names the baseline's date in copy the
 * owner reads: out of order, it would label a delta with the wrong day.
 */
export function getPortfolioDelta(
  marketValue: number | null,
  history: PortfolioSeriesPoint[],
  portfolioAccountIds: readonly string[] | null,
  flows: ReadonlyArray<{ date: string; amount: number }> = []
): PortfolioDelta | null {
  if (marketValue == null || portfolioAccountIds == null || history.length === 0) return null;

  for (let i = 1; i < history.length; i++) {
    if (history[i].date <= history[i - 1].date) return null;
  }

  const portfolio = new Set(portfolioAccountIds);
  const covers = (point: PortfolioSeriesPoint): boolean => {
    const ids = new Set(point.covered_account_ids);
    return ids.size === portfolio.size && [...ids].every((id) => portfolio.has(id));
  };

  const newest = history[history.length - 1];
  if (!covers(newest)) return null;

  // Half a cent: these are dollars converted from integer cents, so equality is exact in
  // practice and this only absorbs float representation.
  const baseline = Math.abs(newest.value - marketValue) < 0.005 ? history[history.length - 2] : newest;
  if (!baseline || !covers(baseline)) return null;

  const depositedCents = flows
    .filter((flow) => flow.date > baseline.date)
    .reduce((sum, flow) => sum + Math.round(flow.amount * 100), 0);
  const changeCents = Math.round((marketValue - baseline.value) * 100) - depositedCents;
  return { change: changeCents / 100, deposited: depositedCents / 100, baseline };
}

export interface CostBasisStats {
  totalCount: number;
  knownCount: number;
  missingCount: number;
  manualCount: number;
  providerCount: number;
  knownCostBasis: number;
  unrealized: number | null;
  returnPct: number | null;
  coveragePct: number;
  label: 'Complete' | 'Partial' | 'Missing' | 'No holdings';
}

interface AllocationAccumulator {
  key: string;
  label: string;
  value: number;
  count: number;
}

export interface AllocationSlice extends AllocationAccumulator {
  pct: number;
  color: string;
}

const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  brokerage: 'Brokerage',
  ira_traditional: 'Traditional IRA',
  ira_roth: 'Roth IRA',
  crypto_wallet: 'Crypto',
};

function titleCase(value: string): string {
  return value
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

/**
 * The basis a holding actually has, or null when nobody has reported one.
 *
 * A stored 0 is a provider declining to answer (migration 043), not a position acquired for
 * nothing. Admitted to the known set it books the whole market value as gain: a $104.99 Fidelity
 * cash sweep took the Investments header from a true 1.8% return to 7.1%, and no row underneath
 * accounted for the difference, because the per-row gain already refused a non-positive basis.
 * The header and the rows resolve the basis through here so they cannot disagree again.
 */
export function effectiveCostBasis(holding: Holding): number | null {
  const basis = holding.effective_cost_basis ?? holding.cost_basis;
  return basis != null && basis > 0 ? basis : null;
}

/**
 * Is this still a position, or one the owner has exited?
 *
 * A sold-out position is ZEROED, never deleted: `services/simplefin.ts` and
 * `services/coinbase.ts` set `quantity = 0, institution_value = 0` and deliberately leave
 * `cost_basis` alone, because the basis is what we knew and a repurchase should not start blind.
 * The write path is truthful. Three readers were not.
 *
 * `effectiveCostBasis` already refuses a non-positive BASIS, which is a different question, so a
 * sold row with a real provider basis sailed through it: it counted in `knownCount`, contributed
 * its whole basis to `knownCostBasis` and its zero to `knownValue`, and booked the entire basis as
 * an unrealized LOSS. Selling a $1,199.84 VT position took the Investments header from "up $112.79,
 * 4.90%" to "down $1,175.77, 51.06%" off the same money, and left a permanent
 * "$0 / -$1,199.84 / 100.0%" row for a security the owner no longer holds, labelled unrealized.
 *
 * `getAllocationSlices` already filtered `value > 0` for its own bar, with a comment naming this
 * exact case. One of three consumers was fixed. This is that filter, named and shared, so the
 * remaining two ask the same question the same way.
 */
export function isLivePosition(holding: Holding): boolean {
  // A worthless-but-held token still has quantity, so value alone is not the test.
  return (holding.quantity ?? 0) > 0 || holding.institution_value > 0;
}

export function holdingGain(holding: Holding): { gain: number; pct: number } | null {
  if (!isLivePosition(holding)) return null;
  const basis = effectiveCostBasis(holding);
  if (basis == null) return null;
  const gain = holding.institution_value - basis;
  return { gain, pct: (gain / basis) * 100 };
}

export function getCostBasisStats(allHoldings: Holding[]): CostBasisStats {
  // Coverage is about positions the owner still holds. A sold row has nothing left to cover, and
  // counting it dragged both the return and the coverage percentage.
  const holdings = allHoldings.filter(isLivePosition);
  const known = holdings.filter((holding) => effectiveCostBasis(holding) != null);
  const manualCount = holdings.filter((holding) => holding.cost_basis_quality === 'manual').length;
  const providerCount = known.filter((holding) =>
    holding.cost_basis_quality === 'provider' || !holding.cost_basis_quality
  ).length;
  const knownCostBasis = known.reduce((sum, holding) => sum + (effectiveCostBasis(holding) ?? 0), 0);
  const knownValue = known.reduce((sum, holding) => sum + holding.institution_value, 0);
  const missingCount = holdings.length - known.length;
  const unrealized = known.length > 0 ? knownValue - knownCostBasis : null;
  const returnPct = unrealized != null && knownCostBasis > 0
    ? (unrealized / knownCostBasis) * 100
    : null;
  const label = holdings.length === 0
    ? 'No holdings'
    : missingCount === 0
      ? 'Complete'
      : known.length === 0
        ? 'Missing'
        : 'Partial';

  return {
    totalCount: holdings.length,
    knownCount: known.length,
    missingCount,
    manualCount,
    providerCount,
    knownCostBasis,
    unrealized,
    returnPct,
    coveragePct: holdings.length > 0 ? (known.length / holdings.length) * 100 : 0,
    label,
  };
}

function getTaxTreatmentLabel(type: Account['type'] | undefined): string {
  if (type === 'ira_traditional' || type === 'ira_roth') return 'Tax-advantaged';
  if (type === 'brokerage') return 'Taxable';
  if (type === 'crypto_wallet') return 'Crypto';
  return 'Other';
}

function getAllocationGroup(
  holding: Holding,
  lens: AllocationLens,
  accountById: Map<string, Account>
): { key: string; label: string } {
  const account = accountById.get(holding.account_id);

  if (lens === 'asset_type') {
    const type = holding.security_type ?? 'unclassified';
    return { key: lensKey(lens, type), label: titleCase(type) };
  }

  if (lens === 'sector') {
    const sector = holding.sector?.trim();
    return sector
      ? { key: lensKey(lens, sector), label: sector }
      : { key: SECTOR_MISSING_KEY, label: 'Sector unavailable' };
  }

  if (lens === 'account_type') {
    const type = account?.type ?? 'other';
    return { key: lensKey(lens, type), label: ACCOUNT_TYPE_LABELS[type] ?? titleCase(type) };
  }

  if (lens === 'tax_treatment') {
    const label = getTaxTreatmentLabel(account?.type);
    return { key: lensKey(lens, label), label };
  }

  const symbol = holding.ticker ?? holding.security_name ?? 'Unlabeled security';
  return { key: lensKey(lens, symbol), label: symbol };
}

function getAllocationGroups(
  holdings: Holding[],
  lens: AllocationLens,
  accountById: Map<string, Account>
): AllocationAccumulator[] {
  const groups = new Map<string, AllocationAccumulator>();

  for (const holding of holdings) {
    const group = getAllocationGroup(holding, lens, accountById);
    const existing = groups.get(group.key);
    if (existing) {
      existing.value += holding.institution_value;
      existing.count += 1;
    } else {
      groups.set(group.key, {
        key: group.key,
        label: group.label,
        value: holding.institution_value,
        count: 1,
      });
    }
  }

  return Array.from(groups.values()).sort((a, b) => b.value - a.value);
}

function withAllocationPct(groups: AllocationAccumulator[], total: number): AllocationSlice[] {
  // `seriesColor`, not `ALLOCATION_COLORS[index % length]`. Modulo handed slot 1's colour to a
  // ninth group, so two slices of the same bar claimed the same identity; past eight the ramp has
  // nothing left to say, and `getAllocationSlices` folds rather than wraps. A caller that skips
  // the fold gets a neutral, which is visibly not a series.
  return groups.map((slice, index) => ({
    ...slice,
    pct: (slice.value / total) * 100,
    color: seriesColor(index),
  }));
}

/**
 * Groups past the ramp's last slot collapse into one, they do not wrap onto a used colour.
 *
 * The last slot is the fold, so `ALLOCATION_SLOTS - 1` groups keep their own identity. The fold
 * is NOT always the smallest groups: a group whose key already means "other" under this lens is
 * merged into it whatever its size, which is right (one row, one colour, one meaning) and means
 * the fold can come out larger than anything kept. `security_type = 'other'` at 53% of a
 * ten-class portfolio rendered last, after slices a twentieth its size, so the bar stopped
 * reading largest-to-smallest. The re-sort is what keeps that promise; position in this list is
 * not a claim about rank on its own.
 */
function foldToSlots(groups: AllocationAccumulator[], lens: AllocationLens): AllocationAccumulator[] {
  if (groups.length <= ALLOCATION_SLOTS) return groups;

  const otherKey = LENS_OTHER_KEY[lens];
  const kept: AllocationAccumulator[] = [];
  const folded: AllocationAccumulator = { key: otherKey, label: 'Other', value: 0, count: 0 };

  for (const group of groups) {
    if (kept.length < ALLOCATION_SLOTS - 1 && group.key !== otherKey) kept.push(group);
    else {
      folded.value += group.value;
      folded.count += group.count;
    }
  }

  return [...kept, folded].sort((a, b) => b.value - a.value);
}

export function getAllocationSlices(
  holdings: Holding[],
  lens: AllocationLens,
  accountById: Map<string, Account>
): AllocationSlice[] {
  const total = holdings.reduce((sum, holding) => sum + holding.institution_value, 0);
  if (total <= 0) return [];

  // A group worth nothing is not an allocation, and a group worth less than nothing is not a
  // width on a bar drawn out of percentages. Sold positions are zeroed rather than deleted
  // (services/simplefin.ts, services/coinbase.ts), so without this a sector the owner exited
  // keeps a 0% row with its own colour on the bar forever, which is a standing line nobody can
  // act on. It also keeps the fold honest: eight visible slices, not seven and a blank.
  const groups = getAllocationGroups(holdings, lens, accountById).filter((group) => group.value > 0);
  if (groups.length === 0) return [];

  return withAllocationPct(foldToSlots(groups, lens), total);
}
