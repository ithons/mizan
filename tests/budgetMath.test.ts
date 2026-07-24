import assert from 'node:assert/strict';
import test from 'node:test';
import {
  availableBudgetAmount,
  budgetProjectedPercent,
  budgetProjectedRemaining,
  budgetProjectedSpend,
  buildBudgetRowMeta,
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

// The Budget view rendered only "spent / available", so a rollover carry silently inflated the
// denominator and the server's projection was invisible until the month ended.
test('row meta explains a rollover carry that inflates the available amount', () => {
  const meta = buildBudgetRowMeta({
    amount: 500,
    rollover: true,
    rollover_balance: 100,
    spent: 200,
    projected_spend: 200,
    expected_recurring: 0,
  });

  assert.equal(meta.carriedOver, 100);
  // Actual equals projected, so a "projected" line would only be noise.
  assert.equal(meta.projection, null);
});

test('a carried overspend reads as a negative carry, not a bonus', () => {
  const meta = buildBudgetRowMeta({
    amount: 500,
    rollover: true,
    rollover_balance: -75,
    spent: 100,
    expected_recurring: 0,
  });

  assert.equal(meta.carriedOver, -75);
});

test('rollover balance is ignored when the category has rollover turned off', () => {
  const meta = buildBudgetRowMeta({
    amount: 500,
    rollover: false,
    rollover_balance: 100,
    spent: 100,
    expected_recurring: 0,
  });

  assert.equal(meta.carriedOver, null);
});

test('a scheduled bill surfaces as a projection with remaining headroom', () => {
  const meta = buildBudgetRowMeta({
    amount: 500,
    rollover: false,
    rollover_balance: 0,
    spent: 100,
    projected_spend: 400,
    projected_remaining: 100,
    expected_recurring: 300,
    forecast_confidence: 'confirmed',
  });

  assert.deepEqual(meta.projection, {
    spend: 400,
    remaining: 100,
    over: false,
    confidence: 'confirmed',
  });
});

test('a projection past the budget reports the overage as a positive number flagged over', () => {
  const meta = buildBudgetRowMeta({
    amount: 500,
    rollover: false,
    rollover_balance: 0,
    spent: 100,
    projected_spend: 650,
    projected_remaining: -150,
    expected_recurring: 550,
    forecast_confidence: 'likely',
  });

  assert.equal(meta.projection?.over, true);
  // Rendered as "$150 over", so the sign lives in the label rather than the number.
  assert.equal(meta.projection?.remaining, 150);
  assert.equal(meta.projection?.confidence, 'likely');
});
