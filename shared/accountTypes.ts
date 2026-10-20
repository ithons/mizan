/** Valued at market: the ledger records trades, not the price moves that change the balance. */
export const MARKET_DRIVEN_TYPES: ReadonlySet<string> = new Set(['brokerage', 'ira_traditional', 'ira_roth', 'crypto_wallet']);

export const INVESTED_TYPES: ReadonlySet<string> = new Set(['brokerage', 'ira_traditional', 'ira_roth']);

/** 'closed' accounts were checking or savings, and keep that bucket for history. */
export const NET_WORTH_LIQUID_TYPES: ReadonlySet<string> = new Set(['checking', 'savings', 'cash', 'closed']);

export type NetWorthBucket = 'liquid' | 'invested' | 'crypto' | 'other';

export function bucketOf(type: string): NetWorthBucket {
  if (NET_WORTH_LIQUID_TYPES.has(type)) return 'liquid';
  if (INVESTED_TYPES.has(type)) return 'invested';
  if (type === 'crypto_wallet') return 'crypto';
  return 'other';
}
