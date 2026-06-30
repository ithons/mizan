import type { Account, NetWorthSnapshot } from '@shared/types';

export interface NetWorthClassAttribution {
  id: 'liquid' | 'investments' | 'crypto' | 'other_assets' | 'liabilities';
  label: string;
  previous: number;
  current: number;
  balance_delta: number;
  net_worth_delta: number;
  color: string;
}

export interface NetWorthAccountAttribution {
  account_id: string;
  account_name: string;
  institution_name?: string | null;
  type?: string | null;
  is_liability: boolean;
  previous_balance: number;
  current_balance: number;
  balance_delta: number;
  net_worth_delta: number;
}

export interface NetWorthAttribution {
  previous_snapshot: NetWorthSnapshot;
  current_snapshot: NetWorthSnapshot;
  net_worth_delta: number;
  asset_delta: number;
  liability_delta: number;
  class_deltas: NetWorthClassAttribution[];
  account_deltas: NetWorthAccountAttribution[];
}

function numeric(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function parseBreakdown(raw: string): Record<string, number> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed)
        .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]))
    );
  } catch {
    return {};
  }
}

function snapshotOtherAssets(snapshot: NetWorthSnapshot): number {
  return Math.max(
    0,
    snapshot.total_assets -
      numeric(snapshot.liquid_assets) -
      numeric(snapshot.investment_assets) -
      numeric(snapshot.crypto_assets)
  );
}

function classDelta(
  id: NetWorthClassAttribution['id'],
  label: string,
  previous: number,
  current: number,
  color: string,
  invertForNetWorth = false
): NetWorthClassAttribution {
  const balanceDelta = current - previous;
  return {
    id,
    label,
    previous,
    current,
    balance_delta: balanceDelta,
    net_worth_delta: invertForNetWorth ? -balanceDelta : balanceDelta,
    color,
  };
}

export function buildNetWorthAttribution({
  snapshots,
  accounts = [],
  currentSnapshotId,
}: {
  snapshots: NetWorthSnapshot[];
  accounts?: Account[];
  currentSnapshotId?: string;
}): NetWorthAttribution | null {
  const ordered = [...snapshots].sort((a, b) => a.date.localeCompare(b.date));
  const currentIndex = currentSnapshotId
    ? ordered.findIndex((snapshot) => snapshot.id === currentSnapshotId)
    : ordered.length - 1;
  if (currentIndex <= 0) return null;

  const previous = ordered[currentIndex - 1];
  const current = ordered[currentIndex];
  const previousBreakdown = parseBreakdown(previous.breakdown);
  const currentBreakdown = parseBreakdown(current.breakdown);
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const accountIds = new Set([...Object.keys(previousBreakdown), ...Object.keys(currentBreakdown)]);

  const accountDeltas = Array.from(accountIds)
    .map((accountId): NetWorthAccountAttribution => {
      const account = accountById.get(accountId);
      const previousBalance = previousBreakdown[accountId] ?? 0;
      const currentBalance = currentBreakdown[accountId] ?? 0;
      const balanceDelta = currentBalance - previousBalance;
      const isLiability = account?.is_liability ?? false;

      return {
        account_id: accountId,
        account_name: account?.account_name ?? accountId,
        institution_name: account?.institution_name,
        type: account?.type,
        is_liability: isLiability,
        previous_balance: previousBalance,
        current_balance: currentBalance,
        balance_delta: balanceDelta,
        net_worth_delta: isLiability ? -balanceDelta : balanceDelta,
      };
    })
    .sort((a, b) => Math.abs(b.net_worth_delta) - Math.abs(a.net_worth_delta));

  const classDeltas = [
    classDelta('liquid', 'Liquid', numeric(previous.liquid_assets), numeric(current.liquid_assets), '#32bfa3'),
    classDelta('investments', 'Investments', numeric(previous.investment_assets), numeric(current.investment_assets), '#6487f0'),
    classDelta('crypto', 'Crypto', numeric(previous.crypto_assets), numeric(current.crypto_assets), '#e2a53f'),
    classDelta('other_assets', 'Other assets', snapshotOtherAssets(previous), snapshotOtherAssets(current), '#a78bfa'),
    classDelta('liabilities', 'Liabilities', previous.total_liabilities, current.total_liabilities, '#ef6f8a', true),
  ].filter((item) => item.previous !== 0 || item.current !== 0 || item.balance_delta !== 0);

  return {
    previous_snapshot: previous,
    current_snapshot: current,
    net_worth_delta: current.net_worth - previous.net_worth,
    asset_delta: current.total_assets - previous.total_assets,
    liability_delta: current.total_liabilities - previous.total_liabilities,
    class_deltas: classDeltas,
    account_deltas: accountDeltas,
  };
}
