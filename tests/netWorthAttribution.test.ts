import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNetWorthAttribution } from '../client/src/lib/netWorthAttribution';
import type { Account, NetWorthSnapshot } from '../shared/types';

function snapshot(overrides: Partial<NetWorthSnapshot>): NetWorthSnapshot {
  return {
    id: overrides.id ?? 'nw',
    date: overrides.date ?? '2026-06-30',
    total_assets: overrides.total_assets ?? 0,
    total_liabilities: overrides.total_liabilities ?? 0,
    net_worth: overrides.net_worth ?? 0,
    breakdown: overrides.breakdown ?? '{}',
    is_estimated: overrides.is_estimated ?? false,
    created_at: overrides.created_at ?? '2026-06-30T00:00:00.000Z',
    liquid_assets: overrides.liquid_assets ?? 0,
    investment_assets: overrides.investment_assets ?? 0,
    crypto_assets: overrides.crypto_assets ?? 0,
  };
}

function account(overrides: Partial<Account>): Account {
  return {
    id: overrides.id ?? 'acct_checking',
    plaid_account_id: overrides.plaid_account_id ?? null,
    coinbase_account_id: overrides.coinbase_account_id ?? null,
    connection_id: overrides.connection_id ?? null,
    connection_type: overrides.connection_type ?? 'manual',
    account_name: overrides.account_name ?? 'Everyday Checking',
    institution_name: overrides.institution_name ?? 'Mizan Test Bank',
    type: overrides.type ?? 'checking',
    subtype: overrides.subtype ?? null,
    current_balance: overrides.current_balance ?? 0,
    available_balance: overrides.available_balance ?? null,
    credit_limit: overrides.credit_limit ?? null,
    currency: overrides.currency ?? 'USD',
    native_currency: overrides.native_currency ?? null,
    native_balance: overrides.native_balance ?? null,
    is_manual: overrides.is_manual ?? true,
    is_liability: overrides.is_liability ?? false,
    is_hidden: overrides.is_hidden ?? false,
    color: overrides.color ?? null,
    sort_order: overrides.sort_order ?? 0,
    mask: overrides.mask ?? null,
    created_at: overrides.created_at ?? '2026-06-30T00:00:00.000Z',
    updated_at: overrides.updated_at ?? '2026-06-30T00:00:00.000Z',
  };
}

test('net worth attribution calculates class and account deltas', () => {
  const attribution = buildNetWorthAttribution({
    snapshots: [
      snapshot({
        id: 'may',
        date: '2026-05-31',
        total_assets: 1500,
        total_liabilities: 300,
        net_worth: 1200,
        liquid_assets: 1000,
        investment_assets: 500,
        breakdown: '{"acct_checking":1000,"acct_brokerage":500,"acct_card":300}',
      }),
      snapshot({
        id: 'jun',
        date: '2026-06-30',
        total_assets: 1800,
        total_liabilities: 250,
        net_worth: 1550,
        liquid_assets: 1200,
        investment_assets: 600,
        breakdown: '{"acct_checking":1200,"acct_brokerage":600,"acct_card":250}',
      }),
    ],
    accounts: [
      account({ id: 'acct_checking', account_name: 'Everyday Checking', type: 'checking' }),
      account({ id: 'acct_brokerage', account_name: 'Brokerage', type: 'brokerage' }),
      account({ id: 'acct_card', account_name: 'Rewards Card', type: 'credit', is_liability: true }),
    ],
  });

  assert.ok(attribution);
  assert.equal(attribution.net_worth_delta, 350);
  assert.equal(attribution.asset_delta, 300);
  assert.equal(attribution.liability_delta, -50);
  assert.deepEqual(
    attribution.class_deltas.map((item) => [item.id, item.balance_delta, item.net_worth_delta]),
    [
      ['liquid', 200, 200],
      ['investments', 100, 100],
      ['liabilities', -50, 50],
    ]
  );
  assert.deepEqual(
    attribution.account_deltas.map((item) => [item.account_id, item.balance_delta, item.net_worth_delta]),
    [
      ['acct_checking', 200, 200],
      ['acct_brokerage', 100, 100],
      ['acct_card', -50, 50],
    ]
  );
});

test('net worth attribution handles malformed breakdown and missing prior snapshot', () => {
  assert.equal(buildNetWorthAttribution({
    snapshots: [snapshot({ id: 'only' })],
  }), null);

  const attribution = buildNetWorthAttribution({
    snapshots: [
      snapshot({ id: 'may', date: '2026-05-31', breakdown: 'not json' }),
      snapshot({ id: 'jun', date: '2026-06-30', breakdown: '{"acct_checking":100}' }),
    ],
  });

  assert.equal(attribution?.account_deltas.length, 1);
  assert.equal(attribution?.account_deltas[0].account_name, 'acct_checking');
  assert.equal(attribution?.account_deltas[0].net_worth_delta, 100);
});
