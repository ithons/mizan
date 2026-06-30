import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getAllocationQualityLabel,
  getAllocationSlices,
  getConcentrationSummary,
  getCostBasisStats,
} from '../client/src/lib/investmentAnalytics';
import type { Account, Holding } from '../shared/types';

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
