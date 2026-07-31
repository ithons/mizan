import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  AdvisorDraftAction,
  Category,
  DuplicateCandidateGroup,
  Transaction,
  TransferCandidatePair,
} from '../shared/types';
import {
  createLedgerRowActions,
  sameLedgerRow,
  type LedgerRowHandlers,
  type LedgerRowProps,
} from '../client/src/views/ledger/spine';

/**
 * What a keystroke costs the ledger, counted rather than asserted in a comment.
 *
 * `LedgerRow` is `memo(LedgerRowInner, sameLedgerRow)`, and the comparison is written out in
 * spine.ts precisely so this file can drive it. The claim it carries is that moving the keyboard
 * cursor one row re-renders two rows and not the whole list, and that claim was false for the
 * whole life of the screen: react-query 5's `useMutation` returns `{ ...result, mutate }`, a fresh
 * object literal on every render, so the six `useCallback` handlers built on those objects changed
 * identity every render and the comparison failed on every row.
 *
 * 2,588 is the whole live ledger, reachable in one view with the range set to all time:
 *   SELECT COUNT(*) FROM transactions;  -> 2588
 * on a fresh copy of .mizan/mizan.db at migration 053_drop_budget_groups.sql, 2026-07-31.
 */

const LIVE_LEDGER_ROWS = 2588;

function txn(id: string): Transaction {
  return {
    id,
    account_id: 'a1',
    date: '2026-07-20',
    amount: -1000,
    original_name: 'TEST',
    pending: false,
    is_manual: false,
    source_type: 'simplefin',
    duplicate_status: 'none',
    transfer_status: 'none',
    review_status: 'open',
    created_at: '2026-07-20T00:00:00.000Z',
    updated_at: '2026-07-20T00:00:00.000Z',
  };
}

const noopHandlers: LedgerRowHandlers = {
  toggleSelect: () => {},
  open: () => {},
  accept: () => {},
  override: () => {},
  dismissDraft: () => {},
  keepCopy: () => {},
  keepBoth: () => {},
  confirmTransfer: () => {},
  rejectTransfer: () => {},
  setAside: () => {},
  bringBack: () => {},
};

/** Everything the parent hands every row, built once because `useMemo`/`useState` build it once. */
interface Shared {
  categories: Category[];
  duplicateGroups: Map<string, DuplicateCandidateGroup>;
  transferPairs: Map<string, TransferCandidatePair>;
  actions: LedgerRowHandlers;
}

function shared(): Shared {
  return {
    categories: [],
    duplicateGroups: new Map(),
    transferPairs: new Map(),
    actions: createLedgerRowActions({ current: noopHandlers }),
  };
}

/** The props the ledger builds for every loaded row on one render, in render order. */
function renderRows(rows: Transaction[], s: Shared, cursorIndex: number): LedgerRowProps[] {
  return rows.map((transaction, i) => ({
    transaction,
    selected: false,
    draft: null,
    isCursor: i === cursorIndex,
    categories: s.categories,
    busy: false,
    refusal: null,
    duplicateGroups: s.duplicateGroups,
    transferPairs: s.transferPairs,
    actions: s.actions,
  }));
}

function changedRows(prev: LedgerRowProps[], next: LedgerRowProps[]): number {
  let changed = 0;
  for (let i = 0; i < prev.length; i += 1) if (!sameLedgerRow(prev[i], next[i])) changed += 1;
  return changed;
}

const rows = Array.from({ length: LIVE_LEDGER_ROWS }, (_, i) => txn(`t${i}`));

test('a cursor move re-renders two rows out of 2,588', () => {
  const s = shared();
  // The row the cursor left and the row it arrived at. Nothing else about the screen changed.
  assert.equal(changedRows(renderRows(rows, s, 0), renderRows(rows, s, 1)), 2);
});

test('a parent render that changes nothing re-renders nothing', () => {
  const s = shared();
  assert.equal(changedRows(renderRows(rows, s, 0), renderRows(rows, s, 0)), 0);
});

test('handlers rebuilt per render would re-render all 2,588, which is what used to happen', () => {
  // The regression this file exists for. Six props were `useCallback`s over react-query mutation
  // objects; a mutation object is a fresh literal each render, so each callback was too, so every
  // row failed the comparison on every keystroke. One fresh reference is enough to do it.
  const before = renderRows(rows, shared(), 0);
  const after = renderRows(rows, shared(), 1);
  assert.equal(changedRows(before, after), LIVE_LEDGER_ROWS);
});

test('the comparison notices each prop, not just the convenient ones', () => {
  const s = shared();
  const [base] = renderRows([txn('t1')], s, -1);
  assert.equal(sameLedgerRow(base, { ...base }), true);

  const draft = { id: 'd1' } as AdvisorDraftAction;
  assert.equal(sameLedgerRow(base, { ...base, transaction: txn('t1') }), false);
  assert.equal(sameLedgerRow(base, { ...base, selected: true }), false);
  assert.equal(sameLedgerRow(base, { ...base, draft }), false);
  assert.equal(sameLedgerRow(base, { ...base, isCursor: true }), false);
  assert.equal(sameLedgerRow(base, { ...base, categories: [] }), false);
  assert.equal(sameLedgerRow(base, { ...base, busy: true }), false);
  assert.equal(sameLedgerRow(base, { ...base, refusal: 'guard said no' }), false);
  assert.equal(sameLedgerRow(base, { ...base, duplicateGroups: new Map() }), false);
  assert.equal(sameLedgerRow(base, { ...base, transferPairs: new Map() }), false);
  assert.equal(sameLedgerRow(base, { ...base, actions: { ...s.actions } }), false);
});

test('a pending write is the one thing that still costs the whole list', () => {
  // Said out loud rather than left as a surprise: `busy` disables every row's action buttons, so
  // it is a real prop on every row and it flips twice per accepted draft. That is two passes at
  // click speed, which is the cost the design accepts; the keystroke path is the one that had to
  // be cheap.
  const s = shared();
  const idle = renderRows(rows, s, 0);
  const working = idle.map((p) => ({ ...p, busy: true }));
  assert.equal(changedRows(idle, working), LIVE_LEDGER_ROWS);
});
