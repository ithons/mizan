import test from 'node:test';
import assert from 'node:assert/strict';
import type { ComponentType } from 'react';
import type { QueryKey } from '@tanstack/react-query';
import { endOfMonth, format, startOfMonth, subDays } from 'date-fns';
import { Ledger } from '../client/src/views/Ledger';
import { Accounts } from '../client/src/views/accounts/Accounts';
import { Investments, investmentNotes } from '../client/src/views/Investments';
import { Plan } from '../client/src/views/Plan';
import Advisor from '../client/src/views/Advisor';
import { Settings } from '../client/src/views/settings/Settings';
import { getCostBasisStats } from '../client/src/lib/investmentAnalytics';
import { signedAccountBalance } from '../client/src/lib/accountBalance';
import { healthTone } from '../client/src/components/balance/ProgressBar';
import { DRAFT_KIND_AUTONOMY } from '../server/src/services/draftAutonomy';
import type { aiApi } from '../client/src/lib/api';
import type {
  Account,
  AdvisorAutonomyResponse,
  AdvisorContextResponse,
  AdvisorDraftAction,
  AdvisorSettings,
  ProjectedBudget,
  Category,
  CounterpartiesResponse,
  Counterparty,
  CredentialStatus,
  ExpectedLumpsResponse,
  StarterBudgetReading,
  RunwayReading,
  Goal,
  Holding,
  NetWorthTimeline,
  ReconciliationReading,
  RecurringForecast,
  RecurringForecastOccurrence,
  RecurringPattern,
  SafeToSpend,
  SimplefinRelinkPendingResponse,
  SyncHealth,
  Transaction,
  TransactionReviewSummary,
} from '../shared/types';
import { REVIEW, SYNC_HEALTH_OK } from './helpers/instrumentHarness';
import { familiesIn, raisedIn, renderScreen } from './helpers/screenHarness';

/**
 * `healthyColour.test.ts` held Instrument to rule 3 in colour. This holds the other six screens to
 * it: on a healthy fixture (calibrated, nothing waiting, no faults, no negative figures, nothing
 * overdue) no clay, gold, estimate or review ink is on screen. Each fixture is asserted healthy by
 * the screen's own predicate where one is exported, and each render is asserted to have reached
 * the seeded data and to have left no query pending.
 *
 * Five screens are then made unhealthy in one named way to prove the check fires there. Advisor is
 * the exception: no seedable unhealthy state reaches alarm ink on that page (an open proposal
 * renders in ink and sage), so its second test proves only that the matcher sees the page's one
 * alarm token, the gold on an action applied unattended.
 *
 * Settings is rendered with every panel collapsed. Panels open through effects and clicks, and
 * `renderToString` runs neither, so the expanded sections (SimpleFIN, Coinbase, data, the advisor
 * group) and every modal on every screen are outside this check.
 */

const now = new Date();
const day = (daysBack: number) => format(subDays(now, daysBack), 'yyyy-MM-dd');
const stamp = `${day(0)}T12:00:00.000Z`;

type Seed = ReadonlyArray<readonly [QueryKey, unknown]>;

function rendered(screen: ComponentType, path: string, seed: Seed, mustShow: string): string {
  const { html, unseeded } = renderScreen(screen, path, seed);
  assert.deepEqual(unseeded, [], `${path} left a query pending, so part of it rendered as a skeleton`);
  assert.ok(html.includes(mustShow), `${path} never reached the seeded data ("${mustShow}")`);
  return html;
}

function assertSilent(html: string, path: string) {
  const raised = raisedIn(html);
  assert.deepEqual(raised, [], `a healthy ${path} raised ${raised.join(', ')}`);
}

function account(overrides: Partial<Account> & Pick<Account, 'id' | 'account_name' | 'type' | 'current_balance'>): Account {
  return {
    connection_type: 'simplefin',
    connection_id: 'conn_bank',
    institution_name: 'Chase Bank',
    currency: 'USD',
    is_manual: false,
    is_hidden: false,
    is_liability: false,
    sort_order: 0,
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: stamp,
    ...overrides,
  };
}

