import type { Budget, SafeToSpend } from '@shared/types';
import { availableBudgetAmount } from '../../lib/budgetMath';
import { readOwedTotal } from '../../lib/accountBalance';

/**
 * What the claim sheet says, with no React in the way.
 *
 * The sheet is the centrepiece of `/plan` and it renders the moment `GET /api/insights/safe-to-spend`
 * lands, which is before the budget and goal lists it also reads. Everything here is written so the
 * sheet can be handed a number it does not yet have a companion for and still say nothing false.
 */

export interface ClaimLine {
  key: string;
  label: string;
  /**
   * Signed movement of the running remainder. Negative takes money out of the pool. Held signed
   * rather than as a magnitude plus a hardcoded minus because `card_balances` can point either
   * way: a card in credit is money coming back, and printing it under a minus sign would state
   * the opposite of what happened.
   */
  delta: number;
  note?: string;
}

/**
 * A count that has not arrived yet is `null`, not `0`.
 *
 * The sheet used to take a plain number off `budgetsQ.data ?? []` and `goalsQ.data ?? []`, so
 * during the ordinary milliseconds between the sheet's query resolving and theirs, an empty array
 * stood in for an unknown one and the sheet printed "No goals yet, so nothing is claimed here."
 * beside the goal claim's own figure. Absent means absent.
 */
export type MaybeCount = number | null;

/**
 * The lines of the subtraction, in the order `computeSafeToSpend` performs it.
 *
 * `free = liquid - card_balances - upcoming_bills - allocated_budgets - allocated_goals`, so every
 * delta after the opening is the negation of the field, and the running total is a partial sum of
 * the server's own numbers rather than a second derivation of them.
 */
export function claimLines(
  sheet: SafeToSpend,
  budgetCount: MaybeCount,
  goalCount: MaybeCount
): ClaimLine[] {
  const cards = readOwedTotal(sheet.card_balances, 'Cards to clear');

  return [
    {
      key: 'liquid',
      label: 'Liquid accounts',
      delta: sheet.liquid,
      note: 'Checking, savings and cash. Not investments, not crypto.',
    },
    {
      key: 'cards',
      label: cards.inCredit ? 'Cards in credit' : cards.label,
      delta: -sheet.card_balances,
      // The old note here said the cards are "autopaid in full each statement period", which is a
      // statement about the owner's behaviour that nothing in this codebase reads, per account or
      // per sync. What IS checked is the arithmetic one line up: `computeSafeToSpend` subtracts
      // the whole signed balance of every non-hidden liability account in a single term.
      note: cards.inCredit
        ? 'The cards owe you. That is money coming back to the pool, not a claim on it.'
        : 'The whole balance is taken out here, not a minimum payment.',
    },
    { key: 'bills', label: `Bills due in the next ${sheet.forecast_days} days`, delta: -sheet.upcoming_bills },
    {
      key: 'budgets',
      label: 'Budgeted, not yet spent',
      delta: -sheet.allocated_budgets,
      note: emptyNote(budgetCount, sheet.allocated_budgets, 'No monthly budgets set, so nothing is claimed here.'),
    },
    {
      key: 'goals',
      label: 'Set aside for goals',
      delta: -sheet.allocated_goals,
      note: emptyNote(goalCount, sheet.allocated_goals, 'No goals yet, so nothing is claimed here.'),
    },
  ];
}

/**
 * "Nothing is claimed here" is only sayable when the count is known to be zero AND the sheet's own
 * figure for that line is zero.
 *
 * Two independent queries feed this, and the guard is deliberately not just "has the count
 * arrived". A count of zero that disagrees with a non-zero figure is a disagreement between two
 * server reads, and the line's own number is the one the sheet is committed to; the sentence goes
 * rather than the figure.
 */
function emptyNote(count: MaybeCount, allocated: number, sentence: string): string | undefined {
  return count === 0 && allocated === 0 ? sentence : undefined;
}

/**
 * How much of a budget's headroom the claim sheet refused to count, in dollars.
 *
 * `computeSafeToSpend` clamps each budget's claim to what was actually budgeted. Now that refunds
 * net a category's spend down, `projected_remaining` can exceed the budget itself, and the excess
 * is headroom the owner never set aside. This re-derives the same clamp so the sheet can say how
 * much it declined to count instead of quietly differing from the budget list below it.
 *
 * The list handed in MUST be the month the sheet was computed for. `GET /api/insights/safe-to-spend`
 * takes its budgets from `new Date()` and nothing in the request can move that, so feeding this the
 * month stepper's list made the paragraph a reading of a month the sheet never looked at: an
 * identical July sheet reported different uncounted headroom depending on which month the list
 * below happened to be showing.
 */
export function uncountedHeadroom(budgets: Budget[]): number {
  return budgets.reduce((sum, budget) => {
    const ceiling = availableBudgetAmount(budget);
    const remaining = Math.max(0, budget.projected_remaining ?? 0);
    return sum + (ceiling > 0 ? Math.max(0, remaining - ceiling) : 0);
  }, 0);
}

/**
 * What the carryover strip may say about the budget amount one recorded month was walked with.
 *
 * It used to say "budget frozen at $X" for every month already closed. `walkRolloverLedger` freezes
 * a closed month only when `budget_rollover_ledger` holds a row for it, and falls back to the live
 * `budgets.amount` when it does not:
 *
 *     const budgetAmount = monthKey < openMonth ? recorded.get(id) ?? budget.amount : budget.amount;
 *
 * `BudgetRolloverLedgerEntry` carries no field separating the two, so a client that says "frozen"
 * is asserting something it cannot see. It now states the amount the month was walked with and
 * claims nothing about where that amount came from. Formatting stays with the caller, which owns
 * its own money formatter.
 */
export function carryoverBudgetPhrase(
  month: string,
  openMonth: string,
  formattedAmount: string
): string {
  return month < openMonth ? `budget ${formattedAmount}` : `budget ${formattedAmount}, still open`;
}
