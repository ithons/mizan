import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { getMonthlyBudgetsWithProjection } from '../server/src/services/budgetProjection';

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
      id TEXT PRIMARY KEY,
      category_id TEXT,
      recurring_id TEXT,
      date TEXT NOT NULL,
      amount REAL NOT NULL,
      pending INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE recurring_patterns (
      id TEXT PRIMARY KEY,
      merchant_name TEXT NOT NULL,
      category_id TEXT,
      average_amount REAL NOT NULL,
      frequency TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      next_expected TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      is_confirmed INTEGER NOT NULL DEFAULT 0,
      transaction_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
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
