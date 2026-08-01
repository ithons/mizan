import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migratedTestDb, insertAccount } from './helpers/schema';
import {
  confirmTransferPair,
  dismissDuplicateGroup,
  dismissTransferPair,
  getDuplicateCandidateGroups,
  getTransferCandidatePairs,
  refreshTransactionIntegrity,
} from '../server/src/services/transactionIntegrity';
import { getCashflowReport } from '../server/src/services/reporting';

function setupIntegrityDb(): Database.Database {
  const db = migratedTestDb();
  insertAccount(db, { id: 'checking', account_name: 'Checking' });
  insertAccount(db, { id: 'savings', account_name: 'Savings', type: 'savings' });

  const insert = db.prepare(`
    INSERT INTO transactions (
      id,
      account_id,
      date,
      amount,
      merchant_name,
      original_name,
      category_id,
      pending,
      created_at,
      updated_at
    )
    VALUES (@id, @account_id, @date, @amount, @merchant_name, @original_name, @category_id, 0, '2026-06-01', '2026-06-01')
  `);

  insert.run({
    id: 'paycheck',
    account_id: 'checking',
    date: '2026-06-01',
    amount: 1000,
    merchant_name: 'MIT Payroll',
    original_name: 'MIT Payroll',
    category_id: 'cat_income_paycheck',
  });
  insert.run({
    id: 'food',
    account_id: 'checking',
    date: '2026-06-02',
    amount: -25,
    merchant_name: 'Cafe',
    original_name: 'Cafe',
    category_id: 'cat_food',
  });
  insert.run({
    id: 'dup_1',
    account_id: 'checking',
    date: '2026-06-03',
    amount: -12.34,
    merchant_name: 'Bookshop',
    original_name: 'BOOKSHOP',
    category_id: null,
  });
  insert.run({
    id: 'dup_2',
    account_id: 'checking',
    date: '2026-06-03',
    amount: -12.34,
    merchant_name: 'Bookshop',
    original_name: 'BOOKSHOP',
    category_id: null,
  });
  insert.run({
    id: 'transfer_out',
    account_id: 'checking',
    date: '2026-06-04',
    amount: -300,
    merchant_name: 'Online Transfer',
    original_name: 'Transfer to Savings',
    category_id: null,
  });
  insert.run({
    id: 'transfer_in',
    account_id: 'savings',
    date: '2026-06-05',
    amount: 300,
    merchant_name: 'Online Transfer',
    original_name: 'Transfer from Checking',
    category_id: null,
  });

  return db;
}

test('transaction integrity detects duplicates and strict transfer pairs', (t) => {
  const db = setupIntegrityDb();
  t.after(() => db.close());

  const result = refreshTransactionIntegrity(db);

  assert.equal(result.duplicates.groupCount, 1);
  assert.equal(result.duplicates.transactionCount, 2);
  assert.equal(result.transfers.pairCount, 1);
  assert.equal(result.transfers.transactionCount, 2);

  const duplicateGroups = getDuplicateCandidateGroups(db);
  assert.equal(duplicateGroups.length, 1);
  assert.deepEqual(duplicateGroups[0].transaction_ids.sort(), ['dup_1', 'dup_2']);

  const transferPairs = getTransferCandidatePairs(db);
  assert.equal(transferPairs.length, 1);
  assert.equal(transferPairs[0].from_account_name, 'Checking');
  assert.equal(transferPairs[0].to_account_name, 'Savings');

  const transferRows = db.prepare(`
    SELECT id, category_id, transfer_status
    FROM transactions
    WHERE id IN ('transfer_out', 'transfer_in')
    ORDER BY id
  `).all() as Array<{ id: string; category_id: string; transfer_status: string }>;

  assert.deepEqual(transferRows, [
    { id: 'transfer_in', category_id: 'cat_xfer_in', transfer_status: 'candidate' },
    { id: 'transfer_out', category_id: 'cat_xfer_out', transfer_status: 'candidate' },
  ]);
});

test('candidate transfer pairs are excluded from cashflow reports', (t) => {
  const db = setupIntegrityDb();
  t.after(() => db.close());

  refreshTransactionIntegrity(db);
  const report = getCashflowReport(db, {
    startDate: '2026-06-01',
    endDate: '2026-06-30',
  });

  assert.deepEqual(report.months, [
    {
      month: '2026-06',
      income: 1000,
      expenses: 49.68,
      net: 950.32,
    },
  ]);
});

test('duplicate groups and transfer pairs can be dismissed or confirmed', (t) => {
  const db = setupIntegrityDb();
  t.after(() => db.close());

  refreshTransactionIntegrity(db);
  const duplicateGroup = getDuplicateCandidateGroups(db)[0];
  const transferPair = getTransferCandidatePairs(db)[0];

  assert.equal(dismissDuplicateGroup(db, duplicateGroup.group_id), 2);
  assert.equal(getDuplicateCandidateGroups(db).length, 0);

  assert.equal(confirmTransferPair(db, transferPair.pair_id), 2);
  assert.equal(getTransferCandidatePairs(db).length, 0);

  const confirmed = db.prepare(`
    SELECT COUNT(*) AS count
    FROM transactions
    WHERE transfer_status = 'confirmed'
      AND review_status = 'reviewed'
  `).get() as { count: number };
  assert.equal(confirmed.count, 2);
});

