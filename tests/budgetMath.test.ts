import assert from 'node:assert/strict';
import test from 'node:test';
import {
  availableBudgetAmount,
  budgetProjectedPercent,
  budgetProjectedRemaining,
  budgetProjectedSpend,
} from '../client/src/lib/budgetMath';

test('budget math uses rollover-adjusted availability', () => {
  const budget = {
    amount: 500,
    rollover: true,
    rollover_balance: 250,
    spent: 100,
    projected_spend: 300,
  };

  assert.equal(availableBudgetAmount(budget), 750);
  assert.equal(budgetProjectedSpend(budget), 300);
  assert.equal(budgetProjectedRemaining(budget), 450);
  assert.equal(budgetProjectedPercent(budget), 40);
});

test('budget math falls back to actual spending without projections', () => {
  const budget = {
    amount: 500,
    rollover: false,
    rollover_balance: 250,
    spent: 125,
  };

  assert.equal(availableBudgetAmount(budget), 500);
  assert.equal(budgetProjectedSpend(budget), 125);
  assert.equal(budgetProjectedRemaining(budget), 375);
  assert.equal(budgetProjectedPercent(budget), 25);
});

test('budget math preserves server-provided projection fields', () => {
  const budget = {
    amount: 500,
    rollover: true,
    rollover_balance: 100,
    spent: 125,
    projected_spend: 275,
    projected_remaining: 333,
    projected_percent: 12.5,
  };

  assert.equal(budgetProjectedRemaining(budget), 333);
  assert.equal(budgetProjectedPercent(budget), 12.5);
});
