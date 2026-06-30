import type { Account, Holding, InvestmentTransaction } from '@shared/types';

export type AllocationLens = 'asset_type' | 'sector' | 'account_type' | 'tax_treatment' | 'symbol';

export const ALLOCATION_LENSES: Array<{ id: AllocationLens; label: string }> = [
  { id: 'asset_type', label: 'Asset' },
  { id: 'sector', label: 'Sector' },
  { id: 'account_type', label: 'Account' },
  { id: 'tax_treatment', label: 'Tax' },
  { id: 'symbol', label: 'Symbol' },
];

export const ALLOCATION_COLORS = [
  '#6487f0',
  '#32bfa3',
  '#ef6f8a',
  '#e2a53f',
  '#9b7ef2',
  '#5bbad5',
  '#f08c6d',
  '#7bbf6a',
];

export const STARTER_ASSET_TARGETS = [
  { key: 'asset:etf', label: 'ETF', targetPct: 60 },
  { key: 'asset:mutual_fund', label: 'Mutual Fund', targetPct: 20 },
  { key: 'asset:equity', label: 'Equity', targetPct: 15 },
  { key: 'asset:cash', label: 'Cash', targetPct: 5 },
  { key: 'asset:crypto', label: 'Crypto', targetPct: 0 },
  { key: 'asset:other', label: 'Other', targetPct: 0 },
] satisfies AllocationTarget[];

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

export interface AllocationTarget {
  key: string;
  label: string;
  targetPct: number;
}

export interface AllocationDriftItem {
  key: string;
  label: string;
  value: number;
  currentPct: number;
  targetPct: number;
  driftPct: number;
  severity: 'on_target' | 'watch' | 'drifting';
}

export interface AllocationDriftSummary {
  label: 'No target' | 'On target' | 'Watch' | 'Drifting';
  detail: string;
  maxDriftPct: number;
  items: AllocationDriftItem[];
}

export interface ConcentrationSummary {
  totalValue: number;
  holdingCount: number;
  largestPosition: AllocationSlice | null;
  topFiveValue: number;
  topFivePct: number | null;
  largestAccount: AllocationSlice | null;
  label: 'No holdings' | 'Broad' | 'Moderate' | 'Concentrated';
  detail: string;
}

export interface InvestmentActivitySummary {
  transactionCount: number;
  buyAmount: number;
  sellAmount: number;
  dividendAmount: number;
  feeAmount: number;
  transferAmount: number;
  otherAmount: number;
  netAmount: number;
  saleCount: number;
  realizedGain: number | null;
  realizedGainLabel: 'Not available';
  realizedGainDetail: string;
}

export interface InvestmentDataQualityIssue {
  id: string;
  label: string;
  detail: string;
  severity: 'info' | 'warning' | 'attention';
}

export interface InvestmentDataQualitySummary {
  status: 'empty' | 'strong' | 'limited' | 'attention';
  label: string;
  detail: string;
  issues: InvestmentDataQualityIssue[];
}

export interface InvestmentDataQualityInput {
  holdings: Holding[];
  transactions: InvestmentTransaction[];
  investmentAccountCount: number;
  accountById: Map<string, Account>;
  historyPointCount: number;
}

const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  brokerage: 'Brokerage',
  ira_traditional: 'Traditional IRA',
  ira_roth: 'Roth IRA',
  crypto_wallet: 'Crypto',
};

export function formatHoldingCount(count: number): string {
  return `${count} holding${count === 1 ? '' : 's'}`;
}

