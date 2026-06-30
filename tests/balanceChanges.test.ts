import test from 'node:test';
import assert from 'node:assert/strict';
import {
  balanceDelta,
  balancesDiffer,
  describeBalanceChange,
  netWorthImpact,
} from '../server/src/services/balanceChanges';

test('balance changes calculate asset deltas and descriptions', () => {
  const change = {
    accountId: 'acct_checking',
    accountName: 'Everyday Checking',
    provider: 'plaid' as const,
    previousBalance: 1000,
    newBalance: 1125.5,
    isLiability: false,
    currency: 'USD',
  };

  assert.equal(balanceDelta(change), 125.5);
  assert.equal(netWorthImpact(change), 125.5);
  assert.equal(
    describeBalanceChange(change),
    'Everyday Checking balance changed from $1,000.00 to $1,125.50; +$125.50 via Plaid; net worth impact +$125.50'
  );
});

test('balance changes invert net worth impact for liabilities', () => {
  const change = {
    accountId: 'acct_card',
    accountName: 'Credit Card',
    provider: 'plaid' as const,
    previousBalance: 500,
    newBalance: 650,
    isLiability: true,
    currency: 'USD',
  };

  assert.equal(balanceDelta(change), 150);
  assert.equal(netWorthImpact(change), -150);
  assert.equal(
    describeBalanceChange(change),
    'Credit Card balance changed from $500.00 to $650.00; +$150.00 via Plaid; net worth impact -$150.00'
  );
});

test('balance difference threshold ignores sub-cent noise', () => {
  assert.equal(balancesDiffer(100, 100.004), false);
  assert.equal(balancesDiffer(100, 100.01), true);
});
