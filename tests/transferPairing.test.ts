import test from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import {
  dismissTransferPair,
  getTransferCandidatePairs,
  refreshTransactionIntegrity,
} from '../server/src/services/transactionIntegrity';
import { autoCategorizeTransactions } from '../server/src/services/rules';
import { migratedTestDb, insertAccount, insertTransaction } from './helpers/schema';

/**
 * One sync's worth of the two stages that fight over `category_id`, in the order
 * `runFullSync` runs them: integrity detection first, categorization second.
 */
function syncCycle(db: Database.Database): void {
  refreshTransactionIntegrity(db);
  autoCategorizeTransactions(db);
}

interface RowState {
  id: string;
  category_id: string | null;
  category_source: string | null;
  transfer_pair_id: string | null;
  transfer_status: string;
  updated_at: string;
}

function rowStates(db: Database.Database): RowState[] {
  return db.prepare(`
    SELECT id, category_id, category_source, transfer_pair_id, transfer_status, updated_at
    FROM transactions
    ORDER BY id
  `).all() as RowState[];
}

function revisionCount(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM transaction_category_revisions').get() as { n: number }).n;
}

function categoryOf(db: Database.Database, id: string): { category_id: string | null; category_source: string | null } {
  return db.prepare('SELECT category_id, category_source FROM transactions WHERE id = ?')
    .get(id) as { category_id: string | null; category_source: string | null };
}

// The defect: eligibility used to require `category_id IS NULL OR <transfer class>`, and
// categorization runs on every sync. The first pass to give a leg any other category made it
// unpairable for good, so a transfer whose legs post on different days could never be found.
// `cat_inv_transfer` is the live shape of it: it is a transfer, but it hangs under Investments, so
// the old predicate excluded it.
test('a transfer leg categorized on an earlier sync can still pair when its other leg arrives', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const checking = insertAccount(db, { account_name: 'Chase Checking' });
  const brokerage = insertAccount(db, { account_name: 'Fidelity Individual', type: 'brokerage' });

  const outflow = insertTransaction(db, {
    account_id: checking,
    date: '2026-07-01',
    amount: -50000,
    merchant_name: 'Fidelity',
    original_name: 'Electronic Funds Transfer to Fidelity',
  });

  syncCycle(db);

  assert.deepEqual(categoryOf(db, outflow), {
    category_id: 'cat_inv_transfer',
    category_source: 'heuristic',
  });
  assert.equal(getTransferCandidatePairs(db).length, 0);

  const inflow = insertTransaction(db, {
    account_id: brokerage,
    date: '2026-07-03',
    amount: 50000,
    merchant_name: 'Fidelity',
    original_name: 'Electronic Funds Transfer Received',
  });

  syncCycle(db);

  const pairs = getTransferCandidatePairs(db);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].outflow_transaction_id, outflow);
  assert.equal(pairs[0].inflow_transaction_id, inflow);
  assert.deepEqual(categoryOf(db, outflow), { category_id: 'cat_xfer_out', category_source: 'heuristic' });
  assert.deepEqual(categoryOf(db, inflow), { category_id: 'cat_xfer_in', category_source: 'heuristic' });

  // The displaced category is recorded, not lost: that is what makes the pairing reversible.
  const displaced = db.prepare(`
    SELECT from_category_id, to_category_id
    FROM transaction_category_revisions
    WHERE transaction_id = ? AND to_category_id = 'cat_xfer_out'
  `).get(outflow) as { from_category_id: string | null; to_category_id: string } | undefined;
  assert.deepEqual(displaced, { from_category_id: 'cat_inv_transfer', to_category_id: 'cat_xfer_out' });
});

test('dismissing a pair gives each leg back the category the pairing displaced', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const checking = insertAccount(db, { account_name: 'Chase Checking' });
  const brokerage = insertAccount(db, { account_name: 'Fidelity Individual', type: 'brokerage' });

  const outflow = insertTransaction(db, {
    account_id: checking,
    date: '2026-07-01',
    amount: -50000,
    original_name: 'Electronic Funds Transfer to Fidelity',
  });
  syncCycle(db);
  const inflow = insertTransaction(db, {
    account_id: brokerage,
    date: '2026-07-03',
    amount: 50000,
    original_name: 'Electronic Funds Transfer Received',
  });
  syncCycle(db);

  const pair = getTransferCandidatePairs(db)[0];
  assert.equal(dismissTransferPair(db, pair.pair_id), 2);

  // Before this, dismissal NULLed the category, spending the owner's correction on erasing a
  // classification that was never in question.
  assert.deepEqual(categoryOf(db, outflow), { category_id: 'cat_inv_transfer', category_source: 'heuristic' });
  // The inflow really did arrive uncategorized: detection runs before categorization, so it was
  // paired in the same cycle it appeared. Restoring gives back what was there, not a better guess.
  assert.deepEqual(categoryOf(db, inflow), { category_id: null, category_source: null });

  const statuses = db.prepare(
    'SELECT transfer_status, transfer_pair_id FROM transactions ORDER BY id'
  ).all() as Array<{ transfer_status: string; transfer_pair_id: string | null }>;
  for (const row of statuses) {
    assert.equal(row.transfer_status, 'dismissed');
    assert.equal(row.transfer_pair_id, null);
  }

  // And it stays dismissed through the next sync rather than being re-proposed, with the released
  // inflow now free for the categorizer to place on its own merits.
  syncCycle(db);
  assert.equal(getTransferCandidatePairs(db).length, 0);
  assert.deepEqual(categoryOf(db, outflow), { category_id: 'cat_inv_transfer', category_source: 'heuristic' });
  assert.deepEqual(categoryOf(db, inflow), { category_id: 'cat_inv_transfer', category_source: 'heuristic' });
});

