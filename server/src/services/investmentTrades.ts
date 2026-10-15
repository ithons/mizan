const INTERNAL_TRADE = /^(?:YOU BOUGHT|YOU SOLD|PURCHASE INTO CORE ACCOUNT|REDEMPTION FROM CORE ACCOUNT|REINVESTMENT)\b/i;

/**
 * Cash converted to or from a position inside one brokerage account: a fund buy, a sale, the core
 * money-market sweep, a dividend reinvestment. No money enters or leaves the household.
 */
export function isInternalTrade(description: string): boolean {
  return INTERNAL_TRADE.test(description.trim());
}

const MONEY_IN = /^(?:ELECTRONIC FUNDS TRANSFER RECEIVED|DIVIDEND RECEIVED|REDEMPTION FROM CORE ACCOUNT|YOU SOLD)\b/i;
const MONEY_OUT = /^(?:YOU BOUGHT|PURCHASE INTO CORE ACCOUNT|REINVESTMENT)\b/i;

/** 1 when a brokerage descriptor's own words say cash arrived, -1 when they say it left, else 0. */
export function descriptorDirection(description: string): 1 | -1 | 0 {
  const text = description.trim();
  if (MONEY_IN.test(text)) return 1;
  if (MONEY_OUT.test(text)) return -1;
  return 0;
}

/**
 * The amount with the sign its descriptor states. The Fidelity feed has sent "Electronic Funds
 * Transfer Received" negative and fund purchases positive at different times; the words do not
 * change with the feed's convention.
 */
export function directedAmount(amount: number, description: string): number {
  const direction = descriptorDirection(description);
  if (direction === 0 || amount === 0 || Math.sign(amount) === direction) return amount;
  return -amount;
}
