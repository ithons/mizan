import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  getCashflowReport,
  getIncomeReport,
  getReportDrilldown,
  getReportEvidenceDrilldown,
  getReportNetWorthEvidence,
  getReportSummary,
  getSpendingReport,
  getSpendingTrendsReport,
  getNetWorthAttribution,
  getTopMerchantsReport,
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
      institution_name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'checking',
      is_liability INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE transactions (
      manually_categorized INTEGER NOT NULL DEFAULT 0,
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      date TEXT NOT NULL,
      amount REAL NOT NULL,
      merchant_name TEXT,
      original_name TEXT NOT NULL,
      category_id TEXT,
      pending INTEGER NOT NULL DEFAULT 0,
      transfer_status TEXT NOT NULL DEFAULT 'none',
      -- Reports exclude confirmed duplicates (a redundant copy would double the spend).
      duplicate_status TEXT NOT NULL DEFAULT 'none',
      created_at TEXT NOT NULL DEFAULT '2026-06-30T00:00:00.000Z',
      updated_at TEXT NOT NULL DEFAULT '2026-06-30T00:00:00.000Z'
    );

    CREATE TABLE net_worth_snapshots (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      total_assets REAL NOT NULL,
      total_liabilities REAL NOT NULL,
      net_worth REAL NOT NULL,
      breakdown TEXT NOT NULL,
      is_estimated INTEGER NOT NULL DEFAULT 0,
      liquid_assets REAL,
      investment_assets REAL,
      crypto_assets REAL,
      created_at TEXT NOT NULL
    );

    INSERT INTO accounts (id, account_name, institution_name)
    VALUES ('acct_checking', 'Everyday Checking', 'Mizan Test Bank');

    INSERT INTO accounts (id, account_name, institution_name, type, is_liability)
    VALUES ('acct_credit', 'Rewards Card', 'Mizan Test Bank', 'credit', 1);

    INSERT INTO net_worth_snapshots (
      id, date, total_assets, total_liabilities, net_worth, breakdown, is_estimated,
      liquid_assets, investment_assets, crypto_assets, created_at
    )
    VALUES
      (
        'nw_may', '2026-05-31', 1000, 300, 700,
        '{"acct_checking":1000,"acct_credit":300}', 0, 1000, 0, 0,
        '2026-05-31T00:00:00.000Z'
      ),
      (
        'nw_jun', '2026-06-30', 1200, 200, 1000,
        '{"acct_checking":1200,"acct_credit":200}', 0, 1200, 0, 0,
        '2026-06-30T00:00:00.000Z'
      );
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

test('cashflow evidence returns the transactions behind a monthly aggregate', (t) => {
  const db = setupReportingDb();
  t.after(() => db.close());

  const detail = getReportEvidenceDrilldown(db, {
    kind: 'cashflow_month',
    month: '2026-06',
    startDate: '2026-01-01',
    endDate: '2026-12-31',
  });

  assert.equal(detail.label, 'Cash flow for 2026-06');
  assert.equal(detail.start_date, '2026-06-01');
  assert.equal(detail.end_date, '2026-06-30');
  assert.equal(detail.income, 1040);
  assert.equal(detail.expenses, 130);
  assert.equal(detail.net, 910);
  assert.equal(detail.count, 4);
  assert.deepEqual(
    detail.transactions.map((transaction) => transaction.id).sort(),
    ['paycheck', 'restaurant', 'uncategorized_expense', 'uncategorized_income'].sort()
  );
});