const CHECKING = account({ id: 'a_chk', account_name: 'Chase Checking', type: 'checking', current_balance: 4653.97 });
const SAVINGS = account({ id: 'a_wf', account_name: 'Wealthfront Cash', type: 'savings', current_balance: 1001.7 });
const BROKERAGE = account({ id: 'a_brk', account_name: 'Fidelity Brokerage', type: 'brokerage', current_balance: 2045.04 });
// Paid to zero: a card carrying a balance owed is a measured negative figure, and clay there is correct.
const CARD = account({ id: 'a_card', account_name: 'Chase Sapphire', type: 'credit', current_balance: 0, is_liability: true });
const ACCOUNTS = [CHECKING, SAVINGS, BROKERAGE, CARD];

const SYNC_HEALTH: SyncHealth = {
  ...SYNC_HEALTH_OK,
  last_synced_at: stamp,
  connections: [
    {
      id: 'conn_bank',
      provider: 'simplefin',
      institution_name: 'Chase Bank',
      status: 'active',
      last_synced_at: stamp,
      last_success_at: stamp,
      age_days: 0,
      account_count: 4,
      is_stale: false,
      needs_attention: false,
      freshness: 'fresh',
      status_label: 'Fresh',
      status_detail: 'Synced today.',
      recommended_action: 'none',
    },
  ],
};

const CATEGORIES: Category[] = [
  { id: 'cat_food', name: 'Food & Drink', is_income: false, is_system: true, is_investment: false, sort_order: 0 },
  { id: 'cat_shop', name: 'Shopping', is_income: false, is_system: true, is_investment: false, sort_order: 1 },
];

test('a fill clipped to no area is discounted, and one its clip overlaps still counts', () => {
  const chart = (lowestY: number) =>
    '<svg><defs><clipPath id="c-below"><rect x="0" y="132" width="1000" height="8"></rect></clipPath></defs>' +
    `<polygon points="10,10 990,8 990,${lowestY} 10,${lowestY}" fill="var(--mz-clay)" clip-path="url(#c-below)"></polygon></svg>`;
  assert.deepEqual(familiesIn(chart(132)), [], 'a polygon sharing only an edge with its clip paints nothing');
  assert.deepEqual(familiesIn(chart(138)), ['clay'], 'a polygon reaching into its clip paints');
});

test('the shared fixture is healthy by the code’s own definitions', () => {
  assert.equal(REVIEW.total_open, 0);
  assert.deepEqual(REVIEW.ai_drafts, []);
  assert.equal(SYNC_HEALTH.status, 'healthy');
  assert.ok(SYNC_HEALTH.connections.every((c) => c.freshness === 'fresh' && !c.needs_attention));
  assert.ok(ACCOUNTS.every((a) => signedAccountBalance(a) >= 0), 'an account reads as owed');
});

// ─── Ledger ───────────────────────────────────────────────────────────────────

const LEDGER_FILTERS = {
  startDate: format(startOfMonth(now), 'yyyy-MM-dd'),
  endDate: format(endOfMonth(now), 'yyyy-MM-dd'),
  limit: 100,
};

function txn(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 't_lunch',
    account_id: CHECKING.id,
    date: day(0),
    amount: -18.4,
    original_name: 'SWEETGREEN 123',
    merchant_name: 'Sweetgreen',
    category_id: 'cat_food',
    category_name: 'Food & Drink',
    pending: false,
    is_manual: false,
    source_type: 'simplefin',
    duplicate_status: 'none',
    transfer_status: 'none',
    review_status: 'reviewed',
    created_at: stamp,
    updated_at: stamp,
    ...overrides,
  };
}

const RENT: RecurringPattern = {
  id: 'r_rent',
  merchant_name: 'Avalon Rent',
  category_id: 'cat_shop',
  average_amount: 1800,
  frequency: 'monthly',
  last_seen: day(20),
  next_expected: day(-10),
  is_active: true,
  is_confirmed: true,
  transaction_count: 6,
  created_at: '2026-06-01T00:00:00.000Z',
  updated_at: stamp,
};

function occurrence(expected: string, status: RecurringForecastOccurrence['status']): RecurringForecastOccurrence {
  return {
    id: `occ_${expected}`,
    pattern_id: RENT.id,
    merchant_name: RENT.merchant_name,
    frequency: 'monthly',
    expected_date: expected,
    amount: -1800,
    is_income: false,
    is_confirmed: true,
    confidence: 0.95,
    confidence_label: 'confirmed',
    status,
    days_until: status === 'overdue' ? -3 : 10,
    needs_review: false,
  };
}

