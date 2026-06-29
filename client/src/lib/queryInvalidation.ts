import type { QueryClient } from '@tanstack/react-query';

const FINANCIAL_QUERY_KEYS = [
  'accounts',
  'plaid-items',
  'transactions',
  'networth',
  'budgets',
  'recurring',
  'holdings',
  'cashflow',
  'reports',
  'spending',
  'income',
  'trends',
  'inv-report',
  'reports-investments',
  'investment-transactions',
  'inv-transactions',
  'ai-context',
];

export function invalidateFinancialData(queryClient: QueryClient): void {
  for (const key of FINANCIAL_QUERY_KEYS) {
    void queryClient.invalidateQueries({ queryKey: [key] });
  }
}
