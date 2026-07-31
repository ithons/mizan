import test from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { getBudgetGroupsWithTotals } from '../server/src/services/budgetGroups';
import { insertAccount, insertCategory, insertTransaction, migratedTestDb } from './helpers/schema';

/**
 * Built on the real migrated schema rather than a hand-written one.
 *
 * The schema this file used to declare had already drifted from production twice: `budgets.amount`
 * and `transactions.amount` were REAL where every money column has been INTEGER cents since
 * migrations 018/022, and `budget_rollover_ledger` had to be bolted on later when the projection
 * started reading recorded carryover. A minimal schema cannot fail that way loudly; it just keeps
 * asserting against a shape the database does not have.
 *
 * Amounts here are integer cents, which is what `getMonthlyBudgetsWithProjection` reads and returns.
 */
function setupDb(): Database.Database {
  const db = migratedTestDb();

  const home = insertCategory(db, { id: 'cat_test_home', name: 'Home' });
  const food = insertCategory(db, { id: 'cat_test_food', name: 'Food' });
  const fun = insertCategory(db, { id: 'cat_test_fun', name: 'Fun' });
  const account = insertAccount(db, { account_name: 'Checking', current_balance: 500000 });

  const insertBudget = db.prepare(`
    INSERT INTO budgets (id, category_id, amount, period, rollover, rollover_balance, created_at, updated_at)
    VALUES (?, ?, ?, 'monthly', ?, ?, '2026-06-01', '2026-06-01')
  `);
  insertBudget.run('budget_home', home, 120000, 0, 0);
  insertBudget.run('budget_food', food, 50000, 1, 10000);
  insertBudget.run('budget_fun', fun, 20000, 0, 0);

  insertTransaction(db, { account_id: account, date: '2026-06-01', amount: -120000, category_id: home });
  insertTransaction(db, { account_id: account, date: '2026-06-02', amount: -15000, category_id: food });
  insertTransaction(db, { account_id: account, date: '2026-06-03', amount: -5000, category_id: fun });

  db.prepare(`
    INSERT INTO budget_groups (id, name, color, sort_order, created_at, updated_at)
    VALUES ('group_needs', 'Needs', '#32bfa3', 0, '2026-06-01', '2026-06-01')
  `).run();
  const insertMember = db.prepare(`
    INSERT INTO budget_group_members (group_id, category_id, sort_order, created_at)
    VALUES ('group_needs', ?, ?, '2026-06-01')
  `);
  insertMember.run(home, 0);
  insertMember.run(food, 1);

  return db;
}

test('budget groups roll up member category budgets', (t) => {
  const db = setupDb();
  t.after(() => db.close());

  const groups = getBudgetGroupsWithTotals(db, 2026, 6, new Date('2026-06-15T12:00:00.000Z'));
  const needs = groups.find((group) => group.id === 'group_needs');

  assert.equal(needs?.members.length, 2);
  assert.equal(needs?.totals.budget_count, 2);
  assert.equal(needs?.totals.budgeted, 180000);
  assert.equal(needs?.totals.spent, 135000);
  assert.equal(needs?.totals.projected_remaining, 45000);
  assert.equal(needs?.totals.rollover_balance, 10000);
});

test('the group excludes the budget that is not a member of it', (t) => {
  const db = setupDb();
  t.after(() => db.close());

  const needs = getBudgetGroupsWithTotals(db, 2026, 6, new Date('2026-06-15T12:00:00.000Z'))
    .find((group) => group.id === 'group_needs');

  // Fun is budgeted and spent in the same month, so a rollup that swept every budget rather than
  // its own members would read 200000 budgeted and 140000 spent.
  assert.ok(needs);
  assert.deepEqual(needs.members.map((member) => member.category_name), ['Home', 'Food']);
});
