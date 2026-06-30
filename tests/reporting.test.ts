import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  getCashflowReport,
  getIncomeReport,
  getReportDrilldown,
  getReportSummary,
  getSpendingReport,
  getSpendingTrendsReport,
} from '../server/src/services/reporting';

interface CategoryFixture {
  id: string;
  name: string;
  color?: string | null;
  parent_id?: string | null;
  is_income?: number;
  is_investment?: number;
}

interface TransactionFixture {
  id: string;
  date: string;
  amount: number;
  category_id?: string | null;
  pending?: number;
  account_id?: string;
}

function setupReportingDb(): Database.Database {
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
      institution_name TEXT NOT NULL
    );

    CREATE TABLE transactions (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      date TEXT NOT NULL,
      amount REAL NOT NULL,
      merchant_name TEXT,
      original_name TEXT NOT NULL,
      category_id TEXT,
      pending INTEGER NOT NULL DEFAULT 0,
      transfer_status TEXT NOT NULL DEFAULT 'none',
      created_at TEXT NOT NULL DEFAULT '2026-06-30T00:00:00.000Z',
      updated_at TEXT NOT NULL DEFAULT '2026-06-30T00:00:00.000Z'
    );

    INSERT INTO accounts (id, account_name, institution_name)
    VALUES ('acct_checking', 'Everyday Checking', 'Mizan Test Bank');
  `);

  const insertCategory = db.prepare(`
    INSERT INTO categories (id, name, color, parent_id, is_income, is_investment)
    VALUES (@id, @name, @color, @parent_id, @is_income, @is_investment)
  `);

  const categories: CategoryFixture[] = [
    { id: 'cat_income_paycheck', name: 'Paycheck', color: '#4ecba3', is_income: 1 },
    { id: 'cat_food', name: 'Food', color: '#e07070' },
    { id: 'cat_food_restaurants', name: 'Restaurants', color: '#e07070', parent_id: 'cat_food' },
    { id: 'cat_xfer', name: 'Transfers', color: '#6b6b7a' },
    { id: 'cat_xfer_in', name: 'Transfer In', color: '#6b6b7a', parent_id: 'cat_xfer' },
    { id: 'cat_inv', name: 'Investments', color: '#5b8dee', is_investment: 1 },
    {
      id: 'cat_inv_dividend',
      name: 'Dividends',
      color: '#5b8dee',
      parent_id: 'cat_inv',
      is_income: 1,
      is_investment: 1,
    },
    { id: 'cat_crypto', name: 'Crypto', color: '#a78bfa' },
    { id: 'cat_crypto_buy', name: 'Crypto Buy', color: '#a78bfa', parent_id: 'cat_crypto' },
  ];

  for (const category of categories) {
    insertCategory.run({
      id: category.id,
      name: category.name,
      color: category.color ?? null,
      parent_id: category.parent_id ?? null,
      is_income: category.is_income ?? 0,
      is_investment: category.is_investment ?? 0,
    });
  }

  const insertTransaction = db.prepare(`
    INSERT INTO transactions (
      id, account_id, date, amount, merchant_name, original_name, category_id, pending, transfer_status
    )
    VALUES (
      @id, @account_id, @date, @amount, @merchant_name, @original_name, @category_id, @pending, @transfer_status
    )
  `);

  const transactions: TransactionFixture[] = [
    { id: 'may_paycheck', date: '2026-05-03', amount: 900, category_id: 'cat_income_paycheck' },
    { id: 'may_restaurant', date: '2026-05-07', amount: -80, category_id: 'cat_food_restaurants' },
    { id: 'paycheck', date: '2026-06-03', amount: 1000, category_id: 'cat_income_paycheck' },
    { id: 'uncategorized_income', date: '2026-06-04', amount: 40 },
    { id: 'transfer_in', date: '2026-06-05', amount: 500, category_id: 'cat_xfer_in' },
    { id: 'investment_income', date: '2026-06-06', amount: 20, category_id: 'cat_inv_dividend' },
    { id: 'restaurant', date: '2026-06-07', amount: -100, category_id: 'cat_food_restaurants' },
    { id: 'uncategorized_expense', date: '2026-06-08', amount: -30 },
    { id: 'transfer_out', date: '2026-06-09', amount: -200, category_id: 'cat_xfer' },
    { id: 'crypto_buy', date: '2026-06-10', amount: -50, category_id: 'cat_crypto_buy' },
    { id: 'pending_food', date: '2026-06-11', amount: -999, category_id: 'cat_food_restaurants', pending: 1 },
  ];

  for (const transaction of transactions) {
    insertTransaction.run({
      id: transaction.id,
      account_id: transaction.account_id ?? 'acct_checking',
      date: transaction.date,
      amount: transaction.amount,
      merchant_name: transaction.id,
      original_name: transaction.id,
      category_id: transaction.category_id ?? null,
      pending: transaction.pending ?? 0,
      transfer_status: 'none',
    });
  }

  return db;
}

test('cashflow excludes transfers, investments, crypto, and pending transactions', (t) => {
  const db = setupReportingDb();
  t.after(() => db.close());

  const report = getCashflowReport(db, {
    startDate: '2026-06-01',
    endDate: '2026-06-30',
  });

  assert.deepEqual(report.months, [
    {
      month: '2026-06',
      income: 1040,
      expenses: 130,
      net: 910,
    },
  ]);
});

test('spending report rolls child categories up without counting excluded roots', (t) => {
  const db = setupReportingDb();
  t.after(() => db.close());

  const report = getSpendingReport(db, {
    startDate: '2026-06-01',
    endDate: '2026-06-30',
  });

  assert.equal(report.total, 130);
  assert.equal(report.categories.length, 2);

  const food = report.categories.find((category) => category.category_id === 'cat_food');
  assert.equal(food?.amount, 100);
  assert.equal(food?.children?.[0]?.category_id, 'cat_food_restaurants');
  assert.equal(food?.children?.[0]?.amount, 100);

  const uncategorized = report.categories.find((category) => category.category_id === 'uncategorized');
  assert.equal(uncategorized?.amount, 30);

  const categoryIds = report.categories.map((category) => category.category_id);
  assert.ok(!categoryIds.includes('cat_xfer'));
  assert.ok(!categoryIds.includes('cat_crypto'));
  assert.ok(!categoryIds.includes('cat_inv'));
});

test('income report keeps reportable income and excludes transfer and investment income', (t) => {
  const db = setupReportingDb();
  t.after(() => db.close());

  const report = getIncomeReport(db, {
    startDate: '2026-06-01',
    endDate: '2026-06-30',
  });

  assert.equal(report.total, 1040);
  assert.deepEqual(
    report.categories.map((category) => [category.category_id, category.amount]),
    [
      ['cat_income_paycheck', 1000],
      ['uncategorized', 40],
    ]
  );
});

test('spending trends expand selected parent categories to their descendants', (t) => {
  const db = setupReportingDb();
  t.after(() => db.close());

  const allTrends = getSpendingTrendsReport(db, {
    startDate: '2026-06-01',
    endDate: '2026-06-30',
  });

  assert.deepEqual(allTrends.months, ['2026-06']);
  assert.equal(
    allTrends.series.find((series) => series.category_id === 'cat_food_restaurants')?.values[0],
    100
  );
  assert.equal(
    allTrends.series.find((series) => series.category_id === 'uncategorized')?.values[0],
    30
  );

  const selectedTrends = getSpendingTrendsReport(db, {
    startDate: '2026-06-01',
    endDate: '2026-06-30',
    categoryIds: ['cat_food'],
  });

  assert.deepEqual(selectedTrends.series, [
    {
      category_id: 'cat_food',
      category_name: 'Food',
      color: '#e07070',
      values: [100],
    },
  ]);
});

test('report summary compares equal prior period and explains excluded flows', (t) => {
  const db = setupReportingDb();
  t.after(() => db.close());

  const summary = getReportSummary(db, {
    startDate: '2026-06-01',
    endDate: '2026-06-30',
  });

  assert.equal(summary.comparison, 'prior_period');
  assert.equal(summary.comparison_label, 'Prior period');
  assert.equal(summary.comparison_start_date, '2026-05-02');
  assert.equal(summary.comparison_end_date, '2026-05-31');
  assert.equal(summary.previous_start_date, '2026-05-02');
  assert.equal(summary.previous_end_date, '2026-05-31');
  assert.deepEqual(summary.income, {
    current: 1040,
    previous: 900,
    delta: 140,
    delta_percent: 140 / 900 * 100,
  });
  assert.deepEqual(summary.expenses, {
    current: 130,
    previous: 80,
    delta: 50,
    delta_percent: 62.5,
  });
  assert.equal(summary.net.current, 910);
  assert.equal(summary.net.previous, 820);

  const transferFlow = summary.excluded_flows.find((flow) => flow.flow_type === 'transfers');
  assert.deepEqual(transferFlow, {
    flow_type: 'transfers',
    count: 2,
    inflows: 500,
    outflows: 200,
    net: 300,
  });
  assert.equal(summary.excluded_flows.find((flow) => flow.flow_type === 'crypto')?.outflows, 50);
  assert.equal(summary.excluded_flows.find((flow) => flow.flow_type === 'investments')?.inflows, 20);
  assert.equal(summary.spending_movers[0].category_id, 'uncategorized');
});

test('report summary supports explicit comparison ranges', (t) => {
  const db = setupReportingDb();
  t.after(() => db.close());

  const priorMonth = getReportSummary(db, {
    startDate: '2026-06-01',
    endDate: '2026-06-30',
    comparison: 'prior_month',
  });

  assert.equal(priorMonth.comparison_label, 'Prior month');
  assert.equal(priorMonth.comparison_start_date, '2026-05-01');
  assert.equal(priorMonth.comparison_end_date, '2026-05-31');
  assert.equal(priorMonth.income.previous, 900);
  assert.equal(priorMonth.expenses.previous, 80);

  const sameMonthLastYear = getReportSummary(db, {
    startDate: '2026-06-01',
    endDate: '2026-06-30',
    comparison: 'same_month_last_year',
  });

  assert.equal(sameMonthLastYear.comparison_label, 'Same month last year');
  assert.equal(sameMonthLastYear.comparison_start_date, '2025-06-01');
  assert.equal(sameMonthLastYear.comparison_end_date, '2025-06-30');
  assert.equal(sameMonthLastYear.income.previous, 0);

  const trailing = getReportSummary(db, {
    startDate: '2026-06-01',
    endDate: '2026-06-30',
    comparison: 'trailing_3',
  });

  assert.equal(trailing.comparison_label, 'Trailing 3 months');
  assert.equal(trailing.comparison_start_date, '2026-03-01');
  assert.equal(trailing.comparison_end_date, '2026-05-31');
  assert.equal(trailing.expenses.previous, 80);
});

test('report drilldown returns backing spending transactions for category rollups', (t) => {
  const db = setupReportingDb();
  t.after(() => db.close());

  const detail = getReportDrilldown(db, {
    kind: 'spending',
    categoryId: 'cat_food',
    startDate: '2026-06-01',
    endDate: '2026-06-30',
  });

  assert.equal(detail.category_name, 'Food');
  assert.equal(detail.total, 100);
  assert.equal(detail.count, 1);
  assert.equal(detail.transactions[0]?.id, 'restaurant');
  assert.equal(detail.transactions[0]?.account_name, 'Everyday Checking');
});

test('report drilldown keeps uncategorized and income evidence traceable', (t) => {
  const db = setupReportingDb();
  t.after(() => db.close());

  const uncategorized = getReportDrilldown(db, {
    kind: 'spending',
    categoryId: 'uncategorized',
    startDate: '2026-06-01',
    endDate: '2026-06-30',
  });

  assert.equal(uncategorized.total, 30);
  assert.deepEqual(uncategorized.transactions.map((transaction) => transaction.id), ['uncategorized_expense']);

  const income = getReportDrilldown(db, {
    kind: 'income',
    categoryId: 'cat_income_paycheck',
    startDate: '2026-06-01',
    endDate: '2026-06-30',
  });

  assert.equal(income.total, 1000);
  assert.deepEqual(income.transactions.map((transaction) => transaction.id), ['paycheck']);
});
