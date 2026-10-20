import assert from 'node:assert/strict';
import test from 'node:test';
import {
  budgetProjectedRemaining,
  budgetProjectedSpend,
  buildBudgetRowMeta,
} from '../client/src/lib/budgetMath';

test('budget math measures remaining against the ceiling the server sent', () => {
  const budget = { available_amount: 750, rollover_balance: 250, spent: 100, projected_spend: 300 };

  assert.equal(budgetProjectedSpend(budget), 300);
  assert.equal(budgetProjectedRemaining(budget), 450);
});

test('budget math falls back to actual spending without projections', () => {
  const budget = { available_amount: 500, rollover_balance: 0, spent: 125 };

  assert.equal(budgetProjectedSpend(budget), 125);
  assert.equal(budgetProjectedRemaining(budget), 375);
});

test('budget math preserves server-provided projection fields', () => {
  const budget = { available_amount: 600, rollover_balance: 100, spent: 125, projected_spend: 275, projected_remaining: 333 };

  assert.equal(budgetProjectedRemaining(budget), 333);
});

// The Budget view rendered only "spent / available", so a rollover carry silently inflated the
// denominator and the server's projection was invisible until the month ended.
test('row meta explains a rollover carry that inflates the available amount', () => {
  const meta = buildBudgetRowMeta({
    available_amount: 600,
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
    available_amount: 425,
    rollover_balance: -75,
    spent: 100,
    expected_recurring: 0,
  });

  assert.equal(meta.carriedOver, -75);
});

test('HEALTHY: a budget that carries nothing says nothing about a carry', () => {
  // The projection sends rollover_balance 0 whenever rollover is off.
  const meta = buildBudgetRowMeta({
    available_amount: 500,
    rollover_balance: 0,
    spent: 100,
    expected_recurring: 0,
  });

  assert.equal(meta.carriedOver, null);
});

test('a scheduled bill surfaces as a projection with remaining headroom', () => {
  const meta = buildBudgetRowMeta({
    available_amount: 500,
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
    available_amount: 500,
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
