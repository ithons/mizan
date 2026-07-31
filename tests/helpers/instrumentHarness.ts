import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Instrument } from '../../client/src/views/Instrument';
import { windowRange, type WindowId } from '../../client/src/views/instrumentReadings';
import type {
  Account,
  CashflowReport,
  CategoryTrendReport,
  NetWorthAttribution,
  NetWorthSnapshot,
  RecurringForecast,
  ReportSummary,
  SafeToSpend,
  SpendingReport,
  TopMerchantsReport,
  TransactionReviewSummary,
} from '../../shared/types';

/**
 * The surface itself, rendered.
 *
 * `instrumentSurface.test.ts` checks what the readings say; this checks that the screen says it.
 * The two states of hazard 1 and hazard 4 are the ones that have never rendered before, so they
 * are the ones asserted here: a screen that throws in the short state or that quietly prints a
 * percentage of a signed total would pass every unit test in the file next door.
 *
 * Every fixture is the live shape, from a private copy of `.mizan/mizan.db` at migration
 * `053_drop_budget_groups.sql` (the newest row in its `schema_migrations`). The window is
 * resolved with the same function the component uses, so the seeded cache keys match whatever
 * calendar day this runs on.
 */

/**
 * The measured tail of `net_worth_snapshots`, cents in the table and dollars here, from a private
 * copy of `.mizan/mizan.db` at migration `053_drop_budget_groups.sql`:
 *
 *   SELECT date, total_assets, total_liabilities, net_worth, liquid_assets, investment_assets,
 *          crypto_assets, is_estimated, covered_accounts, total_accounts
 *   FROM net_worth_snapshots WHERE date >= '2026-07-13' ORDER BY date;
 *
 * Coverage steps 11 to 14 on 2026-07-24, which is the whole reason this series is carried rather
 * than a single sheet: it is the live shape of hazard 3.
 */
function sheet(
  date: string,
  assets: number,
  liabilities: number,
  netWorth: number,
  buckets: [number, number, number],
  coverage: number
): NetWorthSnapshot {
  return {
    id: `snap_${date}`,
    date,
    total_assets: assets,
    total_liabilities: liabilities,
    net_worth: netWorth,
    liquid_assets: buckets[0],
    investment_assets: buckets[1],
    crypto_assets: buckets[2],
    is_estimated: false,
    covered_accounts: coverage,
    total_accounts: coverage,
    created_at: `${date}T12:00:00.000Z`,
  } as NetWorthSnapshot;
}

export const RECENT_SHEETS: NetWorthSnapshot[] = [
  sheet('2026-07-13', 10294.39, 4725.27, 5569.12, [8127.93, 1782.12, 384.34], 11),
  sheet('2026-07-14', 6871.53, 3852.93, 3018.6, [4688.89, 1782.12, 400.52], 11),
  sheet('2026-07-15', 6967.64, 3899.68, 3067.96, [4688.89, 1873.51, 405.24], 11),
  sheet('2026-07-16', 7503.38, 3903.5, 3599.88, [5233.07, 1873.51, 396.8], 11),
  sheet('2026-07-23', 8039.32, 4943.38, 3095.94, [5672.25, 1964.41, 402.66], 11),
  sheet('2026-07-24', 8032.4, 5283.01, 2749.39, [5672.25, 1964.41, 395.74], 14),
  sheet('2026-07-27', 8008.38, 5229.91, 2778.47, [5672.25, 1941.88, 394.25], 14),
  sheet('2026-07-28', 8012.58, 5229.91, 2782.67, [5672.25, 1941.88, 398.45], 14),
  sheet('2026-07-29', 7735.16, 5653.71, 2081.45, [5291.49, 2044.62, 399.05], 14),
  sheet('2026-07-30', 8481.56, 4278.7, 4202.86, [6035.67, 2045.04, 400.85], 14),
];

/** The 2026-07-31 sheet, the one whose seven-days-back neighbour does share its coverage. */
export const SHEET_0731 = sheet('2026-07-31', 8471.88, 4278.7, 4193.18, [6035.67, 2045.04, 391.17], 14);

const SNAPSHOT: NetWorthSnapshot = RECENT_SHEETS[RECENT_SHEETS.length - 1];

function card(id: string, name: string, balance: number): Account {
  return {
    id,
    connection_type: 'simplefin',
    institution_name: 'Bank',
    account_name: name,
    type: 'credit',
    current_balance: balance,
    currency: 'USD',
    is_manual: false,
    is_hidden: false,
    is_liability: true,
    sort_order: 0,
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-07-30T12:00:00.000Z',
  };
}

// The five live cards on 2026-07-30:
//   SELECT account_name, current_balance FROM accounts WHERE is_hidden = 0 AND is_liability = 1;
//   Chase Freedom Flex -27612 | Chase Sapphire 511502 | BofA Cash Rewards -582
//   Capital One Savor 888 | Discover -56326
const ACCOUNTS: Account[] = [
  card('a1', 'Chase Freedom Flex', -276.12),
  card('a2', 'Chase Sapphire', 5115.02),
  card('a3', 'BofA Cash Rewards', -5.82),
  card('a4', 'Capital One Savor', 8.88),
  card('a5', 'Discover', -563.26),
];