function forecast(occurrences: RecurringForecastOccurrence[]): RecurringForecast {
  const overdue = occurrences.filter((o) => o.status === 'overdue').length;
  const income = occurrences.filter((o) => o.is_income).reduce((s, o) => s + o.amount, 0);
  const bills = occurrences.filter((o) => !o.is_income).reduce((s, o) => s - o.amount, 0);
  return {
    days: 30,
    income,
    bills,
    net: income - bills,
    transfers: 0,
    confirmed_income: income,
    confirmed_bills: bills,
    likely_income: 0,
    likely_bills: 0,
    uncertain_income: 0,
    uncertain_bills: 0,
    overdue_count: overdue,
    review_count: 0,
    occurrences,
  } as RecurringForecast;
}

const PAYCHECK: RecurringForecastOccurrence = {
  ...occurrence(day(-5), 'upcoming'),
  id: 'occ_pay',
  pattern_id: 'r_pay',
  merchant_name: 'Acme Payroll',
  amount: 2715.4,
  is_income: true,
};

const UPCOMING = forecast([occurrence(day(-10), 'upcoming'), PAYCHECK]);

function ledgerSeed(rows: Transaction[], review: TransactionReviewSummary, schedule: RecurringForecast): Seed {
  return [
    [['transactions', 'review'], review],
    [['recurring', 'forecast', 30], schedule],
    [['recurring'], [RENT]],
    [['accounts'], ACCOUNTS],
    [['categories'], CATEGORIES],
    [['transactions', LEDGER_FILTERS], { pages: [{ data: rows, total: rows.length, page: 1, limit: 100 }], pageParams: [1] }],
  ];
}

const HEALTHY_LEDGER = ledgerSeed([txn()], REVIEW, UPCOMING);

test('a healthy ledger raises nothing', () => {
  assert.ok(UPCOMING.occurrences.every((o) => o.status === 'upcoming' && !o.needs_review));
  assertSilent(rendered(Ledger, '/ledger', HEALTHY_LEDGER, 'Sweetgreen'), '/ledger');
});

test('and a possible duplicate waiting in the queue raises review ink there', () => {
  const rows = [
    txn({ id: 't_a', duplicate_status: 'candidate', review_status: 'open' }),
    txn({ id: 't_b', duplicate_status: 'candidate', review_status: 'open' }),
  ];
  // The shape `getTransactionReviewSummary` publishes for this queue: counted per group.
  const open: TransactionReviewSummary = {
    ...REVIEW,
    total_open: 1,
    queues: [{ id: 'duplicate_candidates', label: 'Possible duplicates', count: 1, action_label: 'Review', severity: 'warning' }],
    duplicate_candidates: [{
      group_id: 'g_1',
      count: 2,
      amount: -18.4,
      date: day(0),
      merchant_name: 'Sweetgreen',
      account_name: CHECKING.account_name,
      transaction_ids: rows.map((r) => r.id),
    }],
  };
  const html = rendered(Ledger, '/ledger', ledgerSeed(rows, open, UPCOMING), 'possible duplicate');
  assert.ok(raisedIn(html).includes('review'), 'two rows that may be one and the ledger says nothing');
});

test('the scheduled tab draws its forecast in estimate ink and nothing louder', () => {
  // Estimate is the tab's own voice, not an alarm: a forecast is derived, never measured.
  const html = rendered(Ledger, '/ledger?view=scheduled', HEALTHY_LEDGER, 'Avalon Rent');
  assert.deepEqual(raisedIn(html), ['estimate']);
});


test('and a bill expected before today and not yet seen raises review ink there', () => {
  const overdue = ledgerSeed([txn()], REVIEW, forecast([occurrence(day(3), 'overdue'), PAYCHECK]));
  const html = rendered(Ledger, '/ledger?view=scheduled', overdue, 'Expected before today');
  assert.ok(raisedIn(html).includes('review'), 'an overdue bill reads exactly like an upcoming one');
});

test('a pending transaction is marked, not raised: nothing about it is for the owner to do', () => {
  assertSilent(rendered(Ledger, '/ledger', ledgerSeed([txn({ pending: true })], REVIEW, UPCOMING), 'pending'), '/ledger');
});

