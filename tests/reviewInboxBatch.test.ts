import test from 'node:test';
import assert from 'node:assert/strict';
import {
  nextReviewQueue,
  reviewBatchActions,
} from '../client/src/lib/reviewInboxBatch';

test('review inbox queue navigation wraps through desktop queues', () => {
  assert.equal(nextReviewQueue('uncategorized', 1), 'rule_suggestions');
  assert.equal(nextReviewQueue('uncategorized', -1), 'transfer_candidates');
  assert.equal(nextReviewQueue('transfer_candidates', 1), 'uncategorized');
});

test('review inbox exposes batch actions only where safe', () => {
  assert.deepEqual(reviewBatchActions('uncategorized', 4), []);
  assert.deepEqual(reviewBatchActions('pending', 2), [
    { id: 'primary', label: 'Mark All Reviewed' },
  ]);
  assert.deepEqual(reviewBatchActions('recurring_candidates', 3), [
    { id: 'primary', label: 'Confirm All' },
    { id: 'dismiss', label: 'Dismiss All' },
  ]);
  assert.deepEqual(reviewBatchActions('duplicate_candidates', 3), [
    { id: 'dismiss', label: 'Dismiss All' },
  ]);
  assert.deepEqual(reviewBatchActions('transfer_candidates', 2), [
    { id: 'primary', label: 'Confirm All' },
    { id: 'dismiss', label: 'Dismiss All' },
  ]);
  assert.deepEqual(reviewBatchActions('pending', 0), []);
});
