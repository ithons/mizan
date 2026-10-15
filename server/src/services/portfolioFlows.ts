import type Database from 'better-sqlite3';

export interface PortfolioFlow {
  date: string;
  /** Integer cents, positive when money arrived in the portfolio from outside it. */
  amount: number;
}

/**
 * Money the owner moved into or out of the portfolio accounts, by day, by the same convention the
 * snapshot backfill reverses history with: on a brokerage or IRA it is the transfers (a trade inside
 * the account moves nothing); on a crypto wallet it is the buys and sells, with fiat deposits held
 * flat, because a buy is how money enters a wallet that was never sent a deposit.
 */
export function portfolioExternalFlows(db: Database.Database, accountIds: readonly string[]): PortfolioFlow[] {
  if (accountIds.length === 0) return [];
  return db.prepare(`
    WITH RECURSIVE transfer_categories(id) AS (
      SELECT id FROM categories WHERE id IN ('cat_xfer', 'cat_inv_transfer')
      UNION ALL
      SELECT c.id FROM categories c JOIN transfer_categories t ON c.parent_id = t.id
    )
    SELECT t.date,
           SUM(CASE
             WHEN a.type = 'crypto_wallet' AND t.category_id = 'cat_crypto_buy' THEN ABS(t.amount)
             WHEN a.type = 'crypto_wallet' AND t.category_id = 'cat_crypto_sell' THEN -ABS(t.amount)
             WHEN a.type = 'crypto_wallet' THEN 0
             ELSE t.amount
           END) AS amount
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    WHERE t.account_id IN (${accountIds.map(() => '?').join(',')})
      AND t.pending = 0
      AND t.is_internal_trade = 0
      AND COALESCE(t.duplicate_status, 'none') <> 'confirmed'
      AND (
        (a.type = 'crypto_wallet' AND t.category_id IN ('cat_crypto_buy', 'cat_crypto_sell'))
        OR (a.type <> 'crypto_wallet' AND (
          t.transfer_status IN ('candidate', 'confirmed')
          OR COALESCE(t.category_id, '') IN (SELECT id FROM transfer_categories)
        ))
      )
    GROUP BY t.date
    HAVING SUM(CASE
             WHEN a.type = 'crypto_wallet' AND t.category_id = 'cat_crypto_buy' THEN ABS(t.amount)
             WHEN a.type = 'crypto_wallet' AND t.category_id = 'cat_crypto_sell' THEN -ABS(t.amount)
             WHEN a.type = 'crypto_wallet' THEN 0
             ELSE t.amount
           END) <> 0
    ORDER BY t.date ASC
  `).all(...accountIds) as PortfolioFlow[];
}