function titleCase(value: string): string {
  return value
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function getCostBasisStats(holdings: Holding[]): CostBasisStats {
  const known = holdings.filter((holding) => holding.cost_basis != null);
  const manualCount = holdings.filter((holding) => holding.cost_basis_quality === 'manual').length;
  const providerCount = known.filter((holding) =>
    holding.cost_basis_quality === 'provider' || !holding.cost_basis_quality
  ).length;
  const knownCostBasis = known.reduce((sum, holding) => sum + (holding.cost_basis ?? 0), 0);
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

export function costBasisTone(label: CostBasisStats['label']): string {
  if (label === 'Complete') return 'text-green';
  if (label === 'No holdings') return 'text-muted';
  return 'text-amber';
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
    return { key: `asset:${type}`, label: titleCase(type) };
  }

  if (lens === 'sector') {
    const sector = holding.sector?.trim();
    return sector
      ? { key: `sector:${sector}`, label: sector }
      : { key: 'sector:unavailable', label: 'Sector unavailable' };
  }

  if (lens === 'account_type') {
    const type = account?.type ?? 'other';
    return { key: `account:${type}`, label: ACCOUNT_TYPE_LABELS[type] ?? titleCase(type) };
  }

  if (lens === 'tax_treatment') {
    const label = getTaxTreatmentLabel(account?.type);
    return { key: `tax:${label}`, label };
  }

  const symbol = holding.ticker ?? holding.security_name ?? 'Unlabeled security';
  return { key: `symbol:${symbol}`, label: symbol };
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
  return groups.map((slice, index) => ({
    ...slice,
    pct: (slice.value / total) * 100,
    color: ALLOCATION_COLORS[index % ALLOCATION_COLORS.length],
  }));
}

export function getAllocationSlices(
  holdings: Holding[],
  lens: AllocationLens,
  accountById: Map<string, Account>
): AllocationSlice[] {
  const total = holdings.reduce((sum, holding) => sum + holding.institution_value, 0);
  if (total <= 0) return [];

  const sorted = getAllocationGroups(holdings, lens, accountById);
  const visible = lens === 'symbol' && sorted.length > 8
    ? [
        ...sorted.slice(0, 7),
        sorted.slice(7).reduce<AllocationAccumulator>(
          (rest, slice) => ({
            key: 'symbol:other',
            label: 'Other',
            value: rest.value + slice.value,
            count: rest.count + slice.count,
          }),
          { key: 'symbol:other', label: 'Other', value: 0, count: 0 }
        ),
      ]
    : sorted;

  return withAllocationPct(visible, total);
}

function driftSeverity(absDriftPct: number): AllocationDriftItem['severity'] {
  if (absDriftPct >= 10) return 'drifting';
  if (absDriftPct >= 5) return 'watch';
  return 'on_target';
}

export function getAllocationDrift(
  slices: AllocationSlice[],
  targets: AllocationTarget[]
): AllocationDriftSummary {
  if (slices.length === 0 || targets.length === 0) {
    return {
      label: 'No target',
      detail: 'No allocation target can be compared for this view.',
      maxDriftPct: 0,
      items: [],
    };
  }

  const sliceByKey = new Map(slices.map((slice) => [slice.key, slice]));
  const targetByKey = new Map(targets.map((target) => [target.key, target]));
  const keys = new Set([...sliceByKey.keys(), ...targetByKey.keys()]);
  const items = Array.from(keys)
    .map((key) => {
      const slice = sliceByKey.get(key);
      const target = targetByKey.get(key);
      const currentPct = slice?.pct ?? 0;
      const targetPct = target?.targetPct ?? 0;
      const driftPct = currentPct - targetPct;
      const absDriftPct = Math.abs(driftPct);

      return {
        key,
        label: slice?.label ?? target?.label ?? key,
        value: slice?.value ?? 0,
        currentPct,
        targetPct,
        driftPct,
        severity: driftSeverity(absDriftPct),
      };
    })
    .sort((a, b) => Math.abs(b.driftPct) - Math.abs(a.driftPct));

  const maxDriftPct = Math.abs(items[0]?.driftPct ?? 0);
  const label = maxDriftPct >= 10
    ? 'Drifting'
    : maxDriftPct >= 5
      ? 'Watch'
      : 'On target';
  const leader = items[0];
  const detail = leader
    ? `${leader.label} is ${Math.abs(leader.driftPct).toFixed(1)} points ${leader.driftPct >= 0 ? 'above' : 'below'} target.`
    : 'No allocation target can be compared for this view.';

  return {
    label,
    detail,
    maxDriftPct,
    items,
  };
}

export function getAllocationQualityLabel(
  holdings: Holding[],
  lens: AllocationLens,
  accountById: Map<string, Account>
): string {
  if (holdings.length === 0) return 'No holdings';

  if (lens === 'account_type' || lens === 'tax_treatment') {
    const missingAccounts = holdings.filter((holding) => !accountById.has(holding.account_id)).length;
    if (missingAccounts > 0) return `${formatHoldingCount(missingAccounts)} missing account links`;
    return lens === 'tax_treatment' ? 'Inferred from account type' : 'Linked to accounts';
  }

  if (lens === 'asset_type') {
    const unclassified = holdings.filter((holding) => !holding.security_type).length;
    if (unclassified > 0) return `${formatHoldingCount(unclassified)} unclassified`;
    return 'Classified by provider type';
  }

  if (lens === 'sector') {
    const missingSector = holdings.filter((holding) => !holding.sector).length;
    if (missingSector === holdings.length) return 'Sector metadata not available';
    if (missingSector > 0) return `${formatHoldingCount(missingSector)} missing sector`;
    return 'Sector metadata available';
  }

  const unlabeled = holdings.filter((holding) => !holding.ticker && !holding.security_name).length;
  if (unlabeled > 0) return `${formatHoldingCount(unlabeled)} unlabeled`;
  return 'Labeled by security';
}

export function getConcentrationSummary(
  holdings: Holding[],
  accountById: Map<string, Account>
): ConcentrationSummary {
  const totalValue = holdings.reduce((sum, holding) => sum + holding.institution_value, 0);

  if (totalValue <= 0) {
    return {
      totalValue: 0,
      holdingCount: holdings.length,
      largestPosition: null,
      topFiveValue: 0,
      topFivePct: null,
      largestAccount: null,
      label: 'No holdings',
      detail: 'No current holding value available.',
    };
  }

  const symbolSlices = withAllocationPct(getAllocationGroups(holdings, 'symbol', accountById), totalValue);
  const accountSlices = withAllocationPct(getAllocationGroups(holdings, 'account_type', accountById), totalValue);
  const largestPosition = symbolSlices[0] ?? null;
  const largestAccount = accountSlices[0] ?? null;
  const topFiveValue = symbolSlices.slice(0, 5).reduce((sum, slice) => sum + slice.value, 0);
  const topFivePct = (topFiveValue / totalValue) * 100;
  const largestPct = largestPosition?.pct ?? 0;
  const label = largestPct >= 30 || topFivePct >= 70
    ? 'Concentrated'
    : largestPct >= 15 || topFivePct >= 50
      ? 'Moderate'
      : 'Broad';

  return {
    totalValue,
    holdingCount: holdings.length,
    largestPosition,
    topFiveValue,
    topFivePct,
    largestAccount,
    label,
    detail: `Top 5 positions are ${topFivePct.toFixed(1)}% of visible holdings.`,
  };
}

function absAmount(value: number | null | undefined): number {
  return Math.abs(value ?? 0);
}

export function getInvestmentActivitySummary(
  transactions: InvestmentTransaction[]
): InvestmentActivitySummary {
  const saleCount = transactions.filter((transaction) => transaction.type === 'sell').length;

  const summary = transactions.reduce(
    (activity, transaction) => {
      activity.netAmount += transaction.amount;

      if (transaction.type === 'buy') activity.buyAmount += absAmount(transaction.amount);
      else if (transaction.type === 'sell') activity.sellAmount += absAmount(transaction.amount);
      else if (transaction.type === 'dividend') activity.dividendAmount += absAmount(transaction.amount);
      else if (transaction.type === 'transfer') activity.transferAmount += absAmount(transaction.amount);
      else if (transaction.type === 'fee') activity.feeAmount += absAmount(transaction.fees ?? transaction.amount);
      else activity.otherAmount += absAmount(transaction.amount);

      if (transaction.fees != null && transaction.type !== 'fee') {
        activity.feeAmount += absAmount(transaction.fees);
      }

      return activity;
    },
    {
      transactionCount: transactions.length,
      buyAmount: 0,
      sellAmount: 0,
      dividendAmount: 0,
      feeAmount: 0,
      transferAmount: 0,
      otherAmount: 0,
      netAmount: 0,
      saleCount,
      realizedGain: null,
      realizedGainLabel: 'Not available' as const,
      realizedGainDetail: saleCount > 0
        ? 'Sale transactions are imported, but realized gain needs lot-level sale cost basis.'
        : 'No sale transactions are imported for this period.',
    }
  );

  return summary;
}

export function getInvestmentDataQualitySummary({
  holdings,
  transactions,
  investmentAccountCount,
  accountById,
  historyPointCount,
}: InvestmentDataQualityInput): InvestmentDataQualitySummary {
  if (investmentAccountCount === 0 && holdings.length === 0) {
    return {
      status: 'empty',
      label: 'No Investment Data',
      detail: 'Connect an investment account or Coinbase to evaluate holdings quality.',
      issues: [
        {
          id: 'no-investment-source',
          label: 'No investment source',
          detail: 'Mizan has no connected investment account to analyze yet.',
          severity: 'attention',
        },
      ],
    };
  }

  const costBasis = getCostBasisStats(holdings);
  const activity = getInvestmentActivitySummary(transactions);
  const issues: InvestmentDataQualityIssue[] = [];
  const missingAccountLinks = holdings.filter((holding) => !accountById.has(holding.account_id)).length;
  const unclassifiedHoldings = holdings.filter((holding) => !holding.security_type).length;
  const missingSectorHoldings = holdings.filter((holding) => !holding.sector).length;

  if (holdings.length === 0) {
    issues.push({
      id: 'no-holdings',
      label: 'No holdings imported',
      detail: 'An investment account exists, but no current holdings are available.',
      severity: 'attention',
    });
  }

  if (missingAccountLinks > 0) {
    issues.push({
      id: 'missing-account-links',
      label: 'Missing account links',
      detail: `${formatHoldingCount(missingAccountLinks)} cannot be tied back to an account.`,
      severity: 'attention',
    });
  }

  if (costBasis.totalCount > 0 && costBasis.missingCount === costBasis.totalCount) {
    issues.push({
      id: 'cost-basis-missing',
      label: 'Cost basis missing',
      detail: 'Unrealized gain and return cannot be calculated from provider data.',
      severity: 'attention',
    });
  } else if (costBasis.missingCount > 0) {
    issues.push({
      id: 'cost-basis-partial',
      label: 'Cost basis partial',
      detail: `${formatHoldingCount(costBasis.missingCount)} are excluded from gain and return calculations.`,
      severity: 'warning',
    });
  }

  if (unclassifiedHoldings > 0) {
    issues.push({
      id: 'security-type-missing',
      label: 'Security type missing',
      detail: `${formatHoldingCount(unclassifiedHoldings)} lack asset-class classification.`,
      severity: 'warning',
    });
  }

  if (holdings.length > 0 && missingSectorHoldings === holdings.length) {
    issues.push({
      id: 'sector-missing',
      label: 'Sector unavailable',
      detail: 'Sector allocation needs security metadata that is not available for these holdings.',
      severity: 'info',
    });
  } else if (missingSectorHoldings > 0) {
    issues.push({
      id: 'sector-partial',
      label: 'Sector partial',
      detail: `${formatHoldingCount(missingSectorHoldings)} lack sector metadata.`,
      severity: 'info',
    });
  }

  if (activity.transactionCount === 0) {
    issues.push({
      id: 'no-investment-transactions',
      label: 'No activity imported',
      detail: 'Investment transaction history is unavailable for this period.',
      severity: 'info',
    });
  }

  if (activity.saleCount > 0) {
    issues.push({
      id: 'realized-gain-unavailable',
      label: 'Realized gain unavailable',
      detail: activity.realizedGainDetail,
      severity: 'info',
    });
  }

  if (historyPointCount <= 1) {
    issues.push({
      id: 'history-limited',
      label: 'History limited',
      detail: 'Portfolio trend analysis needs more than one historical snapshot.',
      severity: 'info',
    });
  }

  const status = issues.some((issue) => issue.severity === 'attention')
    ? 'attention'
    : issues.length > 0
      ? 'limited'
      : 'strong';
  const label = status === 'attention'
    ? 'Needs Attention'
    : status === 'limited'
      ? 'Limited'
      : 'Strong';
  const detail = issues.length === 0
    ? 'Imported holdings have enough metadata for current portfolio summaries.'
    : `${issues.length} data limitation${issues.length === 1 ? '' : 's'} affect investment analysis.`;

  return {
    status,
    label,
    detail,
    issues,
  };
}
