import type Database from 'better-sqlite3';
import { buildRecurringForecast } from './recurringForecast';

/**
 * "Free to spend": what is left after every claim already made on the liquid pool.
 *
 * TWO DEFECTS THIS REPLACES.
 *
 * 1. It ignored credit cards entirely. The old client-side version computed
 *    `liquid - bills - budgets - goals` and never looked at liabilities, so on 2026-07-29 it
 *    rendered "Free to spend $4,226" directly beneath "Owed $5,653.71" against $5,291.49 of liquid
 *    assets. Paying the cards would have left the deposit pool $362.22 negative. The owner's own
 *    advisor profile states they autopay every card in full each statement period, which makes the
 *    card balance the most certain claim on that pool, not an optional one.
 *
 * 2. It clamped at zero. `Math.max(0, ...)` meant "you are $400 short this month" and "you have
 *    exactly nothing spare" rendered identically as $0, hiding the single most important thing this
 *    number can ever say. The shortfall is now returned signed, and it is the caller's job to show
 *    it rather than this function's job to hide it.
 *
 * Lives on the server because the advisor and the Today screen must not be able to disagree about
 * it. The previous client-only implementation carried a docstring claiming it mirrored a
 * server-side metric of the same name; no such metric existed. It was describing a feature deleted
 * in a1412db, and it would have sent anyone trying to reconcile the two on a long walk.
 *
 * Every field is INTEGER CENTS. Dollarization happens at the route boundary.
 */
export interface SafeToSpendBreakdown {
  /** Checking, savings and cash. Not investments, not crypto. */
  liquid: number;
  /** Total owed on liability accounts, treated as a claim on the liquid pool. */
  cardBalances: number;
  /** Scheduled outflows in the forecast window. */
  upcomingBills: number;
  /** Budgeted-but-unspent allocations still expected to be drawn. */
  allocatedBudgets: number;
  /** Money already earmarked against savings goals. */
  allocatedGoals: number;
  /** Signed. Negative means the claims exceed the pool. */
  free: number;
  forecastDays: number;
}

export interface SafeToSpendInputs {
  /** Budget rows for the current month, in cents, already projected. */
  budgets?: Array<{
    projected_remaining?: number | null;
    amount?: number | null;
    rollover_balance?: number | null;
  }>;
  forecastDays?: number;
}

export function computeSafeToSpend(
  db: Database.Database,
  inputs: SafeToSpendInputs = {}
): SafeToSpendBreakdown {
  const forecastDays = inputs.forecastDays ?? 30;

  const accounts = db.prepare(`
    SELECT type, current_balance, is_liability
    FROM accounts
    WHERE is_hidden = 0 AND type != 'closed'
  `).all() as Array<{ type: string; current_balance: number; is_liability: number }>;

  const liquidTypes = new Set(['checking', 'savings', 'cash']);
  let liquid = 0;
  let cardBalances = 0;
  for (const account of accounts) {
    if (account.is_liability) {
      // Liability balances are stored as a positive amount owed.
      cardBalances += Math.abs(account.current_balance);
    } else if (liquidTypes.has(account.type)) {
      liquid += account.current_balance;
    }
  }

  const forecast = buildRecurringForecast(db, forecastDays);
  const upcomingBills = Math.abs(forecast.bills);

  // Clamped to what was actually budgeted. Now that refunds net a category's spend down,
  // `projected_remaining` can legitimately EXCEED the budget: July's Shopping budget is $500 while
  // its spend is -$1,203.63, giving $1,703.63 "remaining". That is a true statement about headroom
  // and a false one about intent, and this metric is about intent. You never earmarked $1,703.63
  // for Shopping.
  const allocatedBudgets = (inputs.budgets ?? []).reduce((sum, budget) => {
    const ceiling = (budget.amount ?? 0) + (budget.rollover_balance ?? 0);
    const remaining = Math.max(0, budget.projected_remaining ?? 0);
    return sum + (ceiling > 0 ? Math.min(remaining, ceiling) : remaining);
  }, 0);

  const goals = db.prepare(`
    SELECT current_amount FROM goals WHERE is_archived = 0 AND type = 'savings'
  `).all() as Array<{ current_amount: number }>;
  const allocatedGoals = goals.reduce((sum, goal) => sum + goal.current_amount, 0);

  return {
    liquid,
    cardBalances,
    upcomingBills,
    allocatedBudgets,
    allocatedGoals,
    free: liquid - cardBalances - upcomingBills - allocatedBudgets - allocatedGoals,
    forecastDays,
  };
}