function counterparty(overrides: Partial<Counterparty> & Pick<Counterparty, 'key' | 'name'>): Counterparty {
  return {
    kind: 'person', channel: 'zelle', sent: 0, received: 0, net: 0, rows: 2,
    first_date: day(40), last_date: day(20), days_since_last: 20, state: 'settled', older_than_window: false,
    ...overrides,
  };
}

function peopleSeed(people: Counterparty[]): Seed {
  const reading: CounterpartiesResponse = {
    as_of: day(0), window_days: 60, settle_tolerance: 1,
    people,
    channels: [
      counterparty({ key: 'wallet:venmo', name: 'Venmo', kind: 'wallet', channel: 'venmo', sent: 300, received: 120, net: -180, state: null }),
      counterparty({ key: 'cash', name: 'Cash', kind: 'cash', channel: 'cash', sent: 200, net: -200, state: null, days_since_last: 200 }),
    ],
    unclassified: { rows: 0, sent: 0, received: 0 },
  };
  return [...HEALTHY_LEDGER, [['transactions', 'counterparties'], reading]];
}

const ORDINARY_PEOPLE = [
  counterparty({ key: 'person:sam ortiz', name: 'Sam Ortiz', sent: 46, received: 46 }),
  counterparty({ key: 'person:ana', name: 'Ana', received: 30, net: 30, state: 'received_more', days_since_last: 300, older_than_window: true }),
  counterparty({ key: 'person:jordan lee', name: 'Jordan Lee', sent: 46, net: -46, state: 'sent_more', days_since_last: 12 }),
];

test('people and cash on an ordinary ledger raises nothing', () => {
  assertSilent(rendered(Ledger, '/ledger?view=people', peopleSeed(ORDINARY_PEOPLE), 'Jordan Lee'), '/ledger?view=people');
});

test('and money sent with nothing back for months is stated, not flagged: a gift and a loan look alike here', () => {
  const stale = [counterparty({ key: 'person:jordan lee', name: 'Jordan Lee', sent: 46, net: -46, state: 'sent_more', days_since_last: 61, older_than_window: true })];
  assertSilent(rendered(Ledger, '/ledger?view=people', peopleSeed(stale), 'Sent $46.00 more than received'), '/ledger?view=people');
});

// ─── Accounts ─────────────────────────────────────────────────────────────────

const CLEAN_RECONCILIATION: ReconciliationReading = {
  accounts: [],
  unreconciled: [],
  unreconciled_residual: 0,
  residual_all_accounts: 0,
  measured_snapshot_count: 12,
  flow_conservation: [],
};

const TIMELINE: NetWorthTimeline = {
  from: day(28),
  to: day(0),
  step: 'day',
  accounts: ACCOUNTS.map((a) => ({
    id: a.id,
    name: a.account_name,
    type: a.type,
    is_liability: a.is_liability,
    market_driven: a.type === 'brokerage',
    first_date: day(28),
    opening_balance: a.type === 'brokerage' ? null : a.current_balance,
  })),
  points: [28, 21, 14, 7, 0].map((back, i) => {
    const lift = (i - 4) * 50;
    return {
      date: day(back),
      net_worth: 7700.71 + lift,
      assets: 7700.71 + lift,
      liabilities: 0,
      liquid: 5655.67 + lift,
      invested: 2045.04,
      crypto: 0,
      estimated: false,
      estimated_accounts: [],
      coverage: ACCOUNTS.length,
      by_account: Object.fromEntries(ACCOUNTS.map((a) => [a.id, a.id === CHECKING.id ? a.current_balance + lift : a.current_balance])),
    };
  }),
  method: 'Replayed from each account’s own rows.',
};

function accountsSeed(health: SyncHealth): Seed {
  return [
    [['accounts'], ACCOUNTS],
    [['sync', 'health'], health],
    [['insights', 'reconciliation'], CLEAN_RECONCILIATION],
    [['networth', 'timeline', undefined, undefined, 'day', ACCOUNTS.map((a) => a.id).join(',')], TIMELINE],
    [['networth', 'current'], { net_worth: TIMELINE.points.at(-1)!.net_worth, assets: TIMELINE.points.at(-1)!.assets, liabilities: TIMELINE.points.at(-1)!.liabilities, as_of: TIMELINE.points.at(-1)!.date }],
  ];
}

