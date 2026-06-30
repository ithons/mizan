import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
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
  const db = new Database(':memory:');

  db.exec(`
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      account_name TEXT NOT NULL
    );

    CREATE TABLE categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT,
      parent_id TEXT,
      is_income INTEGER NOT NULL DEFAULT 0,
      is_investment INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE transactions (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      date TEXT NOT NULL,
      amount REAL NOT NULL,
      merchant_name TEXT,
      original_name TEXT NOT NULL DEFAULT '',
      category_id TEXT,
      pending INTEGER NOT NULL DEFAULT 0,
      duplicate_group_id TEXT,
      duplicate_status TEXT NOT NULL DEFAULT 'none',
      transfer_pair_id TEXT,
      transfer_status TEXT NOT NULL DEFAULT 'none',
      review_status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  db.prepare(`
    INSERT INTO accounts (id, account_name)
    VALUES
      ('checking', 'Checking'),
      ('savings', 'Savings')
  `).run();

  db.prepare(`
    INSERT INTO categories (id, name, color, parent_id, is_income, is_investment)
    VALUES
      ('cat_income_paycheck', 'Paycheck', '#4ecba3', NULL, 1, 0),
      ('cat_food', 'Food', '#e07070', NULL, 0, 0),
      ('cat_xfer', 'Transfers', '#6b6b7a', NULL, 0, 0),
      ('cat_xfer_out', 'Transfer Out', '#6b6b7a', 'cat_xfer', 0, 0),
      ('cat_xfer_in', 'Transfer In', '#6b6b7a', 'cat_xfer', 0, 0),
      ('cat_inv', 'Investments', '#5b8dee', NULL, 0, 1),
      ('cat_crypto', 'Crypto', '#d4a44c', NULL, 0, 0)
  `).run();

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
