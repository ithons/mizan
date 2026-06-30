import test from 'node:test';
import assert from 'node:assert/strict';
import { advisorRouteState, isAdvisorRouteState } from '../client/src/lib/advisorRouteState';

test('advisor route state wraps a typed contextual prompt', () => {
  const state = advisorRouteState({
    source: 'reports',
    prompt: 'Explain this cash-flow report.',
    recordKind: 'report_slice',
    recordId: 'summary',
    params: { tab: 'cashflow', comparison: 'prior_month' },
  });

  assert.equal(isAdvisorRouteState(state), true);
  assert.equal(state.advisorPrompt.source, 'reports');
  assert.equal(state.advisorPrompt.params?.comparison, 'prior_month');
});

test('advisor route state guard rejects missing or blank prompts', () => {
  assert.equal(isAdvisorRouteState(null), false);
  assert.equal(isAdvisorRouteState({}), false);
  assert.equal(isAdvisorRouteState({ advisorPrompt: { source: 'reports', prompt: '   ' } }), false);
});
