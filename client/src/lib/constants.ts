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
};

export const ACCOUNT_TYPE_GROUPS: Record<string, string[]> = {
  'Cash & Savings': ['checking', 'savings', 'cash'],
  'Credit Cards': ['credit'],
  Investments: ['brokerage', 'ira_traditional', 'ira_roth'],
  Crypto: ['crypto_wallet'],
  Manual: ['other'],
};

export const FREQUENCY_LABELS: Record<string, string> = {
  weekly: 'Weekly',
  biweekly: 'Biweekly',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  annual: 'Annual',
};

export const INVESTMENT_TX_TYPE_LABELS: Record<string, string> = {
  buy: 'Buy',
  sell: 'Sell',
  dividend: 'Dividend',
  transfer: 'Transfer',
  fee: 'Fee',
  other: 'Other',
};

export const CATEGORY_COLORS = [
  '#4ecba3',
  '#5b8dee',
  '#e07070',
  '#d4a44c',
  '#a78bfa',
  '#f472b6',
  '#34d399',
  '#fb923c',
  '#60a5fa',
  '#f87171',
];
