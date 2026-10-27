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

const BACKDATED_RECEIPT = /^ELECTRONIC FUNDS TRANSFER RECEIVED AS OF (\d{4}-\d{2}-\d{2})\b/i;
const PLAIN_RECEIPT = /^ELECTRONIC FUNDS TRANSFER RECEIVED\b(?! AS OF)/i;
/** How far before its "as of" date the deposit a reversal undoes may have posted. */
const REVERSAL_LOOKBACK_DAYS = 3;

export interface PostedReceipt { date: string; amount: number; description: string }

/**
 * The signed amount for a brokerage row, given the account's other receipts. Fidelity posts a
 * bounced deposit as "Electronic Funds Transfer Received as of <date>", worded like an arrival,
 * for the same amount as a plain receipt a day or so before that date. That row is money leaving.
 * A back-dated receipt with no such deposit before it is a late-posted arrival and keeps the
 * descriptor's direction.
 */
export function directedBrokerageAmount(amount: number, description: string, receipts: readonly PostedReceipt[]): number {
  const asOf = BACKDATED_RECEIPT.exec(description.trim())?.[1];
  if (!asOf || amount === 0) return directedAmount(amount, description);
  const earliest = new Date(Date.parse(`${asOf}T00:00:00Z`) - REVERSAL_LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
  const undone = receipts.some((r) => PLAIN_RECEIPT.test(r.description.trim())
    && Math.abs(r.amount) === Math.abs(amount) && r.date >= earliest && r.date <= asOf);
  return undone ? -Math.abs(amount) : directedAmount(amount, description);
}
