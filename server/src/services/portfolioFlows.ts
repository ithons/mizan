import type Database from 'better-sqlite3';

export interface PortfolioFlow {
  date: string;
  /** Integer cents, positive when money arrived in the portfolio from outside it. */
  amount: number;
}

/**
 * Money the owner moved into or out of the portfolio accounts, by day. A trade inside an account
 * moves nothing; a transfer between two portfolio accounts nets to zero across the day.
 */
export function portfolioExternalFlows(db: Database.Database, accountIds: readonly string[]): PortfolioFlow[] {
  if (accountIds.length === 0) return [];
  return db.prepare(`
    WITH RECURSIVE transfer_categories(id) AS (
      SELECT id FROM categories WHERE id IN ('cat_xfer', 'cat_inv_transfer')
      UNION ALL
      SELECT c.id FROM categories c JOIN transfer_categories t ON c.parent_id = t.id
    )
    SELECT t.date, SUM(t.amount) AS amount
    FROM transactions t
    WHERE t.account_id IN (${accountIds.map(() => '?').join(',')})
      AND t.pending = 0
      AND t.is_internal_trade = 0
      AND COALESCE(t.duplicate_status, 'none') <> 'confirmed'
      AND (
        t.transfer_status IN ('candidate', 'confirmed')
        OR COALESCE(t.category_id, '') IN (SELECT id FROM transfer_categories)
      )
    GROUP BY t.date
    HAVING SUM(t.amount) <> 0
    ORDER BY t.date ASC
  `).all(...accountIds) as PortfolioFlow[];
}
