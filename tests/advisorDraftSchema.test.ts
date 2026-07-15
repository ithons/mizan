import test from 'node:test';
import assert from 'node:assert/strict';
import { AiWorkerDraftSchema, AdvisorDraftPayloadSchema } from '../shared/schemas';

// The aiWorker parses raw JSON from the model and validates each draft against
// AiWorkerDraftSchema before storing or auto-applying it. These tests pin the
// trust boundary: well-formed drafts pass, malformed/hallucinated ones are rejected.

function goodCategorize() {
  return {
    kind: 'categorize_transaction',
    label: 'Categorize Trupanion',
    summary: 'Trupanion is pet insurance.',
    route: '/transactions',
    confidence: 0.95,
    payload: { kind: 'categorize_transaction', transaction_id: 'txn_1', category_id: 'cat_health' },
    changes: [{ field: 'category', before: 'Uncategorized', after: 'Health' }],
    citations: [],
  };
}

test('accepts a well-formed categorize_transaction draft', () => {
  const r = AiWorkerDraftSchema.safeParse(goodCategorize());
  assert.equal(r.success, true);
});

test('defaults changes/citations to empty arrays when omitted', () => {
  const d = goodCategorize();
  delete (d as Record<string, unknown>).changes;
  delete (d as Record<string, unknown>).citations;
  const r = AiWorkerDraftSchema.safeParse(d);
  assert.equal(r.success, true);
  if (r.success) {
    assert.deepEqual(r.data.changes, []);
    assert.deepEqual(r.data.citations, []);
  }
});

test('rejects a payload missing a required id field', () => {
  const d = goodCategorize();
  delete (d.payload as Record<string, unknown>).category_id;
  assert.equal(AiWorkerDraftSchema.safeParse(d).success, false);
});

test('rejects an empty-string id (hallucinated blank)', () => {
  const d = goodCategorize();
  d.payload.transaction_id = '';
  assert.equal(AiWorkerDraftSchema.safeParse(d).success, false);
});

test('rejects a draft whose top-level kind disagrees with payload kind', () => {
  const d = goodCategorize();
  d.kind = 'create_merchant_rule';
  assert.equal(AiWorkerDraftSchema.safeParse(d).success, false);
});

test('rejects an unknown draft kind', () => {
  const d = goodCategorize();
  d.kind = 'transfer_all_funds';
  (d.payload as Record<string, unknown>).kind = 'transfer_all_funds';
  assert.equal(AiWorkerDraftSchema.safeParse(d).success, false);
});

test('rejects a non-finite money amount', () => {
  const r = AdvisorDraftPayloadSchema.safeParse({
    kind: 'update_goal_target',
    goal_id: 'goal_1',
    target_amount: Number.POSITIVE_INFINITY,
  });
  assert.equal(r.success, false);
});

test('rejects a wrong-typed money field', () => {
  const r = AdvisorDraftPayloadSchema.safeParse({
    kind: 'update_budget',
    category_id: 'cat_1',
    amount: '500',
    period: 'monthly',
    rollover: false,
  });
  assert.equal(r.success, false);
});

test('accepts set_manual_cost_basis with an explicit null cost basis', () => {
  const r = AdvisorDraftPayloadSchema.safeParse({
    kind: 'set_manual_cost_basis',
    holding_id: 'h_1',
    manual_cost_basis: null,
  });
  assert.equal(r.success, true);
});
