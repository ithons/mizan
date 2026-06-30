import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getAllocationQualityLabel,
  getAllocationSlices,
  getConcentrationSummary,
  getCostBasisStats,
  getInvestmentDataQualitySummary,
  getInvestmentActivitySummary,
} from '../client/src/lib/investmentAnalytics';
import type { Account, Holding, InvestmentTransaction } from '../shared/types';

function account(id: string, type: Account['type']): Account {
  return {
    id,
    plaid_account_id: null,
    coinbase_account_id: null,
    connection_id: null,
    connection_type: 'manual',
    institution_name: 'Mizan Test',
    account_name: id,
    type,
    subtype: null,
    mask: null,
    current_balance: 0,
    available_balance: null,
    credit_limit: null,
    currency: 'USD',
    native_currency: null,
    native_balance: null,
    is_manual: true,
    is_hidden: false,
    is_liability: false,
    color: null,
    sort_order: 0,
    created_at: '2026-06-30T00:00:00.000Z',
    updated_at: '2026-06-30T00:00:00.000Z',
  };
}

function holding(overrides: Partial<Holding>): Holding {
  return {
    id: overrides.id ?? 'holding',
    account_id: overrides.account_id ?? 'acct_taxable',
    security_id: overrides.security_id ?? 'sec',
    quantity: overrides.quantity ?? 1,
    institution_price: overrides.institution_price ?? overrides.institution_value ?? 0,
    institution_value: overrides.institution_value ?? 0,
    cost_basis: overrides.cost_basis,
    currency: 'USD',
    updated_at: '2026-06-30T00:00:00.000Z',
    ticker: overrides.ticker ?? null,
    security_name: overrides.security_name ?? null,
    security_type: overrides.security_type ?? null,
  };
}

function investmentTransaction(overrides: Partial<InvestmentTransaction>): InvestmentTransaction {
  return {
    id: overrides.id ?? 'tx',
    plaid_investment_transaction_id: null,
    account_id: overrides.account_id ?? 'acct_taxable',
    date: overrides.date ?? '2026-06-30',
    type: overrides.type ?? 'buy',
    security_id: overrides.security_id ?? null,
    quantity: overrides.quantity ?? null,
    price: overrides.price ?? null,
    amount: overrides.amount ?? 0,
    fees: overrides.fees ?? null,
    name: overrides.name ?? 'Investment transaction',
    created_at: '2026-06-30T00:00:00.000Z',
    ticker: overrides.ticker ?? null,
    security_name: overrides.security_name ?? null,
  };
}

test('cost basis stats only calculate returns from holdings with known basis', () => {
  const stats = getCostBasisStats([
    holding({ id: 'known_a', institution_value: 1200, cost_basis: 1000 }),
    holding({ id: 'known_b', institution_value: 900, cost_basis: 800 }),
    holding({ id: 'missing', institution_value: 500, cost_basis: null }),
  ]);

  assert.equal(stats.label, 'Partial');
  assert.equal(stats.totalCount, 3);
  assert.equal(stats.knownCount, 2);
  assert.equal(stats.missingCount, 1);
  assert.equal(stats.knownCostBasis, 1800);
  assert.equal(stats.unrealized, 300);
  assert.equal(stats.returnPct, 300 / 1800 * 100);
  assert.equal(stats.coveragePct, 2 / 3 * 100);
});

test('allocation quality makes missing account links explicit', () => {
  const accounts = new Map([
    ['acct_taxable', account('acct_taxable', 'brokerage')],
    ['acct_ira', account('acct_ira', 'ira_roth')],
  ]);
  const holdings = [
    holding({ id: 'taxable', account_id: 'acct_taxable', institution_value: 1000 }),
    holding({ id: 'ira', account_id: 'acct_ira', institution_value: 500 }),
    holding({ id: 'missing', account_id: 'acct_missing', institution_value: 250 }),
  ];

  const slices = getAllocationSlices(holdings, 'tax_treatment', accounts);

  assert.deepEqual(
    slices.map((slice) => [slice.label, slice.value, Number(slice.pct.toFixed(1))]),
    [
      ['Taxable', 1000, 57.1],
      ['Tax-advantaged', 500, 28.6],
      ['Other', 250, 14.3],
    ]
  );
  assert.equal(
    getAllocationQualityLabel(holdings, 'tax_treatment', accounts),
    '1 holding missing account links'
  );
});