test('excluded flow evidence returns omitted transfers, investments, and crypto', (t) => {
  const db = setupReportingDb();
  t.after(() => db.close());

  const transfers = getReportEvidenceDrilldown(db, {
    kind: 'excluded_flow',
    flowType: 'transfers',
    startDate: '2026-06-01',
    endDate: '2026-06-30',
  });

  assert.equal(transfers.label, 'Excluded transfers');
  assert.equal(transfers.income, 500);
  assert.equal(transfers.expenses, 200);
  assert.equal(transfers.net, 300);
  assert.deepEqual(
    transfers.transactions.map((transaction) => transaction.id).sort(),
    ['transfer_in', 'transfer_out']
  );

  const investments = getReportEvidenceDrilldown(db, {
    kind: 'excluded_flow',
    flowType: 'investments',
    startDate: '2026-06-01',
    endDate: '2026-06-30',
  });

  assert.equal(investments.income, 20);
  assert.deepEqual(investments.transactions.map((transaction) => transaction.id), ['investment_income']);

  const crypto = getReportEvidenceDrilldown(db, {
    kind: 'excluded_flow',
    flowType: 'crypto',
    startDate: '2026-06-01',
    endDate: '2026-06-30',
  });

  assert.equal(crypto.expenses, 50);
  assert.deepEqual(crypto.transactions.map((transaction) => transaction.id), ['crypto_buy']);
});

test('net worth evidence links a snapshot to prior values and account balances', (t) => {
  const db = setupReportingDb();
  t.after(() => db.close());

  const detail = getReportNetWorthEvidence(db, 'nw_jun');

  assert.ok(detail);
  assert.equal(detail.label, 'Net worth on 2026-06-30');
  assert.equal(detail.snapshot.net_worth, 1000);
  assert.equal(detail.previous_snapshot?.id, 'nw_may');
  assert.equal(detail.delta, 300);
  assert.equal(detail.asset_delta, 200);
  assert.equal(detail.liability_delta, -100);
  assert.deepEqual(detail.accounts, [
    {
      account_id: 'acct_checking',
      account_name: 'Everyday Checking',
      institution_name: 'Mizan Test Bank',
      type: 'checking',
      is_liability: false,
      balance: 1200,
    },
    {
      account_id: 'acct_credit',
      account_name: 'Rewards Card',
      institution_name: 'Mizan Test Bank',
      type: 'credit',
      is_liability: true,
      balance: 200,
    },
  ]);
});

test('a confirmed duplicate stops counting toward spending', (t) => {
  const db = setupReportingDb();
  t.after(() => db.close());

  const range = { startDate: '2026-06-01', endDate: '2026-06-30' };
  const before = getSpendingReport(db, range).total;

  // Simulate the user resolving a duplicate: one copy kept, the redundant copy flagged.
  // It is FLAGGED rather than deleted because a provider row would return on the next sync.
  db.prepare(`
    INSERT INTO transactions (id, account_id, date, amount, merchant_name, original_name, category_id, pending, transfer_status, duplicate_status)
    VALUES ('dupe_copy', 'acct_checking', '2026-06-07', -100, 'restaurant', 'restaurant', 'cat_food_restaurants', 0, 'none', 'confirmed')
  `).run();

  assert.equal(
    getSpendingReport(db, range).total,
    before,
    'a confirmed duplicate must not inflate spending'
  );

  // Sanity: the same row WOULD count if it were an ordinary transaction.
  db.prepare("UPDATE transactions SET duplicate_status = 'none' WHERE id = 'dupe_copy'").run();
  assert.equal(getSpendingReport(db, range).total, before + 100, 'control: it counts when not flagged');
});

test('top merchants ranks reportable spend and excludes transfers, crypto, and pending', (t) => {
  const db = setupReportingDb();
  t.after(() => db.close());

  db.prepare(`
    INSERT INTO transactions (id, account_id, date, amount, merchant_name, original_name, category_id, pending, transfer_status)
    VALUES
      ('cafe_1', 'acct_checking', '2026-06-12', -40, 'Blue Bottle', 'BLUE BOTTLE #12', 'cat_food_restaurants', 0, 'none'),
      ('cafe_2', 'acct_checking', '2026-06-18', -35, 'Blue Bottle', 'BLUE BOTTLE #12', 'cat_food_restaurants', 0, 'none'),
      -- No merchant_name: must fall back to original_name rather than collapsing into "Unknown".
      ('raw_only', 'acct_checking', '2026-06-19', -25, NULL, 'CORNER STORE', 'cat_food', 0, 'none')
  `).run();

  const report = getTopMerchantsReport(db, { startDate: '2026-06-01', endDate: '2026-06-30' });
  const byName = new Map(report.merchants.map((m) => [m.merchant, m]));

  const blueBottle = byName.get('Blue Bottle');
  assert.equal(blueBottle?.total, 75);
  assert.equal(blueBottle?.transaction_count, 2);
  assert.equal(blueBottle?.last_date, '2026-06-18');
  assert.equal(blueBottle?.category_name, 'Restaurants');

  assert.equal(byName.get('CORNER STORE')?.total, 25);

  // The exclusions Reports applies everywhere else must hold here too.
  assert.equal(byName.has('transfer_out'), false);
  assert.equal(byName.has('crypto_buy'), false);
  assert.equal(byName.has('pending_food'), false);

  // restaurant(100) + uncategorized_expense(30) + 75 + 25
  assert.equal(report.total, 230);
});

