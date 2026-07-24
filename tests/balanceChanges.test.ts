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
    provider: 'simplefin' as const,
    previousBalance: 1000,
    newBalance: 1125.5,
    isLiability: false,
    currency: 'USD',
  };

  assert.equal(balanceDelta(change), 125.5);
  assert.equal(netWorthImpact(change), 125.5);
  assert.equal(
    describeBalanceChange(change),
    'Everyday Checking balance changed from $1,000.00 to $1,125.50; +$125.50 via SimpleFIN; net worth impact +$125.50'
  );
});

test('balance changes invert net worth impact for liabilities', () => {
  const change = {
    accountId: 'acct_card',
    accountName: 'Credit Card',
    provider: 'simplefin' as const,
    previousBalance: 500,
    newBalance: 650,
    isLiability: true,
    currency: 'USD',
  };

  assert.equal(balanceDelta(change), 150);
  assert.equal(netWorthImpact(change), -150);
  assert.equal(
    describeBalanceChange(change),
    'Credit Card balance changed from $500.00 to $650.00; +$150.00 via SimpleFIN; net worth impact -$150.00'
  );
});

test('balancesDiffer works on integer cents: any whole-cent change fires, sub-cent noise does not', () => {
  // Callers pass integer cents. Equal cents = no change.
  assert.equal(balancesDiffer(10000, 10000), false);
  // A one-cent change fires.
  assert.equal(balancesDiffer(10000, 10001), true);
  // Sub-cent fractional noise (below a whole cent) is ignored.
  assert.equal(balancesDiffer(10000, 10000.4), false);
});
