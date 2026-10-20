import type Database from 'better-sqlite3';

export interface PortfolioFlow {
  date: string;
  /** Integer cents, positive when money arrived in the portfolio from outside it. */
  amount: number;
}

export interface FlowRow {
  amount: number;
  category_id: string | null;
  transfer_status: string | null;
  is_internal_trade: number;
}

const PAIRED_TRANSFER = new Set(['candidate', 'confirmed']);

/**
 * What a row on a market-driven account added to its value from outside, in cents, or 0. A buy or
 * sell paid with cash already inside the account (is_internal_trade) moves nothing. Otherwise a
 * crypto buy is how money enters a wallet that was never sent a deposit and a crypto sell is its
 * mirror (so a convert nets to zero), and a contribution or withdrawal moves the value by its
 * signed amount. Dividends and the core sweep are market-neutral, because the ledger cannot see
 * prices.
 */
export function externalMarketFlow(txn: FlowRow, accountType: string): number {
  if (txn.is_internal_trade === 1) return 0;
  const cat = txn.category_id ?? '';
  if (cat === 'cat_inv_buy' || cat === 'cat_crypto_buy') return Math.abs(txn.amount);
  if (cat === 'cat_crypto_sell') return -Math.abs(txn.amount);
  if (cat === 'cat_inv_transfer' || (accountType !== 'crypto_wallet' && PAIRED_TRANSFER.has(txn.transfer_status ?? ''))) {
    return txn.amount;
  }
  return 0;
}

/** Money the owner moved into or out of the portfolio accounts, by day, by `externalMarketFlow`. */
export function portfolioExternalFlows(db: Database.Database, accountIds: readonly string[]): PortfolioFlow[] {
  if (accountIds.length === 0) return [];
  const rows = db.prepare(`
    SELECT t.date, t.amount, t.category_id, t.transfer_status, t.is_internal_trade, a.type
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    WHERE t.account_id IN (${accountIds.map(() => '?').join(',')})
      AND t.pending = 0
      AND COALESCE(t.duplicate_status, 'none') <> 'confirmed'
    ORDER BY t.date ASC
  `).all(...accountIds) as Array<FlowRow & { date: string; type: string }>;
  const byDate = new Map<string, number>();
  for (const row of rows) {
    const flow = externalMarketFlow(row, row.type);
    if (flow !== 0) byDate.set(row.date, (byDate.get(row.date) ?? 0) + flow);
  }
  return [...byDate].filter(([, amount]) => amount !== 0).map(([date, amount]) => ({ date, amount }));
}