test('dismissed transfer pairs are not immediately rediscovered', (t) => {
  const db = setupIntegrityDb();
  t.after(() => db.close());

  refreshTransactionIntegrity(db);
  const transferPair = getTransferCandidatePairs(db)[0];

  assert.equal(dismissTransferPair(db, transferPair.pair_id), 2);
  assert.equal(getTransferCandidatePairs(db).length, 0);

  refreshTransactionIntegrity(db);
  assert.equal(getTransferCandidatePairs(db).length, 0);
});

test('confirmed transfer pairs survive a re-sync and are not re-flagged for review', (t) => {
  const db = setupIntegrityDb();
  t.after(() => db.close());

  refreshTransactionIntegrity(db);
  const transferPair = getTransferCandidatePairs(db)[0];

  assert.equal(confirmTransferPair(db, transferPair.pair_id), 2);
  assert.equal(getTransferCandidatePairs(db).length, 0);

  // Regression: before the fix, transferCandidateRows() excluded only 'dismissed',
  // so a subsequent integrity recompute re-selected the confirmed pair and rewrote
  // its transfer_status back to 'candidate', dumping it into the review queue again.
  refreshTransactionIntegrity(db);

  assert.equal(getTransferCandidatePairs(db).length, 0);

  const rows = db.prepare(`
    SELECT transfer_status, review_status
    FROM transactions
    WHERE id IN ('transfer_out', 'transfer_in')
  `).all() as Array<{ transfer_status: string; review_status: string }>;

  for (const row of rows) {
    assert.equal(row.transfer_status, 'confirmed');
    assert.equal(row.review_status, 'reviewed');
  }
});

// Migration 033 rewrote every consolidated Coinbase row's merchant to "Coinbase", so a $25
// POL buy and a $25 SOL buy on the same day matched on account+date+amount+merchant. Only
// the raw description separates them, so it belongs in the duplicate key.
test('same-day, same-amount buys of different assets are not duplicates', (t) => {
  const db = setupIntegrityDb();
  t.after(() => db.close());

  const insert = db.prepare(`
    INSERT INTO transactions (id, account_id, date, amount, merchant_name, original_name,
                              category_id, pending, created_at, updated_at)
    VALUES (?, 'checking', '2026-02-01', -2500, 'Coinbase', ?, 'cat_crypto', 0, '2026-06-01', '2026-06-01')
  `);
  insert.run('cb-pol', 'Buy POL');
  insert.run('cb-sol', 'Buy SOL');

  refreshTransactionIntegrity(db);

  const flagged = db.prepare(
    "SELECT id FROM transactions WHERE duplicate_status = 'candidate' AND id LIKE 'cb-%'"
  ).all();
  assert.deepEqual(flagged, []);
});

/**
 * A detector that re-reports the same finding every hour has turned a queue into wallpaper.
 *
 * `groupCount` and `pairCount` are the STANDING counts: every unresolved candidate, however old.
 * `syncManager` wrote a `sync_changes` row of `change_type = 'detected'` from them, so an
 * unresolved candidate produced an identical "3 transfer pair(s) need review" every hourly sync,
 * forever, and the only way to make it stop was to resolve the candidate. Nothing happened on those
 * runs, and a run in which nothing happened has to be silent.
 */

test('a second run over an unchanged ledger finds nothing new, while the standing count holds', (t) => {
  const db = setupIntegrityDb();
  t.after(() => db.close());

  const first = refreshTransactionIntegrity(db);
  assert.equal(first.duplicates.newGroupCount, 1, 'the first run genuinely found them');
  assert.equal(first.transfers.newPairCount, 1);

  // HEALTHY: nothing changed, so nothing is reported as an event.
  const second = refreshTransactionIntegrity(db);
  assert.equal(second.duplicates.newGroupCount, 0);
  assert.equal(second.transfers.newPairCount, 0);
  // The queue has not emptied, and the sync_runs columns that describe state still say so.
  assert.equal(second.duplicates.groupCount, 1);
  assert.equal(second.transfers.pairCount, 1);

  // Ten runs later it is still silent. This is the shape of the standing finding.
  for (let run = 0; run < 10; run++) {
    const later = refreshTransactionIntegrity(db);
    assert.equal(later.duplicates.newGroupCount, 0);
    assert.equal(later.transfers.newPairCount, 0);
  }
});

