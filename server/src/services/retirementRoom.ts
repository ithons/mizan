import type Database from 'better-sqlite3';
import { toCents, toDollars } from './money';

const EARNED_CATEGORIES = ['cat_income_paycheck', 'cat_income_freelance'];

/**
 * IRA room for a tax year: the owner's limit, capped at earned income so far, less what was
 * deposited into IRA accounts in that calendar year. A deposit made by April 15 can belong to the
 * prior year; those are counted here and listed, so room is never overstated.
 */
export function retirementRoom(db: Database.Database, annualLimitDollars: number, taxYear: number) {
  if (!(annualLimitDollars > 0)) return { error: 'annual_limit must be a positive dollar amount the owner has given' };
  const from = `${taxYear}-01-01`;
  const to = `${taxYear}-12-31`;
  const earned = (db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS cents FROM transactions
    WHERE pending = 0 AND amount > 0 AND date BETWEEN ? AND ? AND category_id IN (${EARNED_CATEGORIES.map(() => '?').join(',')})
  `).get(from, to, ...EARNED_CATEGORIES) as { cents: number }).cents;
  const deposits = db.prepare(`
    SELECT t.date, t.amount, a.account_name FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE a.type IN ('ira_roth', 'ira_traditional') AND t.pending = 0 AND t.amount > 0
      AND COALESCE(c.is_income, 0) = 0 AND t.date BETWEEN ? AND ?
    ORDER BY t.date
  `).all(from, to) as Array<{ date: string; amount: number; account_name: string }>;
  const contributed = deposits.reduce((sum, row) => sum + row.amount, 0);
  const limit = toCents(annualLimitDollars);
  const cap = Math.min(limit, earned);
  return {
    tax_year: taxYear,
    annual_limit: toDollars(limit),
    earned_income_so_far: toDollars(earned),
    contributed: toDollars(contributed),
    room_left: toDollars(Math.max(0, cap - contributed)),
    deposits: deposits.map((row) => ({ date: row.date, amount: toDollars(row.amount), account: row.account_name })),
    possibly_for_prior_year: deposits.filter((row) => row.date <= `${taxYear}-04-15`).map((row) => row.date),
    contribution_deadline: `${taxYear + 1}-04-15`,
    method: 'The limit is the one the owner gave. Room is that limit, capped at paycheck and freelance income posted this calendar year, less deposits into IRA accounts dated this calendar year that are not dividends or interest. A deposit by April 15 may have been for the prior year; it is counted here and listed. The usual deadline is the April 15 tax filing date; eligibility and residency rules are not checked.',
  };
}
