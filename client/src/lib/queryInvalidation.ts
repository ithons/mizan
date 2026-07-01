import type { QueryClient } from '@tanstack/react-query';

const FINANCIAL_QUERY_KEYS = [
  'accounts',
  'transactions',
  'networth',
  'budgets',
  'recurring',
  'sync',
  'goals',
  'rules',
  'holdings',
  'cashflow',
  'reports',
  'spending',
  'income',
  'trends',
  'insights',
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
