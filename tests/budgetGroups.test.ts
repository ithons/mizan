import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { getBudgetGroupsWithTotals } from '../server/src/services/budgetGroups';

function setupDb(): Database.Database {
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

    CREATE TABLE budget_groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE budget_group_members (
      group_id TEXT NOT NULL,
      category_id TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      PRIMARY KEY (group_id, category_id),
      UNIQUE(category_id)
    );
  `);

  db.prepare(`
    INSERT INTO categories (id, name, color, icon, parent_id, is_income)
    VALUES
      ('cat_home', 'Home', '#e07070', NULL, NULL, 0),
      ('cat_food', 'Food', '#d4a44c', NULL, NULL, 0),
      ('cat_fun', 'Fun', '#6487f0', NULL, NULL, 0)
  `).run();

  db.prepare(`
    INSERT INTO budgets (id, category_id, amount, period, rollover, rollover_balance, created_at, updated_at)
    VALUES
      ('budget_home', 'cat_home', 1200, 'monthly', 0, 0, '2026-06-01', '2026-06-01'),
      ('budget_food', 'cat_food', 500, 'monthly', 1, 100, '2026-06-01', '2026-06-01'),
      ('budget_fun', 'cat_fun', 200, 'monthly', 0, 0, '2026-06-01', '2026-06-01')
  `).run();

  db.prepare(`
    INSERT INTO transactions (id, category_id, recurring_id, date, amount, pending)
    VALUES
      ('rent', 'cat_home', NULL, '2026-06-01', -1200, 0),
      ('food', 'cat_food', NULL, '2026-06-02', -150, 0),
      ('fun', 'cat_fun', NULL, '2026-06-03', -50, 0)
  `).run();

  db.prepare(`
    INSERT INTO budget_groups (id, name, color, sort_order, created_at, updated_at)
    VALUES ('group_needs', 'Needs', '#32bfa3', 0, '2026-06-01', '2026-06-01')
  `).run();

  db.prepare(`
    INSERT INTO budget_group_members (group_id, category_id, sort_order, created_at)
    VALUES
      ('group_needs', 'cat_home', 0, '2026-06-01'),
      ('group_needs', 'cat_food', 1, '2026-06-01')
  `).run();

  return db;
}

test('budget groups roll up member category budgets', (t) => {
  const db = setupDb();
  t.after(() => db.close());

  const groups = getBudgetGroupsWithTotals(db, 2026, 6, new Date('2026-06-15T12:00:00.000Z'));
  const needs = groups.find((group) => group.id === 'group_needs');

  assert.equal(needs?.members.length, 2);
  assert.equal(needs?.totals.budget_count, 2);
  assert.equal(needs?.totals.budgeted, 1800);
  assert.equal(needs?.totals.spent, 1350);
  assert.equal(needs?.totals.projected_remaining, 450);
  assert.equal(needs?.totals.rollover_balance, 100);
});
