import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBudgetAdvisorPrompt } from '../client/src/lib/advisorPrompts';
import type { Budget } from '../shared/types';

function budget(overrides: Partial<Budget> = {}): Budget {
  return {
    id: overrides.id ?? 'budget_food',
    category_id: overrides.category_id ?? 'cat_food',
    category_name: overrides.category_name ?? 'Food',
    amount: overrides.amount ?? 500,
    period: overrides.period ?? 'monthly',
    rollover: overrides.rollover ?? true,
    rollover_balance: overrides.rollover_balance ?? 50,
    created_at: overrides.created_at ?? '2026-06-01T00:00:00.000Z',
    updated_at: overrides.updated_at ?? '2026-06-01T00:00:00.000Z',
    spent: overrides.spent ?? 240,
    expected_recurring: overrides.expected_recurring ?? 90,
    projected_spend: overrides.projected_spend ?? 330,
    projected_remaining: overrides.projected_remaining ?? 220,
    forecast_confidence: overrides.forecast_confidence ?? 'likely',
  };
}

test('budget advisor prompt captures row context and projection math', () => {
  const prompt = buildBudgetAdvisorPrompt(budget(), '2026-06');

  assert.equal(prompt.source, 'budget');
  assert.equal(prompt.recordKind, 'budget_row');
  assert.equal(prompt.recordId, '2026-06:cat_food');
  assert.equal(prompt.params?.month, '2026-06');
  assert.equal(prompt.params?.actualSpent, 240);
  assert.equal(prompt.params?.available, 550);
  assert.equal(prompt.params?.projectedRemaining, 220);
  assert.match(prompt.prompt, /Food budget for 2026-06/);
  assert.match(prompt.prompt, /Actual spending is \$240\.00 against \$550\.00 available/);
  assert.match(prompt.prompt, /likely forecast confidence/);
});

test('budget advisor prompt falls back to actual spending without projections', () => {
  const fallbackBudget = budget({
    rollover: false,
    rollover_balance: 50,
    spent: 120,
  });
  fallbackBudget.category_name = null;
  delete fallbackBudget.expected_recurring;
  delete fallbackBudget.projected_spend;
  delete fallbackBudget.projected_remaining;
  delete fallbackBudget.forecast_confidence;

  const prompt = buildBudgetAdvisorPrompt(fallbackBudget, '2026-07');

  assert.equal(prompt.params?.available, 500);
  assert.equal(prompt.params?.projectedSpend, 120);
  assert.equal(prompt.params?.projectedRemaining, 380);
  assert.match(prompt.prompt, /this category budget for 2026-07/);
  assert.match(prompt.prompt, /none forecast confidence/);
});
