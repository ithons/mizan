import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { format } from 'date-fns';
import { runAdvisorTool } from '../server/src/services/advisorChatTools';
import { getCashflowReport, getSpendingReport } from '../server/src/services/reporting';
import { formatMoney } from '../server/src/services/aiContext';

// The advisor's aggregate tools used to run their own SQL, and drifted from the Reports page:
// they counted transfer candidates, confirmed duplicates, and pending rows that Reports
// excludes, and skipped the investment/crypto root exclusion entirely. Asking the advisor and
// reading the Reports page produced different numbers for the same window. These tests pin the
// two together, so the next person who adds an aggregate has to add it to the shared service.

const RANGE = { start_date: '2026-06-01', end_date: '2026-06-30' };

function setupDb(): Database.Database {
  const db = new Database(':memory:');

  db.exec(`
    CREATE TABLE categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      icon TEXT,
      color TEXT,
      parent_id TEXT,
      is_income INTEGER NOT NULL DEFAULT 0,
      is_investment INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      account_name TEXT NOT NULL,
      institution_name TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT 'checking',
      is_liability INTEGER NOT NULL DEFAULT 0,
      is_hidden INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE transactions (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      date TEXT NOT NULL,
      amount INTEGER NOT NULL,
      merchant_name TEXT,
      original_name TEXT NOT NULL DEFAULT '',
      category_id TEXT,
      notes TEXT,
      pending INTEGER NOT NULL DEFAULT 0,
      recurring_id TEXT,
      transfer_status TEXT NOT NULL DEFAULT 'none',
      duplicate_status TEXT NOT NULL DEFAULT 'none',
      review_status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL DEFAULT '2026-06-30T00:00:00.000Z',
      updated_at TEXT NOT NULL DEFAULT '2026-06-30T00:00:00.000Z'
    );

    CREATE TABLE budgets (
      id TEXT PRIMARY KEY,
      category_id TEXT NOT NULL,
      amount INTEGER NOT NULL,
      period TEXT NOT NULL DEFAULT 'monthly',
      rollover INTEGER NOT NULL DEFAULT 0,
      rollover_balance INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT '2026-06-01T00:00:00.000Z',
      updated_at TEXT NOT NULL DEFAULT '2026-06-01T00:00:00.000Z'
    );

    CREATE TABLE budget_rollover_ledger (
      id TEXT PRIMARY KEY,
      budget_id TEXT NOT NULL,
      month TEXT NOT NULL,
      starting_rollover INTEGER NOT NULL,
      budget_amount INTEGER NOT NULL,
      actual_spend INTEGER NOT NULL,
      ending_rollover INTEGER NOT NULL,
      calculated_at TEXT NOT NULL
    );

    CREATE TABLE recurring_patterns (
      id TEXT PRIMARY KEY,
      merchant_name TEXT NOT NULL,
      category_id TEXT,
      average_amount INTEGER NOT NULL,
      amount_variance REAL NOT NULL DEFAULT 0,
      frequency TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      next_expected TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      is_confirmed INTEGER NOT NULL DEFAULT 0,
      transaction_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT '2026-06-01T00:00:00.000Z',
      updated_at TEXT NOT NULL DEFAULT '2026-06-01T00:00:00.000Z'
    );

    CREATE TABLE recurring_occurrence_adjustments (
      id TEXT PRIMARY KEY,
      recurring_id TEXT NOT NULL,
      original_date TEXT NOT NULL,
      action TEXT NOT NULL,
      adjusted_date TEXT,
      adjusted_amount INTEGER,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT '2026-06-01T00:00:00.000Z',
      updated_at TEXT NOT NULL DEFAULT '2026-06-01T00:00:00.000Z'
    );
  `);

  db.prepare('INSERT INTO accounts (id, account_name) VALUES (?, ?)').run('acct', 'Checking');

  const category = db.prepare(
    'INSERT INTO categories (id, name, parent_id, is_income, is_investment) VALUES (?, ?, ?, ?, ?)'
  );
  category.run('cat_food', 'Food & Drink', null, 0, 0);
  category.run('cat_food_restaurants', 'Restaurants', 'cat_food', 0, 0);
  category.run('cat_shop', 'Shopping', null, 0, 0);
  category.run('cat_shop_household', 'Household & Everyday', 'cat_shop', 0, 0);
  category.run('cat_xfer', 'Transfers', null, 0, 0);
  category.run('cat_xfer_out', 'Transfer Out', 'cat_xfer', 0, 0);
  category.run('cat_inv', 'Investments', null, 0, 1);
  category.run('cat_inv_buy', 'Buy', 'cat_inv', 0, 1);
  category.run('cat_crypto', 'Crypto', null, 0, 0);
  category.run('cat_crypto_buy', 'Crypto Buy', 'cat_crypto', 0, 0);
  category.run('cat_income_paycheck', 'Paycheck', null, 1, 0);

  // Amounts are integer cents. Only the two rows marked "counts" are real June spending.
  const txn = db.prepare(`
    INSERT INTO transactions
      (id, account_id, date, amount, merchant_name, original_name, category_id, pending, transfer_status, duplicate_status)
    VALUES (?, 'acct', ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  txn.run('t1', '2026-06-04', -5000, 'Cafe', 'CAFE', 'cat_food_restaurants', 0, 'none', 'none');       // counts
  txn.run('t2', '2026-06-05', -2500, 'Target', 'TARGET', 'cat_shop_household', 0, 'none', 'none');     // counts
  txn.run('t3', '2026-06-06', -20000, 'Move', 'MOVE', 'cat_xfer_out', 0, 'confirmed', 'none');         // transfer
  txn.run('t4', '2026-06-07', -1500, 'Cafe', 'CAFE', 'cat_food_restaurants', 0, 'candidate', 'none');  // transfer candidate
  txn.run('t5', '2026-06-08', -3000, 'Cafe', 'CAFE', 'cat_food_restaurants', 0, 'none', 'confirmed');  // resolved duplicate
  txn.run('t6', '2026-06-09', -7500, 'Cafe', 'CAFE', 'cat_food_restaurants', 1, 'none', 'none');       // pending
  txn.run('t7', '2026-06-10', -100000, 'Coinbase', 'COINBASE', 'cat_crypto_buy', 0, 'none', 'none');   // crypto
  txn.run('t8', '2026-06-11', -50000, 'Fidelity', 'FIDELITY', 'cat_inv_buy', 0, 'none', 'none');       // investment
  txn.run('t9', '2026-06-15', 400000, 'Payroll', 'PAYROLL', 'cat_income_paycheck', 0, 'none', 'none'); // income

  return db;
}

test('spending_by_category agrees with the Reports spending report to the cent', () => {
  const db = setupDb();
  const tool = runAdvisorTool(db, 'spending_by_category', RANGE) as {
    total: number;
    categories: Array<{ category: string; spent: number }>;
  };
  const report = getSpendingReport(db, {
    startDate: RANGE.start_date,
    endDate: RANGE.end_date,
    parentOnly: true,
  });

  assert.equal(tool.total, report.total / 100);
  assert.deepEqual(
    tool.categories.map((c) => [c.category, c.spent]),
    report.categories.map((c) => [c.category_name, c.amount / 100])
  );
});

test('spending_by_category excludes transfers, duplicates, pending, crypto, and investments', () => {
  const db = setupDb();
  const tool = runAdvisorTool(db, 'spending_by_category', RANGE) as {
    total: number;
    categories: Array<{ category: string; spent: number }>;
  };

  // Only t1 ($50.00) and t2 ($25.00) are real spending; $1,820.00 of the fixture must not count.
  // Measured against the pre-delegation SQL on this exact fixture, the tool reported $1,695.00
  // where Reports reported $75.00: it caught the transfer by category but leaked the remaining
  // $1,620.00, and invented "Crypto" and "Investments" as spending categories.
  assert.equal(tool.total, 75);
  assert.deepEqual(tool.categories.map((c) => c.category).sort(), ['Food & Drink', 'Shopping']);
  assert.equal(tool.categories.find((c) => c.category === 'Food & Drink')?.spent, 50);
});

test('monthly_cashflow agrees with the Cash flow report', () => {
  const db = setupDb();
  const tool = runAdvisorTool(db, 'monthly_cashflow', { months: 36 }) as {
    months: Array<{ month: string; income: number; expenses: number; net: number }>;
  };
  const june = tool.months.find((m) => m.month === '2026-06');
  assert.ok(june, 'June must be present in a 36-month window');

  const report = getCashflowReport(db, { startDate: RANGE.start_date, endDate: RANGE.end_date });
  const reportJune = report.months.find((m) => m.month === '2026-06');
  assert.ok(reportJune);

  assert.equal(june.income, reportJune.income / 100);
  assert.equal(june.expenses, reportJune.expenses / 100);
  assert.equal(june.income, 4000);
  assert.equal(june.expenses, 75);
});

test('monthly_cashflow returns newest month first', () => {
  const db = setupDb();
  const tool = runAdvisorTool(db, 'monthly_cashflow', { months: 36 }) as {
    months: Array<{ month: string }>;
  };
  const months = tool.months.map((m) => m.month);
  assert.deepEqual(months, [...months].sort().reverse());
});

test('get_budgets resolves the current month in local time, not UTC', () => {
  const db = setupDb();
  db.prepare('INSERT INTO budgets (id, category_id, amount) VALUES (?, ?, ?)').run('b1', 'cat_food', 40000);

  const tool = runAdvisorTool(db, 'get_budgets', {}) as { month: string };

  // strftime('%Y-%m','now') is UTC. In a negative-offset zone that is the wrong month for the
  // last hours of every month, which is exactly when a "how am I doing this month" question
  // gets asked.
  assert.equal(tool.month, format(new Date(), 'yyyy-MM'));
});

test('formatMoney gives the model the exact figure, not an abbreviation', () => {
  assert.equal(formatMoney(2749.39), '$2,749.39');
  assert.equal(formatMoney(-4350.62), '-$4,350.62');
  assert.equal(formatMoney(1234567.89), '$1,234,567.89');
  assert.equal(formatMoney(0), '$0.00');
  assert.equal(formatMoney(null), 'N/A');
});
