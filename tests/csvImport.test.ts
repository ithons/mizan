import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { buildCsvImportPreview, commitCsvImport } from '../server/src/services/csvImport';

function setupCsvImportDb(): Database.Database {
  const db = new Database(':memory:');

  db.exec(`
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      account_name TEXT NOT NULL,
      institution_name TEXT NOT NULL,
      current_balance REAL NOT NULL DEFAULT 0,
      is_manual INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT '2026-06-30T00:00:00.000Z'
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
      original_name TEXT NOT NULL DEFAULT '',
      category_id TEXT,
      pending INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      is_manual INTEGER NOT NULL DEFAULT 0,
      source_type TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    INSERT INTO accounts (id, account_name, institution_name, current_balance, is_manual)
    VALUES
      ('acct_cash', 'Cash', 'Manual', 10000, 1),
      ('acct_savings', 'Savings', 'Manual', 25000, 1);

    INSERT INTO categories (id, name)
    VALUES ('cat_food', 'Food');

    INSERT INTO transactions (
      id, account_id, date, amount, merchant_name, original_name, category_id, created_at, updated_at
    )
    VALUES (
      'txn_existing', 'acct_cash', '2026-06-30', -450, 'Coffee', 'Coffee', 'cat_food',
      '2026-06-30T00:00:00.000Z', '2026-06-30T00:00:00.000Z'
    ),
    (
      'txn_transfer_pair', 'acct_savings', '2026-06-29', 1200, 'Transfer', 'Transfer', NULL,
      '2026-06-29T00:00:00.000Z', '2026-06-29T00:00:00.000Z'
    );
  `);

  return db;
}

const mapping = {
  date: 'date',
  amount: 'amount',
  merchant: 'merchant',
  category: 'category',
  account: 'account',
  notes: 'notes',
  dateFormat: 'yyyy-MM-dd',
  amountNegate: false,
};

const rows = [
  {
    date: '2026-06-30',
    amount: '-4.50',
    merchant: 'Coffee',
    category: 'Food',
    account: 'Cash',
    notes: 'Morning',
  },
  {
    date: 'not-a-date',
    amount: 'abc',
    merchant: 'Bad Row',
    category: 'Food',
    account: 'Cash',
    notes: '',
  },
  {
    date: '2026-06-29',
    amount: '-12.00',
    merchant: 'Lunch',
    category: 'Unknown',
    account: 'Cash',
    notes: '',
  },
];

test('csv import preview validates rows and surfaces duplicate warnings without mutating', (t) => {
  const db = setupCsvImportDb();
  t.after(() => db.close());

  const preview = buildCsvImportPreview(db, { rows, mapping });

  assert.equal(preview.valid_count, 2);
  assert.equal(preview.invalid_count, 1);
  assert.equal(preview.duplicate_candidate_count, 1);
  assert.equal(preview.transfer_candidate_count, 1);
  assert.equal(preview.balance_delta, -16.5);
  assert.equal(preview.errors.length, 2);
  assert.equal(preview.warnings.length, 3);
  assert.equal(preview.rows[0]?.duplicate_candidate_count, 1);
  assert.equal(preview.rows[2]?.transfer_candidate_count, 1);
  assert.match(preview.rows[2]?.issues.at(-1)?.message ?? '', /may be a transfer/);

  const account = db.prepare('SELECT current_balance FROM accounts WHERE id = ?').get('acct_cash') as { current_balance: number };
  assert.equal(account.current_balance, 10000);
});

test('csv import commit imports valid rows and reports invalid row errors', (t) => {
  const db = setupCsvImportDb();
  t.after(() => db.close());

  const result = commitCsvImport(db, { rows, mapping }, '2026-06-30T12:00:00.000Z');

  assert.equal(result.imported, 2);
  assert.equal(result.errors.length, 2);
  assert.equal(result.balanceChanged, true);

  const transactionCount = db.prepare('SELECT COUNT(*) AS count FROM transactions').get() as { count: number };
  assert.equal(transactionCount.count, 4);

  const account = db.prepare('SELECT current_balance FROM accounts WHERE id = ?').get('acct_cash') as { current_balance: number };
  assert.equal(account.current_balance, 8350);
});

test('csv import duplicate detection compares exact cents, not a float epsilon', (t) => {
  const db = setupCsvImportDb();
  t.after(() => db.close());

  // 0.1 + 0.2 !== 0.3 under IEEE-754; stored directly to prove cents-rounding still matches it.
  db.prepare(`
    INSERT INTO transactions (id, account_id, date, amount, merchant_name, original_name, created_at, updated_at)
    VALUES ('txn_float_noise', 'acct_cash', '2026-06-28', ?, 'Noisy', 'Noisy', '2026-06-28T00:00:00.000Z', '2026-06-28T00:00:00.000Z')
  `).run(Math.round(-(0.1 + 0.2 + 19.5) * 100));

  const noisyRows = [
    { date: '2026-06-28', amount: '-19.80', merchant: 'Noisy', category: 'Food', account: 'Cash', notes: '' },
    { date: '2026-06-28', amount: '-19.79', merchant: 'Noisy', category: 'Food', account: 'Cash', notes: '' },
  ];

  const preview = buildCsvImportPreview(db, { rows: noisyRows, mapping });

  assert.equal(preview.rows[0]?.duplicate_candidate_count, 1, 'matches a float-noisy existing amount at the cent level');
  assert.equal(preview.rows[1]?.duplicate_candidate_count, 0, 'does not match an amount one cent away');
});
