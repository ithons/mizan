export type BalanceChangeProvider = 'coinbase' | 'simplefin' | 'manual';

export interface AccountBalanceChange {
  accountId: string;
  accountName: string;
  provider: BalanceChangeProvider;
  previousBalance: number;
  newBalance: number;
  isLiability: boolean;
  currency?: string | null;
}

export function balanceDelta(change: AccountBalanceChange): number {
  return change.newBalance - change.previousBalance;
}

export function netWorthImpact(change: AccountBalanceChange): number {
  const delta = balanceDelta(change);
  return change.isLiability ? -delta : delta;
}

function formatMoney(value: number, currency?: string | null): string {
  const formatter = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency || 'USD',
    maximumFractionDigits: 2,
  });
  return formatter.format(value);
}

function formatSignedMoney(value: number, currency?: string | null): string {
  const sign = value >= 0 ? '+' : '-';
  return `${sign}${formatMoney(Math.abs(value), currency)}`;
}

// Callers pass integer cents, so any real change is at least 1 cent. (The old 0.005 threshold
// was a sub-cent float-noise guard from the dollars era and is a no-op on integers.)
export function balancesDiffer(previousBalance: number, newBalance: number): boolean {
  return Math.round(newBalance) !== Math.round(previousBalance);
}

export function describeBalanceChange(change: AccountBalanceChange): string {
  const delta = balanceDelta(change);
  const impact = netWorthImpact(change);
  const provider = change.provider === 'coinbase'
    ? 'Coinbase'
    : change.provider === 'simplefin'
      ? 'SimpleFIN'
      : 'Manual';

  return [
    `${change.accountName} balance changed from ${formatMoney(change.previousBalance, change.currency)} to ${formatMoney(change.newBalance, change.currency)}`,
    `${formatSignedMoney(delta, change.currency)} via ${provider}`,
    `net worth impact ${formatSignedMoney(impact, change.currency)}`,
  ].join('; ');
}