test('a healthy accounts screen raises nothing', () => {
  assertSilent(rendered(Accounts, '/accounts', accountsSeed(SYNC_HEALTH), 'Chase Checking'), '/accounts');
});

test('and a connection that needs reconnecting raises clay there', () => {
  const broken: SyncHealth = {
    ...SYNC_HEALTH,
    connections: [{ ...SYNC_HEALTH.connections[0], freshness: 'attention', needs_attention: true, recommended_action: 'reconnect' }],
  };
  const html = rendered(Accounts, '/accounts', accountsSeed(broken), 'Reconnect');
  assert.ok(raisedIn(html).includes('clay'), 'a broken connection and the screen says nothing');
});

test('and a history that falls below zero still draws its clay fill', () => {
  // Guards the matcher rather than the screen: the chart's empty below-zero polygon is discounted,
  // and this is the case where that polygon has area and must count.
  const underwater: NetWorthTimeline = {
    ...TIMELINE,
    points: TIMELINE.points.map((p, i) => ({ ...p, net_worth: i < 2 ? -400 : p.net_worth })),
  };
  const seed = accountsSeed(SYNC_HEALTH).map(([key, data]) =>
    key[0] === 'networth' ? ([key, underwater] as const) : ([key, data] as const)
  );
  const html = rendered(Accounts, '/accounts', seed, 'Chase Checking');
  assert.deepEqual(raisedIn(html), ['clay']);
});

// ─── Investments ──────────────────────────────────────────────────────────────

function holding(overrides: Partial<Holding> & Pick<Holding, 'id' | 'ticker'>): Holding {
  return {
    account_id: BROKERAGE.id,
    security_id: `sec_${overrides.id}`,
    quantity: 10,
    institution_price: 102.252,
    institution_value: 1022.52,
    cost_basis: 900,
    effective_cost_basis: 900,
    cost_basis_quality: 'provider',
    currency: 'USD',
    updated_at: stamp,
    security_name: `${overrides.ticker} fund`,
    security_type: 'etf',
    ...overrides,
  };
}

const HOLDINGS = [holding({ id: 'h_vti', ticker: 'VTI' }), holding({ id: 'h_vxus', ticker: 'VXUS' })];

function returnsFor(annualized: number) {
  const row = { name: 'Fidelity Brokerage', annualized, reason: null, start_value: 1800, end_value: 2045.04, net_flows: 100, start_estimated: false };
  return {
    from: day(365),
    to: day(0),
    days: 365,
    accounts: [{ ...row, account_id: BROKERAGE.id }],
    portfolio: { ...row, account_id: null, name: 'Portfolio' },
    method: '',
  };
}

function investmentsReport(holdings: Holding[], annualized = 0.0734) {
  const value = holdings.reduce((s, h) => s + h.institution_value, 0);
  return {
    returns: returnsFor(annualized),
    portfolio_value: value,
    holdings_value: value,
    invested_balance: value,
    crypto_value: 0,
    portfolio_account_ids: [BROKERAGE.id],
    external_flows: [],
    history: [28, 21, 14, 7, 0].map((back, i) => ({
      date: day(back),
      value: value - (4 - i) * 10,
      estimated: false,
      covered_accounts: 1,
      covered_account_ids: [BROKERAGE.id],
      membership: 'recorded' as const,
    })),
    allocation: [{ security_type: 'etf', total_value: value }],
    holdings,
  };
}

function investmentsSeed(holdings: Holding[], annualized?: number): Seed {
  return [
    [['holdings'], holdings],
    [['accounts'], [{ ...BROKERAGE, current_balance: holdings.reduce((s, h) => s + h.institution_value, 0) }]],
    [['reports-investments', '1Y'], investmentsReport(holdings, annualized)],
  ];
}

test('a healthy portfolio raises nothing', () => {
  const report = investmentsReport(HOLDINGS);
  assert.deepEqual(
    investmentNotes({
      portfolioValue: report.portfolio_value,
      investedBalance: report.invested_balance,
      holdingsValue: report.holdings_value,
      cryptoValue: report.crypto_value,
    }),
    { crypto: null, uninvested: null, reconciliation: null }
  );
  assert.ok((getCostBasisStats(HOLDINGS).unrealized ?? -1) >= 0, 'the fixture holds a loss');
  assertSilent(rendered(Investments, '/investments', investmentsSeed(HOLDINGS), 'VXUS'), '/investments');
});

