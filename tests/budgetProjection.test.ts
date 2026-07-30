import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  getBudgetRolloverLedger,
  getMonthlyBudgetsWithProjection,
} from '../server/src/services/budgetProjection';

function setupBudgetDb(): Database.Database {
  const db = new Database(':memory:');

  db.exec(`
    CREATE TABLE categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT,
      icon TEXT,
      parent_id TEXT,
      is_income INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE budgets (
      id TEXT PRIMARY KEY,
      category_id TEXT NOT NULL,
      amount REAL NOT NULL,
      period TEXT NOT NULL DEFAULT 'monthly',
      rollover INTEGER NOT NULL DEFAULT 0,
      rollover_balance REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE transactions (
      manually_categorized INTEGER NOT NULL DEFAULT 0,
      id TEXT PRIMARY KEY,
      category_id TEXT,
      recurring_id TEXT,
      date TEXT NOT NULL,
      amount REAL NOT NULL,
      pending INTEGER NOT NULL DEFAULT 0,
      transfer_status TEXT NOT NULL DEFAULT 'none',
      duplicate_status TEXT NOT NULL DEFAULT 'none'
    );

    CREATE TABLE recurring_patterns (
      id TEXT PRIMARY KEY,
      merchant_name TEXT NOT NULL,
      category_id TEXT,
      average_amount REAL NOT NULL,
      amount_variance REAL NOT NULL DEFAULT 0,
      frequency TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      next_expected TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      is_confirmed INTEGER NOT NULL DEFAULT 0,
      transaction_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE budget_rollover_ledger (
      id TEXT PRIMARY KEY,
      budget_id TEXT NOT NULL,
      month TEXT NOT NULL,
      starting_rollover REAL NOT NULL,
      budget_amount REAL NOT NULL,
      actual_spend REAL NOT NULL,
      ending_rollover REAL NOT NULL,
      calculated_at TEXT NOT NULL,
      UNIQUE(budget_id, month)
    );
  `);

  db.prepare(`
    INSERT INTO categories (id, name, color, icon, parent_id, is_income)
    VALUES
      ('cat_home', 'Home', '#e07070', NULL, NULL, 0),
      ('cat_home_rent', 'Rent', '#e07070', NULL, 'cat_home', 0),
      ('cat_food', 'Food', '#d4a44c', NULL, NULL, 0),
      ('cat_income_paycheck', 'Paycheck', '#4ecba3', NULL, NULL, 1)
  `).run();

  db.prepare(`
    INSERT INTO budgets (id, category_id, amount, period, rollover, rollover_balance, created_at, updated_at)
    VALUES
      ('budget_home', 'cat_home', 1200, 'monthly', 0, 0, '2026-06-01', '2026-06-01'),
      ('budget_food', 'cat_food', 500, 'monthly', 0, 0, '2026-06-01', '2026-06-01')
  `).run();

  db.prepare(`
    INSERT INTO transactions (id, category_id, recurring_id, date, amount, pending)
    VALUES
      ('june_rent_partial', 'cat_home_rent', NULL, '2026-06-03', -400, 0),
      ('june_food', 'cat_food', NULL, '2026-06-04', -100, 0),
      ('june_pending_food', 'cat_food', NULL, '2026-06-05', -999, 1),
      ('may_rent', 'cat_home_rent', NULL, '2026-05-03', -700, 0)
  `).run();

  db.prepare(`
    INSERT INTO recurring_patterns (
      id,
      merchant_name,
      category_id,
      average_amount,
      frequency,
      last_seen,
      next_expected,
      is_active,
      is_confirmed,
      transaction_count,
      created_at,
      updated_at
    )
    VALUES
      ('rent', 'Rent', 'cat_home_rent', 800, 'monthly', '2026-05-25', '2026-06-25', 1, 1, 4, '2026-05-01', '2026-05-01'),
      ('weak_food', 'Maybe Food', 'cat_food', 50, 'monthly', '2026-05-20', '2026-06-20', 1, 0, 2, '2026-05-01', '2026-05-01'),
      ('paycheck', 'Payroll', 'cat_income_paycheck', 3000, 'monthly', '2026-05-15', '2026-06-15', 1, 1, 4, '2026-05-01', '2026-05-01')
  `).run();

  return db;
}

test('monthly budgets include future recurring bills in current month projection', (t) => {
  const db = setupBudgetDb();
  t.after(() => db.close());

  const budgets = getMonthlyBudgetsWithProjection(db, 2026, 6, new Date('2026-06-15T12:00:00.000Z'));
  const home = budgets.find((budget) => budget.category_id === 'cat_home');
  const food = budgets.find((budget) => budget.category_id === 'cat_food');

  assert.equal(home?.spent, 400);
  assert.equal(home?.expected_recurring, 800);
  assert.equal(home?.projected_spend, 1200);
  assert.equal(home?.projected_remaining, 0);
  assert.equal(home?.forecast_confidence, 'confirmed');

  assert.equal(food?.spent, 100);
  assert.equal(food?.expected_recurring, 0);
  assert.equal(food?.projected_spend, 100);
});

