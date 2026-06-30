import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateGoalProgress } from '../server/src/services/goalProgress';

test('manual savings goal caps progress at the target amount', () => {
  assert.deepEqual(
    calculateGoalProgress({
      type: 'savings',
      target_amount: 1000,
      current_amount: 1200,
    }),
    {
      current_amount: 1200,
      progress_amount: 1000,
      remaining_amount: 0,
      progress_percent: 100,
    }
  );
});

test('linked savings goal uses the live account balance', () => {
  assert.deepEqual(
    calculateGoalProgress({
      type: 'savings',
      target_amount: 1000,
      current_amount: 250,
      account_balance: 400,
    }),
    {
      current_amount: 400,
      progress_amount: 400,
      remaining_amount: 600,
      progress_percent: 40,
    }
  );
});

test('linked debt goal measures payoff from starting balance', () => {
  assert.deepEqual(
    calculateGoalProgress({
      type: 'debt',
      target_amount: 5000,
      starting_amount: 5000,
      current_amount: 0,
      account_balance: 3200,
    }),
    {
      current_amount: 1800,
      progress_amount: 1800,
      remaining_amount: 3200,
      progress_percent: 36,
    }
  );
});