export const SAFE_TO_SPEND: SafeToSpend = {
  liquid: 6035.67,
  card_balances: 4278.7,
  upcoming_bills: 64.04,
  allocated_budgets: 500,
  allocated_goals: 1001.7,
  free: 191.23,
  forecast_days: 30,
};

// July 2026 spending, from GET /api/reports/spending?startDate=2026-07-01&endDate=2026-07-31.
// Shopping is negative because that month's Amazon and REI credits outweigh its purchases.
export const SPENDING: SpendingReport = {
  total: 1112.99,
  categories: [
    { category_id: 'c_food', category_name: 'Food & Drink', amount: 731.6, percentage: 65.73 },
    { category_id: 'c_travel', category_name: 'Travel', amount: 496.25, percentage: 44.59 },
    { category_id: 'c_transport', category_name: 'Transport', amount: 416.14, percentage: 37.39 },
    { category_id: 'c_subs', category_name: 'Subscriptions', amount: 162.71, percentage: 14.62 },
    { category_id: 'c_pets', category_name: 'Pets', amount: 140.29, percentage: 12.6 },
    { category_id: 'c_ent', category_name: 'Entertainment', amount: 96.22, percentage: 8.65 },
    { category_id: 'c_health', category_name: 'Health', amount: 82.57, percentage: 7.42 },
    { category_id: 'c_home', category_name: 'Home', amount: 15.84, percentage: 1.42 },
    { category_id: 'c_shop', category_name: 'Shopping', amount: -1028.63, percentage: -92.42 },
  ],
};

// Gross activity per merchant: SUM(ABS(amount)). Amazon's $1,795.86 exceeds the whole month's net
// spend of $1,112.99, which is what made the old share render as 161%.
const MERCHANTS: TopMerchantsReport = {
  total: 1112.99,
  merchants: [
    { merchant: 'Amazon', transaction_count: 5, total: 1795.86, last_date: '2026-07-26', category_name: 'Amazon' },
    { merchant: 'REI', transaction_count: 3, total: 775.92, last_date: '2026-07-26', category_name: 'Outdoors & Sporting Goods' },
    { merchant: 'Lyft', transaction_count: 10, total: 254.73, last_date: '2026-07-28', category_name: 'Rideshare' },
  ],
};

const CASHFLOW: CashflowReport = {
  months: [{ month: '2026-07', income: 2715.4, expenses: 1112.99, net: 1602.41 }],
};

const SUMMARY: ReportSummary = {
  comparison: 'prior_period',
  comparison_label: 'Prior period',
  comparison_start_date: '2026-05-31',
  comparison_end_date: '2026-06-30',
  income: { current: 2715.4, previous: 2735.9, delta: -20.5, delta_percent: -0.75 },
  expenses: { current: 1112.99, previous: 6473.19, delta: -5360.2, delta_percent: -82.81 },
  net: { current: 1602.41, previous: -3737.29, delta: 5339.7, delta_percent: 142.88 },
  savings_rate: { current: 59.01, previous: -136.6, delta: 195.61, delta_percent: 143.2 },
  top_spending: [],
  top_income: [],
  spending_movers: [],
  excluded_flows: [],
};

const FORECAST: RecurringForecast = {
  days: 30,
  income: 0,
  bills: 64.04,
  net: -64.04,
  confirmed_income: 0,
  confirmed_bills: 64.04,
  likely_income: 0,
  likely_bills: 0,
  uncertain_income: 0,
  uncertain_bills: 0,
  overdue_count: 0,
  review_count: 0,
  occurrences: [],
} as RecurringForecast;

/**
 * Per-category spend by month, dollars, from `getSpendingTrendsReport(db, {startDate:'2026-05-01',
 * endDate:'2026-07-31'})` run against a private read-only copy of `.mizan/mizan.db` at migration
 * `053_drop_budget_groups.sql` on 2026-07-31.
 *
 * Amazon is the row this fixture is carried for: [57.34, 2160.83, -1748.00]. July is negative
 * because that month's returns outweighed its purchases, which is the same hazard the "Where it
 * went" section handles, seen over time instead of at one instant.
 */
export const TRENDS: CategoryTrendReport = {
  months: ['2026-05', '2026-06', '2026-07'],
  series: [
    { category_id: 'c_amazon', category_name: 'Amazon', color: null, values: [57.34, 2160.83, -1748] },
    { category_id: 'c_pets', category_name: 'Pets', color: null, values: [449.34, 149.02, 140.29] },
    { category_id: 'c_rest', category_name: 'Restaurants', color: null, values: [143.55, 263.88, 506.81] },
    { category_id: 'c_ride', category_name: 'Rideshare', color: null, values: [106.37, 87.91, 302.96] },
    { category_id: 'c_groc', category_name: 'Groceries', color: null, values: [165.2, 354.48, 66.43] },
    { category_id: 'c_house', category_name: 'Household & Everyday', color: null, values: [78.41, 156.8, 77.16] },
    { category_id: 'c_soft', category_name: 'Software & AI Tools', color: null, values: [52.08, 89.22, 158.18] },
    { category_id: 'c_hobby', category_name: 'Hobbies & Collectibles', color: null, values: [67.51, 37.13, 0] },
  ],
};

