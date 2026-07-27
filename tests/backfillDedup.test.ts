import test from 'node:test';
import assert from 'node:assert/strict';
import { duplicateIdsToDelete } from '../scripts/backfill/dedup';

const base = { account_id: 'a1', is_manual: 0, original_name: '', created_at: '2026-07-01T00:00:00Z' };

test('exact duplicates collapse to one survivor (earliest created kept)', () => {
  const rows = [
    { ...base, id: 'keep', date: '2024-01-05', amount: -1299, merchant_name: 'Netflix', created_at: '2026-07-01T00:00:00Z' },
    { ...base, id: 'dup', date: '2024-01-05', amount: -1299, merchant_name: 'Netflix', created_at: '2026-07-02T00:00:00Z' },
  ];
  assert.deepEqual(duplicateIdsToDelete(rows), ['dup']);
});

test('same amount/date but distinct merchants are NOT duplicates', () => {
  const rows = [
    { ...base, id: 'a', date: '2024-01-05', amount: -500, merchant_name: 'Store 1234' },
    { ...base, id: 'b', date: '2024-01-05', amount: -500, merchant_name: 'Store 5678' },
  ];
  assert.deepEqual(duplicateIdsToDelete(rows), []);
});

test('merchant normalization matches across punctuation/case; original_name backs a null merchant', () => {
  const rows = [
    { ...base, id: 'x', date: '2024-02-01', amount: -800, merchant_name: null, original_name: 'WHOLE FOODS', created_at: '2026-07-01T00:00:00Z' },
    { ...base, id: 'y', date: '2024-02-01', amount: -800, merchant_name: 'whole-foods', original_name: '', created_at: '2026-07-02T00:00:00Z' },
  ];
  assert.deepEqual(duplicateIdsToDelete(rows), ['y']);
});

test('different accounts on the same charge stay separate', () => {
  const rows = [
    { ...base, id: 'a', account_id: 'a1', date: '2024-03-01', amount: -900, merchant_name: 'Rent' },
    { ...base, id: 'b', account_id: 'a2', date: '2024-03-01', amount: -900, merchant_name: 'Rent' },
  ];
  assert.deepEqual(duplicateIdsToDelete(rows), []);
});

// The regression that would have deleted 68 real transactions: identical repeat charges
// (transit taps) inside ONE source file are what that file reported, not duplication.
test('identical repeat charges from a single import run are all kept', () => {
  const rows = ['t1', 't2', 't3', 't4'].map((id) => ({
    ...base, id, date: '2026-01-08', amount: -240, merchant_name: 'MBTA-550000309660',
    created_at: '2026-07-24T02:15:00Z',
  }));
  assert.deepEqual(duplicateIdsToDelete(rows), []);
});

test('an overlapping second file collapses to the run that reported the most rows', () => {
  const rows = [
    // Statement A saw three taps that day; the overlapping statement B re-reported two.
    { ...base, id: 'a1', date: '2026-01-08', amount: -240, merchant_name: 'MBTA', created_at: '2026-07-24T02:15:00Z' },
    { ...base, id: 'a2', date: '2026-01-08', amount: -240, merchant_name: 'MBTA', created_at: '2026-07-24T02:15:00Z' },
    { ...base, id: 'a3', date: '2026-01-08', amount: -240, merchant_name: 'MBTA', created_at: '2026-07-24T02:15:00Z' },
    { ...base, id: 'b1', date: '2026-01-08', amount: -240, merchant_name: 'MBTA', created_at: '2026-07-24T02:29:00Z' },
    { ...base, id: 'b2', date: '2026-01-08', amount: -240, merchant_name: 'MBTA', created_at: '2026-07-24T02:29:00Z' },
  ];
  assert.deepEqual(duplicateIdsToDelete(rows), ['b1', 'b2']);
});

test('when the later run reported more, it is the one that survives', () => {
  const rows = [
    { ...base, id: 'early', date: '2026-02-01', amount: -500, merchant_name: 'Cafe', created_at: '2026-07-24T02:15:00Z' },
    { ...base, id: 'late1', date: '2026-02-01', amount: -500, merchant_name: 'Cafe', created_at: '2026-07-24T02:29:00Z' },
    { ...base, id: 'late2', date: '2026-02-01', amount: -500, merchant_name: 'Cafe', created_at: '2026-07-24T02:29:00Z' },
  ];
  assert.deepEqual(duplicateIdsToDelete(rows), ['early']);
});