test('concentration summary groups positions before calculating top exposure', () => {
  const accounts = new Map([
    ['acct_taxable', account('acct_taxable', 'brokerage')],
    ['acct_ira', account('acct_ira', 'ira_traditional')],
  ]);
  const holdings = [
    holding({ id: 'aaa_a', account_id: 'acct_taxable', ticker: 'AAA', institution_value: 250 }),
    holding({ id: 'aaa_b', account_id: 'acct_ira', ticker: 'AAA', institution_value: 150 }),
    holding({ id: 'bbb', account_id: 'acct_taxable', ticker: 'BBB', institution_value: 250 }),
    holding({ id: 'ccc', account_id: 'acct_ira', ticker: 'CCC', institution_value: 150 }),
    holding({ id: 'ddd', account_id: 'acct_ira', ticker: 'DDD', institution_value: 100 }),
    holding({ id: 'eee', account_id: 'acct_taxable', ticker: 'EEE', institution_value: 50 }),
    holding({ id: 'fff', account_id: 'acct_taxable', ticker: 'FFF', institution_value: 50 }),
  ];

  const summary = getConcentrationSummary(holdings, accounts);

  assert.equal(summary.label, 'Concentrated');
  assert.equal(summary.totalValue, 1000);
  assert.equal(summary.largestPosition?.label, 'AAA');
  assert.equal(summary.largestPosition?.value, 400);
  assert.equal(summary.largestPosition?.pct, 40);
  assert.equal(summary.topFiveValue, 950);
  assert.equal(summary.topFivePct, 95);
  assert.equal(summary.largestAccount?.label, 'Brokerage');
  assert.equal(summary.largestAccount?.value, 600);
});

test('investment activity summarizes imported transaction flow without inventing realized gains', () => {
  const summary = getInvestmentActivitySummary([
    investmentTransaction({ id: 'buy', type: 'buy', amount: -1000, fees: 1 }),
    investmentTransaction({ id: 'sell', type: 'sell', amount: 700, fees: 2 }),
    investmentTransaction({ id: 'dividend', type: 'dividend', amount: 25 }),
    investmentTransaction({ id: 'fee', type: 'fee', amount: -4 }),
    investmentTransaction({ id: 'transfer', type: 'transfer', amount: 300 }),
    investmentTransaction({ id: 'other', type: 'other', amount: -10 }),
  ]);

  assert.equal(summary.transactionCount, 6);
  assert.equal(summary.buyAmount, 1000);
  assert.equal(summary.sellAmount, 700);
  assert.equal(summary.dividendAmount, 25);
  assert.equal(summary.feeAmount, 7);
  assert.equal(summary.transferAmount, 300);
  assert.equal(summary.otherAmount, 10);
  assert.equal(summary.netAmount, 11);
  assert.equal(summary.saleCount, 1);
  assert.equal(summary.realizedGain, null);
  assert.equal(summary.realizedGainLabel, 'Not available');
  assert.match(summary.realizedGainDetail, /lot-level sale cost basis/);
});

test('investment data quality starts empty without investment sources', () => {
  const summary = getInvestmentDataQualitySummary({
    holdings: [],
    transactions: [],
    investmentAccountCount: 0,
    accountById: new Map(),
    historyPointCount: 0,
  });

  assert.equal(summary.status, 'empty');
  assert.equal(summary.label, 'No Investment Data');
  assert.deepEqual(summary.issues.map((issue) => issue.id), ['no-investment-source']);
});

test('investment data quality marks provider limitations without requiring attention', () => {
  const accounts = new Map([
    ['acct_taxable', account('acct_taxable', 'brokerage')],
  ]);
  const summary = getInvestmentDataQualitySummary({
    holdings: [
      holding({ id: 'known', account_id: 'acct_taxable', security_type: 'equity', cost_basis: 900, institution_value: 1000 }),
      holding({ id: 'missing_type', account_id: 'acct_taxable', cost_basis: 100, institution_value: 110 }),
    ],
    transactions: [
      investmentTransaction({ id: 'sell', type: 'sell', amount: 250 }),
    ],
    investmentAccountCount: 1,
    accountById: accounts,
    historyPointCount: 1,
  });

  assert.equal(summary.status, 'limited');
  assert.deepEqual(summary.issues.map((issue) => issue.id), [
    'security-type-missing',
    'realized-gain-unavailable',
    'history-limited',
  ]);
});

test('investment data quality escalates missing core holding data', () => {
  const accounts = new Map([
    ['acct_taxable', account('acct_taxable', 'brokerage')],
  ]);
  const summary = getInvestmentDataQualitySummary({
    holdings: [
      holding({ id: 'missing_basis', account_id: 'acct_taxable', security_type: 'equity', cost_basis: null, institution_value: 1000 }),
      holding({ id: 'missing_account', account_id: 'acct_missing', security_type: 'etf', cost_basis: null, institution_value: 500 }),
    ],
    transactions: [],
    investmentAccountCount: 1,
    accountById: accounts,
    historyPointCount: 2,
  });

  assert.equal(summary.status, 'attention');
  assert.deepEqual(summary.issues.map((issue) => issue.id), [
    'missing-account-links',
    'cost-basis-missing',
    'no-investment-transactions',
  ]);
});
