const INTERNAL_TRADE = /^(?:YOU BOUGHT|YOU SOLD|PURCHASE INTO CORE ACCOUNT|REDEMPTION FROM CORE ACCOUNT|REINVESTMENT)\b/i;

/**
 * Cash converted to or from a position inside one brokerage account: a fund buy, a sale, the core
 * money-market sweep, a dividend reinvestment. No money enters or leaves the household.
 */
export function isInternalTrade(description: string): boolean {
  return INTERNAL_TRADE.test(description.trim());
}
