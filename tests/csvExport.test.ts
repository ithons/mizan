import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migratedTestDb, insertAccount } from './helpers/schema';
import { buildTransactionsCsv, transactionCsvFilename } from '../server/src/services/csvExport';

// Category names come from the seeded taxonomy the migrations produce, so the strings the export
// writes are the strings production writes. The hand-written schema this replaced also declared
// `amount REAL`, where production has been INTEGER cents since migration 022.
function setupCsvExportDb(): Database.Database {
  const db = migratedTestDb();
  insertAccount(db, { id: 'acct_cash', account_name: 'Cash', institution_name: 'Manual' });
  insertAccount(db, { id: 'acct_card', account_name: 'Rewards Card', institution_name: 'Test Bank' });

  db.prepare(`
    INSERT INTO transactions
      (id, account_id, date, amount, merchant_name, original_name, category_id, notes, created_at, updated_at)
    VALUES
      ('txn_1','acct_cash','2026-06-30',-450,'Comma, Cafe','COMMA CAFE','cat_food','quote "inside"',
       '2026-06-30T00:00:00.000Z','2026-06-30T00:00:00.000Z'),
      ('txn_2','acct_card','2026-06-29',10000,NULL,'PAYROLL','cat_income_paycheck',NULL,
       '2026-06-29T00:00:00.000Z','2026-06-29T00:00:00.000Z')
  `).run();

  return db;
}

test('mizan csv export preserves existing columns and escapes values', (t) => {
  const db = setupCsvExportDb();
  t.after(() => db.close());

  const csv = buildTransactionsCsv(db);

  assert.match(csv, /^date,amount,merchant_name,original_name,category_name,account_name,institution_name,notes\n/);
  assert.match(csv, /2026-06-30,-4.5,"Comma, Cafe",COMMA CAFE,Food & Drink,Cash,Manual,"quote ""inside"""/);
  assert.match(csv, /2026-06-29,100,,PAYROLL,Paycheck,Rewards Card,Test Bank,/);
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
  assert.match(csv, /2026-06-30,"Comma, Cafe",Food & Drink,Cash,-4.5,"quote ""inside"""/);
  assert.doesNotMatch(csv, /PAYROLL/);
  assert.doesNotMatch(csv, /institution_name/);
});

test('csv filenames identify mizan and monarch exports', () => {
  const exportedAt = new Date('2026-06-30T12:00:00.000Z');

  assert.equal(transactionCsvFilename('mizan', exportedAt), 'mizan-transactions-2026-06-30.csv');
  assert.equal(transactionCsvFilename('monarch', exportedAt), 'mizan-monarch-transactions-2026-06-30.csv');
});