// HEALTHY CASE. The widened pool now contains every machine-categorized row, so the ordinary life of
// an ordinary transaction has to be provably untouched by it.
test('an ordinary categorized purchase keeps its category through repeated sync cycles', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const checking = insertAccount(db, { account_name: 'Chase Checking' });
  const groceries = insertTransaction(db, {
    account_id: checking,
    date: '2026-07-01',
    amount: -8432,
    merchant_name: 'Whole Foods Market',
    original_name: 'WHOLEFDS CAM 10259',
  });
  const coffee = insertTransaction(db, {
    account_id: checking,
    date: '2026-07-02',
    amount: -640,
    merchant_name: 'Starbucks',
    original_name: 'STARBUCKS STORE 04412',
  });

  syncCycle(db);
  const settled = rowStates(db);
  const settledRevisions = revisionCount(db);

  assert.deepEqual(categoryOf(db, groceries), {
    category_id: 'cat_food_groceries',
    category_source: 'heuristic',
  });
  assert.deepEqual(categoryOf(db, coffee), {
    category_id: 'cat_food_coffee',
    category_source: 'heuristic',
  });

  syncCycle(db);
  syncCycle(db);
  syncCycle(db);

  // Byte-for-byte, including updated_at: three more hours of syncing wrote nothing. The reset this
  // replaces NULLed a category on every pass and handed the row back to the categorizer to re-guess.
  assert.deepEqual(rowStates(db), settled);
  assert.equal(revisionCount(db), settledRevisions);
});

// HEALTHY CASE, from the live ledger. A $100.00 charge at ARTS STUDIOS on 2026-02-11 and a $100.00
// Fidelity Roth IRA contribution on 2026-02-09 satisfy every structural test the detector has:
// opposite signs, different accounts, inside the 3-day window, exactly one candidate each way. The
// naive widening pairs them, moving a real entertainment expense out of spending and relabelling a
// real retirement contribution as an internal transfer.
test('equal and opposite amounts in unrelated accounts are not a transfer', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const card = insertAccount(db, { account_name: 'Chase Sapphire', type: 'credit', is_liability: 1 });
  const roth = insertAccount(db, { account_name: 'Fidelity Roth IRA', type: 'brokerage' });

  insertTransaction(db, {
    account_id: card,
    date: '2026-02-11',
    amount: -10000,
    merchant_name: 'ARTS STUDIOS',
    original_name: 'ARTS STUDIOS',
    category_id: 'cat_ent',
    category_source: 'rule',
  });
  insertTransaction(db, {
    account_id: roth,
    date: '2026-02-09',
    amount: 10000,
    merchant_name: 'Fidelity contribution',
    original_name: 'Fidelity contribution',
    category_id: 'cat_inv_transfer',
    category_source: 'heuristic',
  });

  const result = refreshTransactionIntegrity(db);

  assert.equal(result.transfers.pairCount, 0);
  assert.equal(getTransferCandidatePairs(db).length, 0);
  assert.equal(revisionCount(db), 0);
});

// HEALTHY CASE. The pool is gated on provenance, so the one thing it must never reconsider is a
// category the owner set by hand, however transfer-shaped the row looks.
test('a hand-categorized row is never pulled into a pair', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const checking = insertAccount(db, { account_name: 'Chase Checking' });
  const savings = insertAccount(db, { account_name: 'Chase Savings', type: 'savings' });

  const outflow = insertTransaction(db, {
    account_id: checking,
    date: '2026-07-01',
    amount: -32000,
    original_name: 'Online Transfer to SAV ...1115',
    category_id: 'cat_gifts',
    category_source: 'human',
    manually_categorized: 1,
  });
  insertTransaction(db, {
    account_id: savings,
    date: '2026-07-01',
    amount: 32000,
    original_name: 'Online Transfer from CHK ...6391',
  });

  refreshTransactionIntegrity(db);

  assert.equal(getTransferCandidatePairs(db).length, 0);
  assert.deepEqual(categoryOf(db, outflow), { category_id: 'cat_gifts', category_source: 'human' });
});

// A confirmed pair is settled. It stays in the widened pool's SQL reach only through the
// transfer_status gate, so that gate is the whole guard and it is worth pinning here as well as in
// tests/transactionIntegrity.test.ts.
test('a confirmed pair is left alone and writes nothing on later syncs', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const checking = insertAccount(db, { account_name: 'Chase Checking' });
  const savings = insertAccount(db, { account_name: 'Chase Savings', type: 'savings' });

  insertTransaction(db, {
    account_id: checking,
    date: '2026-07-01',
    amount: -32000,
    original_name: 'Online Transfer to SAV ...1115',
  });
  insertTransaction(db, {
    account_id: savings,
    date: '2026-07-01',
    amount: 32000,
    original_name: 'Online Transfer from CHK ...6391',
  });

  syncCycle(db);
  const pair = getTransferCandidatePairs(db)[0];
  assert.ok(pair);

  db.prepare("UPDATE transactions SET transfer_status = 'confirmed' WHERE transfer_pair_id = ?")
    .run(pair.pair_id);

  const settled = rowStates(db);
  const settledRevisions = revisionCount(db);

  syncCycle(db);
  syncCycle(db);

  assert.deepEqual(rowStates(db), settled);
  assert.equal(revisionCount(db), settledRevisions);
});