test('top merchants honors the limit and orders by spend', (t) => {
  const db = setupReportingDb();
  t.after(() => db.close());

  const report = getTopMerchantsReport(db, { startDate: '2026-06-01', endDate: '2026-06-30', limit: 1 });
  assert.equal(report.merchants.length, 1);
  assert.equal(report.merchants[0]?.merchant, 'restaurant');
  // The total stays the full window total, not the truncated sum, so shares stay honest.
  assert.equal(report.total, 130);
});

test('net worth attribution diffs per-account balances between the window snapshots', (t) => {
  const db = setupReportingDb();
  t.after(() => db.close());

  const attribution = getNetWorthAttribution(db, {});
  assert.ok(attribution);
  assert.equal(attribution.start_date, '2026-05-31');
  assert.equal(attribution.end_date, '2026-06-30');
  assert.equal(attribution.delta, 300);

  const byId = new Map(attribution.accounts.map((a) => [a.account_id, a]));
  assert.equal(byId.get('acct_checking')?.delta, 200);
  assert.equal(byId.get('acct_checking')?.account_name, 'Everyday Checking');

  // The card's balance fell 300 -> 200. `breakdown` stores debt as a positive amount owed, so
  // paying it down is a POSITIVE contribution to net worth, not a -100 "loss".
  const card = byId.get('acct_credit');
  assert.equal(card?.is_liability, true);
  assert.equal(card?.start_balance, 300);
  assert.equal(card?.end_balance, 200);
  assert.equal(card?.delta, 100);

  // The whole point of attribution: the parts must add up to the headline move.
  const summed = attribution.accounts.reduce((total, a) => total + a.delta, 0);
  assert.equal(summed, attribution.delta);

  // Largest absolute mover first, regardless of sign.
  assert.equal(attribution.accounts[0]?.account_id, 'acct_checking');
});

test('net worth attribution needs two snapshots and survives a malformed breakdown', (t) => {
  const db = setupReportingDb();
  t.after(() => db.close());

  // A single-snapshot window is a point, not a movement.
  assert.equal(getNetWorthAttribution(db, { startDate: '2026-06-01', endDate: '2026-06-30' }), null);

  db.prepare(`UPDATE net_worth_snapshots SET breakdown = 'not json' WHERE id = 'nw_jun'`).run();
  const degraded = getNetWorthAttribution(db, {});
  assert.ok(degraded);
  // Net worth still moved; the per-account attribution just reads as a drop to zero rather than 500ing.
  assert.equal(degraded.delta, 300);
  assert.equal(degraded.accounts.every((a) => a.end_balance === 0), true);
});

test('an account that appears only in the later snapshot counts its full balance as the move', (t) => {
  const db = setupReportingDb();
  t.after(() => db.close());

  db.prepare(`
    UPDATE net_worth_snapshots
    SET breakdown = '{"acct_checking":1200,"acct_credit":200,"acct_new":400}'
    WHERE id = 'nw_jun'
  `).run();

  const attribution = getNetWorthAttribution(db, {});
  const added = attribution?.accounts.find((a) => a.account_id === 'acct_new');
  assert.equal(added?.start_balance, 0);
  assert.equal(added?.delta, 400);
  assert.equal(added?.account_name, null); // unknown to the accounts table, still attributed
});