test('a genuinely new candidate is reported on the run that finds it, and only that run', (t) => {
  const db = setupIntegrityDb();
  t.after(() => db.close());

  refreshTransactionIntegrity(db);
  assert.equal(refreshTransactionIntegrity(db).duplicates.newGroupCount, 0);

  const insert = db.prepare(`
    INSERT INTO transactions (id, account_id, date, amount, merchant_name, original_name,
      category_id, pending, created_at, updated_at)
    VALUES (?, 'checking', '2026-06-09', -4200, 'Hardware Store', 'HARDWARE STORE', NULL, 0, '2026-06-09', '2026-06-09')
  `);
  insert.run('dup_3');
  insert.run('dup_4');

  const found = refreshTransactionIntegrity(db);
  assert.equal(found.duplicates.newGroupCount, 1, 'a new group is an event');
  assert.equal(found.duplicates.groupCount, 2);

  const quiet = refreshTransactionIntegrity(db);
  assert.equal(quiet.duplicates.newGroupCount, 0, 'and it is only an event once');
  assert.equal(quiet.duplicates.groupCount, 2);
});

/**
 * AN AMENDMENT TO A CANDIDATE IS NOT A NEW CANDIDATE.
 *
 * `duplicate_group_id` is a hash of the group KEY, and the key holds `date`, `amount`, `pending`,
 * the normalized merchant and the normalized `original_name`. Every one of those is a field
 * `upsertSimplefinTransaction` overwrites from the provider each sync. Deciding newness on that id
 * meant a pending duplicate pair simply posting, or a routine merchant rewrite, re-announced a
 * candidate the owner had already been shown: measured on this fixture before the fix, `UPDATE
 * transactions SET pending = 0` moved the id dup_bac414ef9eaf8e48 -> dup_9f6f1c4f3f63f44a and
 * returned newGroupCount 1, and a merchant rename returned 1 again.
 */
test('HEALTHY: a pending duplicate pair posting is not a new finding', (t) => {
  const db = setupIntegrityDb();
  t.after(() => db.close());

  db.prepare(`UPDATE transactions SET pending = 1 WHERE id IN ('dup_1', 'dup_2')`).run();
  const first = refreshTransactionIntegrity(db);
  assert.equal(first.duplicates.newGroupCount, 1, 'found once while both legs were pending');
  assert.equal(first.duplicates.newTransactionCount, 2);

  // The ordinary event: the provider posts both legs of the pair in one feed.
  db.prepare(`UPDATE transactions SET pending = 0 WHERE id IN ('dup_1', 'dup_2')`).run();
  const posted = refreshTransactionIntegrity(db);
  assert.equal(posted.duplicates.groupCount, 1, 'still the same standing candidate');
  assert.equal(posted.duplicates.newGroupCount, 0, 'and posting is not a finding');
  assert.equal(posted.duplicates.newTransactionCount, 0);

  // The other amendment the provider performs every sync: a merchant-name rewrite.
  db.prepare(`UPDATE transactions SET merchant_name = 'Bookshop Ltd' WHERE id IN ('dup_1', 'dup_2')`).run();
  const renamed = refreshTransactionIntegrity(db);
  assert.equal(renamed.duplicates.groupCount, 1);
  assert.equal(renamed.duplicates.newGroupCount, 0, 'nor is a rename');
  assert.equal(renamed.duplicates.newTransactionCount, 0);
});

test('a third copy joining an established group is reported, once', (t) => {
  const db = setupIntegrityDb();
  t.after(() => db.close());

  refreshTransactionIntegrity(db);
  assert.equal(refreshTransactionIntegrity(db).duplicates.newTransactionCount, 0);

  // Same key as dup_1/dup_2, so the group id does not move at all. The row is still one the owner
  // has never been shown, and reporting on the group id alone said nothing about it.
  db.prepare(`
    INSERT INTO transactions (id, account_id, date, amount, merchant_name, original_name,
      category_id, pending, created_at, updated_at)
    VALUES ('dup_3', 'checking', '2026-06-03', -12.34, 'Bookshop', 'BOOKSHOP', NULL, 0, '2026-06-03', '2026-06-03')
  `).run();

  const found = refreshTransactionIntegrity(db);
  assert.equal(found.duplicates.groupCount, 1, 'the same group, one member wider');
  assert.equal(found.duplicates.transactionCount, 3);
  assert.equal(found.duplicates.newTransactionCount, 1, 'the copy that arrived is the finding');
  assert.equal(found.duplicates.newGroupCount, 1, 'and the group holding it is where to look');

  const quiet = refreshTransactionIntegrity(db);
  assert.equal(quiet.duplicates.newTransactionCount, 0, 'and only on the run that found it');
  assert.equal(quiet.duplicates.newGroupCount, 0);
});

test('resolving a candidate leaves the detector silent rather than re-finding it', (t) => {
  const db = setupIntegrityDb();
  t.after(() => db.close());

  refreshTransactionIntegrity(db);
  const group = getDuplicateCandidateGroups(db)[0];
  dismissDuplicateGroup(db, group.group_id);
  const pair = getTransferCandidatePairs(db)[0];
  confirmTransferPair(db, pair.pair_id);

  const after = refreshTransactionIntegrity(db);
  assert.equal(after.duplicates.newGroupCount, 0);
  assert.equal(after.transfers.newPairCount, 0);
  assert.equal(after.duplicates.groupCount, 0);
  assert.equal(after.transfers.pairCount, 0);
});