test('an annualized return is a number in neutral ink, whatever its sign', () => {
  assertSilent(rendered(Investments, '/investments', investmentsSeed(HOLDINGS), '7.3% a year'), '/investments');
  assertSilent(rendered(Investments, '/investments', investmentsSeed(HOLDINGS, -0.0647), '-6.5% a year'), '/investments');
});

test('and a return that was not computed says why, with no number', () => {
  const seed = investmentsSeed(HOLDINGS).map(([key, data]) =>
    key[0] === 'reports-investments'
      ? ([key, { ...(data as ReturnType<typeof investmentsReport>), returns: { ...returnsFor(0), days: 60, portfolio: { ...returnsFor(0).portfolio, annualized: null, reason: 'not enough history' } } }] as const)
      : ([key, data] as const)
  );
  const html = rendered(Investments, '/investments', seed, 'not enough history');
  assertSilent(html, '/investments');
});

test('and a position under water raises clay there', () => {
  const losing = [HOLDINGS[0], holding({ id: 'h_vxus', ticker: 'VXUS', cost_basis: 1500, effective_cost_basis: 1500 })];
  assert.ok((getCostBasisStats(losing).unrealized ?? 0) < 0);
  const html = rendered(Investments, '/investments', investmentsSeed(losing), 'VXUS');
  assert.ok(raisedIn(html).includes('clay'), 'an unrealized loss and the screen says nothing');
});

// ─── Plan ─────────────────────────────────────────────────────────────────────

const SHEET: SafeToSpend = {
  liquid: 5655.67,
  card_balances: 0,
  upcoming_bills: 0,
  expected_inflows: 0,
  recurring_transfers: 0,
  card_relief: 0,
  budgets_ahead: 0,
  estimated_unbudgeted: 0,
  unbudgeted_basis_days: 90,
  allocated_budgets: 300,
  allocated_goals: 1001.7,
  free: 4353.97,
  forecast_days: 30,
};

function budget(spent: number): ProjectedBudget {
  return {
    id: 'b_food',
    category_id: 'cat_food',
    amount: 500,
    available_amount: 500,
    period: 'monthly',
    rollover: false,
    rollover_balance: 0,
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: stamp,
    category_name: 'Food & Drink',
    spent,
    expected_recurring: 0,
    projected_spend: spent,
    projected_remaining: 500 - spent,
    projected_percent: (spent / 500) * 100,
    forecast_confidence: 'none',
  };
}

const GOAL: Goal = {
  id: 'g_ef',
  name: 'Emergency Fund',
  type: 'savings',
  target_amount: 5000,
  current_amount: 1001.7,
  account_id: SAVINGS.id,
  target_date: null,
  is_archived: false,
  created_at: '2026-06-01T00:00:00.000Z',
  updated_at: stamp,
  progress_amount: 1001.7,
  remaining_amount: 3998.3,
  progress_percent: 20.034,
} as Goal;

const NO_LUMPS: ExpectedLumpsResponse = { confirmed: [], candidates: [] };

const RUNWAY: RunwayReading = {
  end_date: '2026-12-31',
  days: 70,
  lowest: 2911.4,
  lowest_on: '2026-12-31',
  first_short_on: null,
  covered: true,
  lowest_band: { p10: 2410.12, p50: 2890.55, p90: 3301.2 },
  band_note: null,
  expected_lumps_counted: [],
  largest_scheduled_drain: {
    label: 'Transfer to Wealthfront', pattern_id: 'rp_wf', occurrences: 10, total: 1000,
    lowest_without: 3911.4, lowest_without_on: '2026-12-31', raises_low_by: 1000,
  },
  assumptions: ['Scheduled income, bills and transfers land on their forecast dates.'],
};

