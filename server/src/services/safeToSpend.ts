import type Database from 'better-sqlite3';
import { buildRecurringForecast } from './recurringForecast';
import { calculateGoalProgress, type GoalProgressInput } from './goalProgress';

/** The columns `calculateGoalProgress` needs, plus the linked account's balance. */
type GoalEarmarkRow = GoalProgressInput;

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
  /** Net owed on liability accounts, treated as a claim on the liquid pool. Negative when the
   * cards are collectively in credit, which is a credit to the pool rather than a claim. */
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
      // Signed, not absolute. A card can sit in CREDIT (a refund or statement credit larger than
      // the balance), which is stored as a negative amount owed and is money coming back to the
      // pool, not another claim on it. Math.abs() here counted three cards in credit on
      // 2026-07-29 as $852.89 of debt, so the shortfall it reported was $1,705.78 too deep.
      cardBalances += account.current_balance;
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

  // Resolved through `calculateGoalProgress`, not by reading `goals.current_amount` raw.
  //
  // A goal linked to an account does not keep its saved amount in `current_amount`; the linked
  // balance IS the saved amount, and `calculateGoalProgress` is the shared definition that says so.
  // `routes/goals.ts`, `routes/insights.ts`, `aiContext.ts` and `advisorTools.ts` all ask it. This
  // function read the column instead, so one goal had two saved amounts and the disagreement landed
  // on the subject numeral of the home screen: on 2026-09-01 the live ledger carried `Emergency
  // Fund` at `current_amount` 100170 against a linked Wealthfront Cash account at `current_balance`
  // 0, so `/plan` and the advisor reported $0.00 saved and $5,000.00 to go while this function
  // subtracted $1,001.70 as already earmarked. The Balance screen read "$1,036.75 short this month"
  // where the honest figure was $35.05, and `readStanding` could name goal earmarks as the largest
  // claim on money nothing else said was spoken for.
  //
  // Reading the linked balance is also the only self-consistent answer: the earmark has to be the
  // part of the liquid pool this function just counted that is already spoken for, and that is the
  // money sitting in the goal's own account. It is bidirectional. A linked account that has grown
  // past `current_amount` was previously UNDERSTATED, so `free` read too high.
  //
  // Savings goals only, deliberately: a debt-payoff goal's progress is already carried by
  // `cardBalances` above, and counting it here would subtract the same money twice.
  const goals = db.prepare(`
    SELECT g.type, g.target_amount, g.current_amount, g.starting_amount, a.current_balance AS account_balance
    FROM goals g
    LEFT JOIN accounts a ON a.id = g.account_id
    WHERE g.is_archived = 0 AND g.type = 'savings'
  `).all() as GoalEarmarkRow[];
  const allocatedGoals = goals.reduce(
    (sum, goal) => sum + calculateGoalProgress(goal).current_amount,
    0
  );

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