test('future month budgets project recurring bills from the whole month', (t) => {
  const db = setupBudgetDb();
  t.after(() => db.close());

  const budgets = getMonthlyBudgetsWithProjection(db, 2026, 7, new Date('2026-06-15T12:00:00.000Z'));
  const home = budgets.find((budget) => budget.category_id === 'cat_home');

  assert.equal(home?.spent, 0);
  assert.equal(home?.expected_recurring, 800);
  assert.equal(home?.projected_spend, 800);
  assert.equal(home?.projected_remaining, 400);
});

test('past month budgets keep actuals without adding future recurring projections', (t) => {
  const db = setupBudgetDb();
  t.after(() => db.close());

  const budgets = getMonthlyBudgetsWithProjection(db, 2026, 5, new Date('2026-06-15T12:00:00.000Z'));
  const home = budgets.find((budget) => budget.category_id === 'cat_home');

  assert.equal(home?.spent, 700);
  assert.equal(home?.expected_recurring, 0);
  assert.equal(home?.projected_spend, 700);
});

test('rollover budgets use prior posted spending as current month carryover', (t) => {
  const db = setupBudgetDb();
  t.after(() => db.close());

  db.prepare(`
    UPDATE budgets
    SET rollover = 1, created_at = '2026-04-01'
    WHERE id = 'budget_food'
  `).run();

  db.prepare(`
    INSERT INTO transactions (id, category_id, recurring_id, date, amount, pending)
    VALUES
      ('april_food', 'cat_food', NULL, '2026-04-10', -450, 0),
      ('may_food', 'cat_food', NULL, '2026-05-11', -300, 0)
  `).run();

  const budgets = getMonthlyBudgetsWithProjection(db, 2026, 6, new Date('2026-06-15T12:00:00.000Z'));
  const food = budgets.find((budget) => budget.category_id === 'cat_food');

  assert.equal(food?.rollover, true);
  assert.equal(food?.rollover_balance, 250);
  assert.equal(food?.spent, 100);
  assert.equal(food?.projected_spend, 100);
  assert.equal(food?.projected_remaining, 650);
  assert.equal(food?.projected_percent, 100 / 750 * 100);
});

test('rollover ledger records month by month carryover math', (t) => {
  const db = setupBudgetDb();
  t.after(() => db.close());

  db.prepare(`
    UPDATE budgets
    SET rollover = 1, created_at = '2026-04-01'
    WHERE id = 'budget_food'
  `).run();

  db.prepare(`
    INSERT INTO transactions (id, category_id, recurring_id, date, amount, pending)
    VALUES
      ('april_food', 'cat_food', NULL, '2026-04-10', -450, 0),
      ('may_food', 'cat_food', NULL, '2026-05-11', -300, 0)
  `).run();

  const ledger = getBudgetRolloverLedger(db, {
    budgetId: 'budget_food',
    month: '2026-06',
    months: 3,
    now: new Date('2026-06-15T12:00:00.000Z'),
  });

  assert.deepEqual(
    ledger.map((row) => ({
      month: row.month,
      starting: row.starting_rollover,
      budget: row.budget_amount,
      spent: row.actual_spend,
      ending: row.ending_rollover,
    })),
    [
      { month: '2026-04', starting: 0, budget: 500, spent: 450, ending: 50 },
      { month: '2026-05', starting: 50, budget: 500, spent: 300, ending: 250 },
      { month: '2026-06', starting: 250, budget: 500, spent: 100, ending: 650 },
    ]
  );

  const persisted = db.prepare(`
    SELECT COUNT(*) AS count
    FROM budget_rollover_ledger
    WHERE budget_id = 'budget_food'
  `).get() as { count: number };
  assert.equal(persisted.count, 3);
});

test('budget spend excludes confirmed duplicates and transfers', (t) => {
  const db = setupBudgetDb();
  t.after(() => db.close());

  const control = getMonthlyBudgetsWithProjection(db, 2026, 6, new Date('2026-06-15T12:00:00.000Z'))
    .find((budget) => budget.category_id === 'cat_food');
  assert.equal(control?.spent, 100);

  // Three rows Reports already excludes; budgets must agree or the same month shows two numbers.
  db.prepare(`
    INSERT INTO transactions (id, category_id, recurring_id, date, amount, pending, transfer_status, duplicate_status)
    VALUES
      ('june_food_dupe', 'cat_food', NULL, '2026-06-04', -100, 0, 'none', 'confirmed'),
      ('june_food_xfer', 'cat_food', NULL, '2026-06-06', -250, 0, 'confirmed', 'none'),
      ('june_food_xfer_maybe', 'cat_food', NULL, '2026-06-07', -175, 0, 'candidate', 'none')
  `).run();

  const after = getMonthlyBudgetsWithProjection(db, 2026, 6, new Date('2026-06-15T12:00:00.000Z'))
    .find((budget) => budget.category_id === 'cat_food');
  assert.equal(after?.spent, 100);

  // Control: an ordinary row on the same day still counts, so the filter isn't dropping everything.
  db.prepare(`
    INSERT INTO transactions (id, category_id, recurring_id, date, amount, pending, transfer_status, duplicate_status)
    VALUES ('june_food_real', 'cat_food', NULL, '2026-06-08', -60, 0, 'none', 'none')
  `).run();

  const withReal = getMonthlyBudgetsWithProjection(db, 2026, 6, new Date('2026-06-15T12:00:00.000Z'))
    .find((budget) => budget.category_id === 'cat_food');
  assert.equal(withReal?.spent, 160);
});