function planSeed(spent: number, lumps: ExpectedLumpsResponse = NO_LUMPS, runway: RunwayReading = RUNWAY, starters: StarterBudgetReading[] = []): Seed {
  return [
    [['budgets', 'starter'], starters],
    [['expected-lumps'], lumps],
    [['insights', 'runway', 'default'], runway],
    [['insights', 'safe-to-spend'], SHEET],
    [['budgets', format(now, 'yyyy-MM')], [budget(spent)]],
    [['categories'], CATEGORIES],
    [['goals', 'all'], [GOAL]],
    [['recurring', 'forecast', 30], forecast([])],
    [['accounts'], ACCOUNTS],
    [['budgets', 'rollover-ledger', 'b_food'], []],
  ];
}

test('a healthy plan raises nothing', () => {
  assert.ok(SHEET.free > 0);
  assert.equal(healthTone(200, 500), 'sage');
  const html = rendered(Plan, '/plan', planSeed(200), 'Emergency Fund');
  assertSilent(html, '/plan');
  assert.ok(html.includes('Covered through Dec 31, 2026'));
  assert.ok(html.includes('Without Transfer to Wealthfront (scheduled 10 times, $1,000.00 in all) the lowest point would be $3,911.40 on Dec 31, 2026.'));
});

test('and a runway that runs short raises estimate ink there, naming the first short day', () => {
  const short: RunwayReading = { ...RUNWAY, covered: false, lowest: -412.5, lowest_on: '2026-12-31', first_short_on: '2026-12-02', lowest_band: { p10: -980.1, p50: -430, p90: 120.4 } };
  const html = rendered(Plan, '/plan', planSeed(200, NO_LUMPS, short), 'Projected short from Dec 2, 2026');
  assert.deepEqual(raisedIn(html), ['estimate']);
  assert.ok(html.includes('$412.50 short on Dec 31, 2026'));
});

test('a runway without enough history for a band says so beside its covered reading', () => {
  const young: RunwayReading = { ...RUNWAY, lowest_band: null, band_note: 'Only 40 days of spending history; a band needs 90.' };
  const html = rendered(Plan, '/plan', planSeed(200, NO_LUMPS, young), 'Covered through Dec 31, 2026');
  assertSilent(html, '/plan');
  assert.ok(html.includes('Only 40 days of spending history; a band needs 90. The reading above is the point projection alone.'));
});

test('an expected lump renders in estimate ink with its window and range, and nothing else is raised', () => {
  const html = rendered(Plan, '/plan', planSeed(200, {
    confirmed: [{ id: 'lump_1', label: 'Deposits', amount_low: 5000, amount_high: 5000, window_start: '2027-03-07', window_end: '2027-04-16' }],
    candidates: [{
      payload: { kind: 'expect_lump', label: 'MIT student account refund', merchant_key: 'ma institute tec erefund', amount_low: 1842.25, amount_high: 3236.25, window_start: '2027-03-14', window_end: '2027-05-17', last_occurrence: '2026-09-17' },
      occurrences: [{ date: '2026-09-17', amount: 3236.25 }],
      draft_id: null,
    }],
  }), 'Expected, not scheduled');
  assert.deepEqual(raisedIn(html), ['estimate']);
  assert.ok(html.includes('$1,842.25 to $3,236.25'));
  assert.ok(html.includes('Mar 14 to May 17, 2027'));
  assert.ok(html.includes('$5,000.00'));
});

test('and an overspent budget raises clay there', () => {
  assert.equal(healthTone(640, 500), 'clay');
  const html = rendered(Plan, '/plan', planSeed(640), 'Food &amp; Drink');
  assert.ok(raisedIn(html).includes('clay'), 'a budget $140 over and the screen says nothing');
});

// ─── Advisor ──────────────────────────────────────────────────────────────────

const AUTONOMY: AdvisorAutonomyResponse = {
  kinds: (Object.keys(DRAFT_KIND_AUTONOMY) as Array<keyof typeof DRAFT_KIND_AUTONOMY>).map((kind) => ({
    kind,
    autonomy: DRAFT_KIND_AUTONOMY[kind].autonomy,
  })),
};

const CONTEXT: AdvisorContextResponse = {
  context: 'Net worth $7,700.71.',
  configured: true,
  credential_source: 'stored',
  generated_at: stamp,
  sync_health: SYNC_HEALTH,
  actions: [],
  tools: [],
};

const CONVERSATIONS = [{ id: 'conv_1', title: 'Is the emergency fund on pace?', updated_at: stamp, message_count: 4 }];

