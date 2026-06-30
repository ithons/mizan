import test from 'node:test';
import assert from 'node:assert/strict';
import { getUncategorizedBatchGroups } from '../client/src/lib/reviewGrouping';
import type { Transaction } from '../shared/types';

function transaction(overrides: Partial<Transaction>): Transaction {
  return {
    id: overrides.id ?? 'txn',
    account_id: overrides.account_id ?? 'acct_checking',
    date: overrides.date ?? '2026-06-30',
    amount: overrides.amount ?? -10,
    merchant_name: overrides.merchant_name ?? 'Target',
    original_name: overrides.original_name ?? 'TARGET',
    category_id: overrides.category_id ?? null,
    pending: overrides.pending ?? false,
    is_manual: overrides.is_manual ?? false,
    source_type: overrides.source_type ?? 'manual',
    duplicate_status: overrides.duplicate_status ?? 'none',
    transfer_status: overrides.transfer_status ?? 'none',
    review_status: overrides.review_status ?? 'open',
    created_at: overrides.created_at ?? '2026-06-30T00:00:00.000Z',
    updated_at: overrides.updated_at ?? '2026-06-30T00:00:00.000Z',
    account_name: overrides.account_name ?? 'Checking',
  };
}

test('uncategorized batch groups combine repeated merchants within an account', () => {
  const groups = getUncategorizedBatchGroups([
    transaction({ id: 'target_1', amount: -10, date: '2026-06-01' }),
    transaction({ id: 'target_2', amount: -15, date: '2026-06-03', merchant_name: ' target ' }),
    transaction({ id: 'other_1', amount: -20, merchant_name: 'Other' }),
  ]);

  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0], {
    key: 'target:acct_checking',
    merchant_name: 'Target',
    account_name: 'Checking',
    transaction_ids: ['target_1', 'target_2'],
    count: 2,
    total_amount: -25,
    latest_date: '2026-06-03',
  });
});

test('uncategorized batch groups keep accounts separate and sort by count', () => {
  const groups = getUncategorizedBatchGroups([
    transaction({ id: 'coffee_1', merchant_name: 'Coffee', account_id: 'acct_checking' }),
    transaction({ id: 'coffee_2', merchant_name: 'Coffee', account_id: 'acct_credit', account_name: 'Credit' }),
    transaction({ id: 'coffee_3', merchant_name: 'Coffee', account_id: 'acct_credit', account_name: 'Credit' }),
    transaction({ id: 'target_1', merchant_name: 'Target', account_id: 'acct_checking' }),
    transaction({ id: 'target_2', merchant_name: 'Target', account_id: 'acct_checking' }),
    transaction({ id: 'target_3', merchant_name: 'Target', account_id: 'acct_checking' }),
  ]);

  assert.deepEqual(groups.map((group) => [group.merchant_name, group.account_name, group.count]), [
    ['Target', 'Checking', 3],
    ['Coffee', 'Credit', 2],
  ]);
});
