import type { Account } from '@shared/types';

/** The three fields a balance reading needs. A full `Account` satisfies it. */
export type AccountBalanceView = Pick<Account, 'type' | 'is_liability' | 'current_balance'>;

/**
 * What an account contributes to net worth.
 *
 * A liability stores the amount OWED, so its contribution is the negation of it. This used to be
 * `-Math.abs(balance)`, which reads a card in CREDIT (a refund or statement credit larger than the
 * balance, stored as a negative amount owed) as debt of exactly that size. On 2026-07-29 three of
 * the owner's five cards were in credit and the Accounts screen printed a net worth $1,705.78 below
 * the one the server computed from the same rows.
 */
export function signedAccountBalance(account: AccountBalanceView): number {
  return account.is_liability ? -account.current_balance : account.current_balance;
}

/** A liability the owner is owed on rather than owes. */
export function isInCredit(account: AccountBalanceView): boolean {
  return account.is_liability && account.current_balance < 0;
}

/**
 * How a credit position is said out loud, matching the words the advisor context already uses
 * ("credit balance (the card owes you)"). Rendered beside the figure because the figure alone
 * cannot carry it: $563 held and $563 owed back to you are different states of the world, and a
 * sign is the one thing the eye skips.
 */
export function creditNote(account: AccountBalanceView): string {
  return `In credit. This ${account.type === 'credit' ? 'card' : 'account'} owes you.`;
}

export interface OwedTotalReading {
  label: string;
  /** Never negative: the sign has been spent on the label. */
  amount: number;
  inCredit: boolean;
}

/**
 * How a liabilities TOTAL reads.
 *
 * The per-account helpers take an account; a snapshot total arrives already summed and signed, so a
 * net credit reaches the screen as a negative amount owed. "-$852.89" under "Owed" states the
 * opposite of what happened, which is why the label travels with the figure here instead of being
 * hardcoded beside it.
 */
export function readOwedTotal(totalOwed: number, owedLabel = 'Owed'): OwedTotalReading {
  return totalOwed < 0
    ? { label: 'In credit', amount: -totalOwed, inCredit: true }
    : { label: owedLabel, amount: totalOwed, inCredit: false };
}

/**
 * The words `services/aiContext.ts` already uses for a card in credit, so the client-built prompts
 * and the server-built context cannot describe the same card differently. Formatting stays with the
 * caller, which owns its own money formatter.
 */
export function creditBalancePhrase(formattedAmount: string): string {
  return `${formattedAmount} credit balance (the card owes you)`;
}
