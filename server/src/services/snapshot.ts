import { v4 as uuidv4 } from 'uuid';
import { format } from 'date-fns';
import type Database from 'better-sqlite3';
import { getDb } from '../db/index';
import { readPortfolioAccounts } from './netWorthHistory';
import { liabilitiesInDoubt } from './liabilitySign';
import { bucketOf } from '../../../shared/accountTypes';

/**
 * The portfolio's membership, frozen as JSON, for a row about to be written.
 *
 * `readPortfolioAccounts` filters on `is_liability = 0 AND is_hidden = 0`, which is a subset of the
 * `is_hidden = 0` a breakdown is written under, so every id here has a value on the row beside it.
 *
 * Sorted so two rows written from the same set are byte-identical, which is what makes "did the set
 * change between these two points" a comparison rather than a parse.
 */
function frozenPortfolio(portfolioIds: string[]): string {
  return JSON.stringify(portfolioIds.slice().sort());
}

/**
 * A card whose direction the sign check cannot settle is left out of the sheet and counted as
 * uncovered: its stored sign is the provider's, which for these cards carries no information, and
 * a measured row is never re-examined.
 */
export function takeSnapshot(): void {
  const db = getDb();

  const visible = db.prepare(`
    SELECT id, current_balance, is_liability, type
    FROM accounts
    WHERE is_hidden = 0
  `).all() as Array<{ id: string; current_balance: number; is_liability: number; type: string }>;
  const inDoubt = liabilitiesInDoubt(db);
  const accounts = visible.filter((account) => !(account.is_liability && inDoubt.has(account.id)));

  let total_assets = 0;
  let total_liabilities = 0;
  let liquid_assets = 0;
  let investment_assets = 0;
  let crypto_assets = 0;
  const breakdown: Record<string, number> = {};

  for (const account of accounts) {
    breakdown[account.id] = account.current_balance;
    if (account.is_liability) {
      total_liabilities += account.current_balance;
    } else {
      total_assets += account.current_balance;
      const bucket = bucketOf(account.type);
      if (bucket === 'liquid') liquid_assets += account.current_balance;
      else if (bucket === 'invested') investment_assets += account.current_balance;
      else if (bucket === 'crypto') crypto_assets += account.current_balance;
    }
  }

  const net_worth = total_assets - total_liabilities;
  const today = format(new Date(), 'yyyy-MM-dd');
  const now = new Date().toISOString();

  const existing = db.prepare(
    'SELECT id FROM net_worth_snapshots WHERE date = ?'
  ).get(today) as { id: string } | undefined;

  const coveredAccounts = accounts.length;
  const totalAccounts = visible.length;

  // Which of those accounts were the portfolio, decided here rather than by whoever reads the row
  // later. `/api/reports/investments` used to intersect every historical breakdown with today's
  // accounts table, so retyping an account into a portfolio type moved every past point: on a copy
  // of the live ledger taken 2026-08-01, retyping Wealthfront Cash to `brokerage` moved 2026-07-30
  // from $2,445.89 to $3,447.59 without touching a snapshot. This is 'recorded' in the strict sense
  // that the code writing the balances wrote the set alongside them, in the same statement.
  const portfolioAccounts = frozenPortfolio(readPortfolioAccounts(db).map((a) => a.id));

  if (existing) {
    db.prepare(`
      UPDATE net_worth_snapshots
      SET total_assets = ?, total_liabilities = ?, net_worth = ?, breakdown = ?,
          liquid_assets = ?, investment_assets = ?, crypto_assets = ?,
          covered_accounts = ?, total_accounts = ?,
          portfolio_accounts = ?, portfolio_accounts_source = 'recorded', taken_at = ?
      WHERE id = ?
    `).run(total_assets, total_liabilities, net_worth, JSON.stringify(breakdown),
           liquid_assets, investment_assets, crypto_assets,
           coveredAccounts, totalAccounts, portfolioAccounts, now, existing.id);
  } else {
    db.prepare(`
      INSERT INTO net_worth_snapshots
        (id, date, total_assets, total_liabilities, net_worth, breakdown, is_estimated,
         liquid_assets, investment_assets, crypto_assets, covered_accounts, total_accounts,
         created_at, portfolio_accounts, portfolio_accounts_source, taken_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, 'recorded', ?)
    `).run(uuidv4(), today, total_assets, total_liabilities, net_worth, JSON.stringify(breakdown),
           liquid_assets, investment_assets, crypto_assets, coveredAccounts, totalAccounts, now,
           portfolioAccounts, now);
  }

  takeHoldingsSnapshot(db, today, now);
}

// Mirrors net_worth_snapshots' one-row-per-day pattern above, at the individual holding
// level, so a position's value over time can be charted (holdings itself is overwritten
// on every sync and only ever reflects the current state).
export function takeHoldingsSnapshot(db: Database.Database, today: string, now: string): void {
  const holdings = db.prepare(`
    SELECT account_id, security_id, quantity, institution_price, institution_value, cost_basis
    FROM holdings
  `).all() as Array<{
    account_id: string; security_id: string; quantity: number;
    institution_price: number; institution_value: number; cost_basis: number | null;
  }>;

  const upsert = db.prepare(`
    INSERT INTO holdings_history
      (id, account_id, security_id, date, quantity, institution_price, institution_value, cost_basis, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, security_id, date) DO UPDATE SET
      quantity = excluded.quantity,
      institution_price = excluded.institution_price,
      institution_value = excluded.institution_value,
      cost_basis = excluded.cost_basis
  `);

  for (const h of holdings) {
    upsert.run(uuidv4(), h.account_id, h.security_id, today, h.quantity, h.institution_price, h.institution_value, h.cost_basis, now);
  }
}