type AiActionItem = Awaited<ReturnType<typeof aiApi.listActions>>[number];

const CONFIRMED_ACTION: AiActionItem = {
  id: 'act_1',
  kind: 'categorize_transaction',
  label: 'Categorize Sweetgreen as Food & Drink',
  summary: '1 row',
  source: 'user_confirm',
  created_at: stamp,
};

function advisorSeed(actions: AiActionItem[]): Seed {
  return [
    [['ai-conversations'], CONVERSATIONS],
    [['ai-drafts', 'open'], []],
    [['ai-context'], CONTEXT],
    [['ai-actions'], actions],
    [['ai-autonomy'], AUTONOMY],
  ];
}

test('a healthy advisor page raises nothing', () => {
  assertSilent(rendered(Advisor, '/advisor', advisorSeed([CONFIRMED_ACTION]), 'Is the emergency fund on pace?'), '/advisor');
});

test('an action the advisor applied on its own is marked, not alarmed', () => {
  const auto: AiActionItem = { ...CONFIRMED_ACTION, id: 'act_2', source: 'worker_auto' };
  assertSilent(rendered(Advisor, '/advisor', advisorSeed([auto]), 'auto-applied'), '/advisor');
});

// ─── Settings ─────────────────────────────────────────────────────────────────

const CREDENTIALS: CredentialStatus = { coinbase: false, coinbaseFromEnv: false, simplefin: true };
const CONNECTION = { id: 'conn_bank', status: 'active', last_synced_at: stamp, created_at: '2026-06-01T00:00:00.000Z' };
const NO_RELINK: SimplefinRelinkPendingResponse = { proposal: null, carries: [] };

function settingsSeed(relink: SimplefinRelinkPendingResponse): Seed {
  return [
    [['credential-status'], CREDENTIALS],
    [['simplefin-connection'], CONNECTION],
    [['accounts'], ACCOUNTS],
    [['ai-context'], CONTEXT],
    [['categories'], CATEGORIES],
    [['rules'], []],
    [['ai-memory'], []],
    [['sync', 'health'], SYNC_HEALTH],
    [['transactions', 'review'], REVIEW],
    [['ai-autonomy'], AUTONOMY],
    [['simplefin', 'relink'], relink],
    [['ai-settings'], ADVISOR_SETTINGS],
  ];
}

const ADVISOR_SETTINGS: AdvisorSettings = {
  model: 'claude-sonnet-5-5',
  effort: 'medium',
  available: { models: [], efforts: [], providers: [] },
  jobs: [],
};

test('a healthy settings screen raises nothing', () => {
  assertSilent(rendered(Settings, '/settings', settingsSeed(NO_RELINK), 'SimpleFIN'), '/settings');
});

test('and a re-link waiting on the owner raises review ink there', () => {
  const pending: SimplefinRelinkPendingResponse = {
    proposal: {
      id: 'relink_1',
      detected_at: stamp,
      outcome: 'relink',
      status: 'pending',
      headline: 'Chase issued new account ids',
      recovery_action: 'Pair each new account with the one it replaces.',
      resolve_on: 'Settings',
      resolve_on_path: '/settings?section=simplefin',
      provider_accounts: [],
      stored_accounts: [],
      pairs: [],
      unpaired_stored: [],
      unpaired_provider: [],
      resolved_at: null,
      applied_pairs: null,
      dismissed_reason: null,
    },
    carries: [],
  };
  const html = rendered(Settings, '/settings', settingsSeed(pending), 'Needs your confirmation');
  assert.ok(raisedIn(html).includes('review'), 'every sync is blocked and the screen says nothing');
});

test('a budget to start from renders in neutral ink with its median stated', () => {
  const starter: StarterBudgetReading = {
    category_id: 'cat_transport', category_name: 'Transport', amount: 280, median: 283.5,
    months: Array.from({ length: 12 }, (_, i) => ({ month: `2025-${String(i + 1).padStart(2, '0')}`, spent: 283.5 })),
    months_with_spend: 12, months_at_or_under: 5,
  };
  const html = rendered(Plan, '/plan', planSeed(200, NO_LUMPS, RUNWAY, [starter]), 'Budgets to start from');
  assertSilent(html, '/plan');
  assert.ok(html.includes('median of 12 months $283.50, at or under in 5 of 12'));
});
