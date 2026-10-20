
export const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  checking: 'Checking',
  savings: 'Savings',
  credit: 'Credit Card',
  brokerage: 'Brokerage',
  ira_traditional: 'Traditional IRA',
  ira_roth: 'Roth IRA',
  crypto_wallet: 'Crypto Wallet',
  cash: 'Cash',
  other: 'Other',
  closed: 'Closed',
};

// `export { CHART_COLORS as CATEGORY_COLORS }` used to live here and is deliberately gone. It had
// no consumer, and the alias promised the opposite of what the value is: CHART_COLORS is eight
// `var(--mz-series-N)` strings, which resolve only where a browser substitutes custom properties,
// while `categories.color` persists a real hex. Import CHART_COLORS from './chartColors', where
// that constraint is documented at the declaration.