/**
 * `getNetWorthAttribution(db, {startDate:'2026-07-01', endDate:'2026-07-31'})` on the same copy,
 * cents converted to dollars the way `routes/reports.ts` does.
 *
 * Both cards carry a POSITIVE delta while their stored balances fell, which is the property the
 * caption has to explain: `breakdown` stores a liability as an amount owed, so the service negates
 * a liability's balance change to get its effect on net worth.
 */
export const ATTRIBUTION: NetWorthAttribution = {
  start_date: '2026-07-01',
  end_date: '2026-07-31',
  start_net_worth: 1079.39,
  end_net_worth: 4193.18,
  delta: 3113.79,
  accounts: [
    {
      account_id: 'a_disc',
      account_name: 'Discover',
      institution_name: 'Discover Credit Card',
      type: 'credit',
      is_liability: true,
      start_balance: 1055.63,
      end_balance: -563.26,
      delta: 1618.89,
    },
    {
      account_id: 'a_flex',
      account_name: 'Chase Freedom Flex',
      institution_name: 'Chase Bank',
      type: 'credit',
      is_liability: true,
      start_balance: 1235.95,
      end_balance: -276.12,
      delta: 1512.07,
    },
    {
      account_id: 'a_chk',
      account_name: 'Chase Checking',
      institution_name: 'Chase Bank',
      type: 'checking',
      is_liability: false,
      start_balance: 5977.87,
      end_balance: 4653.97,
      delta: -1323.9,
    },
    {
      account_id: 'a_wf',
      account_name: 'Wealthfront Cash',
      institution_name: 'Wealthfront',
      type: 'savings',
      is_liability: false,
      start_balance: 0,
      end_balance: 1001.7,
      delta: 1001.7,
    },
  ],
};

const REVIEW: TransactionReviewSummary = {
  total_open: 0,
  queues: [],
  rule_suggestions: [],
  recurring_candidates: [],
  duplicate_candidates: [],
  transfer_candidates: [],
  ai_drafts: [],
};

export interface Overrides {
  safeToSpend?: SafeToSpend;
  spending?: SpendingReport;
  snapshot?: NetWorthSnapshot | null;
  /** The windowless series behind the beam and the week reading, oldest first. */
  recent?: NetWorthSnapshot[];
  /** Per-category spend by month. One month, or none, is not a trend and draws no grid. */
  trends?: CategoryTrendReport;
  /** Null is the shape the server sends when the window holds fewer than two measured sheets. */
  attribution?: NetWorthAttribution | null;
}

export function render(windowId: WindowId, overrides: Overrides = {}): string {
  const range = windowRange(windowId, new Date());
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  });

  // Seeded rather than fetched: renderToString is synchronous, so an unseeded key would fire a
  // real request at a server that is not running and reject after the assertions.
  const snapshot = overrides.snapshot === undefined ? SNAPSHOT : overrides.snapshot;
  client.setQueryData(['networth', 'snapshot'], snapshot);
  client.setQueryData(['accounts'], ACCOUNTS);
  client.setQueryData(['insights', 'safe-to-spend'], overrides.safeToSpend ?? SAFE_TO_SPEND);
  client.setQueryData(['recurring', 'forecast', 30], FORECAST);
  client.setQueryData(['goals'], []);
  client.setQueryData(['insights'], []);
  client.setQueryData(['transactions', 'review'], REVIEW);
  client.setQueryData(['ai-actions'], []);
  client.setQueryData(['networth', 'history', 12], overrides.recent ?? RECENT_SHEETS);
  client.setQueryData(['networth', 'history', range], snapshot ? [snapshot] : []);
  client.setQueryData(['reports', 'summary', range, 'prior_period'], SUMMARY);
  client.setQueryData(['reports', 'cashflow', range], CASHFLOW);
  client.setQueryData(['reports', 'spending', range], overrides.spending ?? SPENDING);
  client.setQueryData(['reports', 'merchants', range], MERCHANTS);
  client.setQueryData(['reports', 'trends', range], overrides.trends ?? TRENDS);
  client.setQueryData(
    ['reports', 'networth-attribution', range],
    overrides.attribution === undefined ? ATTRIBUTION : overrides.attribution
  );

  // `useLayoutEffect` warns on every server render and says nothing about this screen; anything
  // else React has to say still reaches the runner, because a swallowed warning is how a real
  // render defect would get through a test that only asserts on strings.
  const realError = console.error;
  console.error = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].includes('useLayoutEffect does nothing on the server')) return;
    realError(...args);
  };
  try {
    return renderToString(
      createElement(
        QueryClientProvider,
        { client },
        createElement(MemoryRouter, { initialEntries: [`/?window=${windowId}`] }, createElement(Instrument))
      )
    );
  } finally {
    console.error = realError;
  }
}

/** The rendered text, with tags and HTML entities out of the way. */
export function text(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;|\s+/g, ' ');
}


