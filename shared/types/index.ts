export type ConnectionType = 'plaid' | 'coinbase' | 'manual';

export type AccountType =
  | 'checking'
  | 'savings'
  | 'credit'
  | 'brokerage'
  | 'ira_traditional'
  | 'ira_roth'
  | 'crypto_wallet'
  | 'cash'
  | 'other';

export interface Account {
  id: string;
  plaid_account_id?: string | null;
  coinbase_account_id?: string | null;
  connection_id?: string | null;
  connection_type: ConnectionType;
  institution_name: string;
  account_name: string;
  type: AccountType;
  subtype?: string | null;
  mask?: string | null;
  current_balance: number;
  available_balance?: number | null;
  currency: string;
  native_currency?: string | null;
  native_balance?: number | null;
  is_manual: boolean;
  is_hidden: boolean;
  is_liability: boolean;
  color?: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface Transaction {
  id: string;
  plaid_transaction_id?: string | null;
  coinbase_transaction_id?: string | null;
  account_id: string;
  date: string;
  amount: number;
  merchant_name?: string | null;
  original_name: string;
  category_id?: string | null;
  pending: boolean;
  notes?: string | null;
  is_manual: boolean;
  recurring_id?: string | null;
  created_at: string;
  updated_at: string;
  // joined
  category_name?: string | null;
  category_color?: string | null;
  category_icon?: string | null;
  account_name?: string | null;
  institution_name?: string | null;
}

export interface InvestmentTransaction {
  id: string;
  plaid_investment_transaction_id?: string | null;
  account_id: string;
  date: string;
  type: 'buy' | 'sell' | 'dividend' | 'transfer' | 'fee' | 'other';
  security_id?: string | null;
  quantity?: number | null;
  price?: number | null;
  amount: number;
  fees?: number | null;
  name: string;
  created_at: string;
  // joined
  ticker?: string | null;
  security_name?: string | null;
}

export interface Security {
  id: string;
  plaid_security_id?: string | null;
  ticker?: string | null;
  name: string;
  type: 'equity' | 'etf' | 'mutual_fund' | 'crypto' | 'cash' | 'other';
  currency: string;
}

export interface Holding {
  id: string;
  account_id: string;
  security_id: string;
  quantity: number;
  institution_price: number;
  institution_value: number;
  cost_basis?: number | null;
  currency: string;
  updated_at: string;
  // joined
  ticker?: string | null;
  security_name?: string | null;
  security_type?: string | null;
}

export interface Category {
  id: string;
  name: string;
  icon?: string | null;
  color?: string | null;
  parent_id?: string | null;
  is_income: boolean;
  is_system: boolean;
  is_investment: boolean;
  sort_order: number;
  children?: Category[];
}

export interface Budget {
  id: string;
  category_id: string;
  amount: number;
  period: string;
  rollover: boolean;
  rollover_balance: number;
  created_at: string;
  updated_at: string;
  // joined
  category_name?: string | null;
  category_color?: string | null;
  category_icon?: string | null;
  spent?: number;
}

export interface RecurringPattern {
  id: string;
  merchant_name: string;
  category_id?: string | null;
  average_amount: number;
  frequency: 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'annual';
  last_seen: string;
  next_expected: string;
  is_active: boolean;
  is_confirmed: boolean;
  transaction_count: number;
  created_at: string;
  updated_at: string;
  // joined
  category_name?: string | null;
  category_color?: string | null;
}

export interface MerchantRule {
  id: string;
  pattern: string;
  category_id: string;
  created_at: string;
}

export interface PlaidItem {
  id: string;
  item_id: string;
  institution_id?: string | null;
  institution_name: string;
  cursor?: string | null;
  last_synced_at?: string | null;
  products?: string | null;
  status: string;
  created_at: string;
}

export interface CoinbaseConnection {
  id: string;
  coinbase_user_id: string;
  display_name?: string | null;
  last_synced_at?: string | null;
  status: string;
  created_at: string;
}

export interface NetWorthSnapshot {
  id: string;
  date: string;
  total_assets: number;
  total_liabilities: number;
  net_worth: number;
  breakdown: string;
  is_estimated: boolean;
  created_at: string;
}

export interface SyncEvent {
  type: 'sync_start' | 'sync_progress' | 'sync_complete' | 'sync_error';
  message: string;
  progress?: number;
}

export interface ApiResponse<T> {
  data: T;
}

export interface ApiError {
  error: string;
  details?: unknown[];
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}

export interface TransactionFilters {
  page?: number;
  limit?: number;
  accountId?: string[];
  categoryId?: string[];
  startDate?: string;
  endDate?: string;
  search?: string;
  minAmount?: number;
  maxAmount?: number;
  pending?: boolean;
  recurring?: boolean;
  type?: string;
}

export interface CashflowReport {
  months: Array<{
    month: string;
    income: number;
    expenses: number;
    net: number;
  }>;
}

export interface SpendingReport {
  categories: Array<{
    category_id: string;
    category_name: string;
    color?: string | null;
    amount: number;
    percentage: number;
    children?: SpendingReport['categories'];
  }>;
  total: number;
}

export interface NetWorthHistory {
  snapshots: NetWorthSnapshot[];
}

export interface CredentialStatus {
  plaid: boolean;
  plaidEnvironment: 'sandbox' | 'production' | null;
  coinbase: boolean;
}
