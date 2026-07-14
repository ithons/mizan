import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { buildTransactionsCsv, transactionCsvFilename } from '../server/src/services/csvExport';

function setupCsvExportDb(): Database.Database {
  const db = new Database(':memory:');

  db.exec(`
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      account_name TEXT NOT NULL,
      institution_name TEXT NOT NULL
    );

    CREATE TABLE categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );

    CREATE TABLE transactions (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      date TEXT NOT NULL,
      amount REAL NOT NULL,
      merchant_name TEXT,
      original_name TEXT NOT NULL,
      category_id TEXT,
      notes TEXT,
      created_at TEXT NOT NULL
    );

    INSERT INTO accounts (id, account_name, institution_name)
    VALUES
      ('acct_cash', 'Cash', 'Manual'),
      ('acct_card', 'Rewards Card', 'Test Bank');

    INSERT INTO categories (id, name)
    VALUES
      ('cat_food', 'Food'),
      ('cat_income', 'Income');

    INSERT INTO transactions (
      id, account_id, date, amount, merchant_name, original_name, category_id, notes, created_at
    )
    VALUES
      (
        'txn_1',
        'acct_cash',
        '2026-06-30',
        -450,
        'Comma, Cafe',
        'COMMA CAFE',
        'cat_food',
        'quote "inside"',
        '2026-06-30T00:00:00.000Z'
      ),
      (
        'txn_2',
        'acct_card',
        '2026-06-29',
        10000,
        NULL,
        'PAYROLL',
        'cat_income',
        NULL,
        '2026-06-29T00:00:00.000Z'
      );
  `);

  return db;
}

test('mizan csv export preserves existing columns and escapes values', (t) => {
  const db = setupCsvExportDb();
  t.after(() => db.close());

  const csv = buildTransactionsCsv(db);

  assert.match(csv, /^date,amount,merchant_name,original_name,category_name,account_name,institution_name,notes\n/);
  assert.match(csv, /2026-06-30,-4.5,"Comma, Cafe",COMMA CAFE,Food,Cash,Manual,"quote ""inside"""/);
  assert.match(csv, /2026-06-29,100,,PAYROLL,Income,Rewards Card,Test Bank,/);
});

test('monarch csv export uses portable transaction columns and filters rows', (t) => {
  const db = setupCsvExportDb();
  t.after(() => db.close());

  const csv = buildTransactionsCsv(db, {
    format: 'monarch',
    startDate: '2026-06-30',
    accountIds: ['acct_cash'],
  });

  assert.match(csv, /^Date,Merchant,Category,Account,Amount,Notes\n/);
  assert.match(csv, /2026-06-30,"Comma, Cafe",Food,Cash,-4.5,"quote ""inside"""/);
  assert.doesNotMatch(csv, /PAYROLL/);
  assert.doesNotMatch(csv, /institution_name/);
});

test('csv filenames identify mizan and monarch exports', () => {
  const exportedAt = new Date('2026-06-30T12:00:00.000Z');

  assert.equal(transactionCsvFilename('mizan', exportedAt), 'mizan-transactions-2026-06-30.csv');
  assert.equal(transactionCsvFilename('monarch', exportedAt), 'mizan-monarch-transactions-2026-06-30.csv');
});
