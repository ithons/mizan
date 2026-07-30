import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { addMonths, format, parseISO, subMonths } from 'date-fns';
import {
  computeBudgetRolloverLedger,
  getMonthlyBudgetsWithProjection,
  hasRolloverBudgets,
  recordBudgetRolloverLedger,
} from '../server/src/services/budgetProjection';
import { confirmAdvisorDraft } from '../server/src/services/advisorDrafts';
import { _setDbForTesting } from '../server/src/db/index';
import { detectRecurring } from '../server/src/services/recurring';
import { insertAccount, insertTransaction, migratedTestDb } from './helpers/schema';
import type { AdvisorDraftAction } from '../shared/types';

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

/**
 * The carryover tests run on the real schema. `budget_rollover_ledger` leans on its
 * `UNIQUE(budget_id, month)` and its FK to `budgets`, and a hand-written table that omits either
 * lets a recording bug pass here and fail in production. Money below is integer cents throughout:
 * a $500 budget is 50000.
 */
function setupRolloverDb(): Database.Database {
  const db = migratedTestDb();

  db.prepare(`
    INSERT INTO budgets (id, category_id, amount, period, rollover, rollover_balance, created_at, updated_at)
    VALUES ('budget_food', 'cat_food', 50000, 'monthly', 1, 0, '2026-04-01', '2026-04-01')
  `).run();

  const accountId = insertAccount(db);
  insertTransaction(db, { account_id: accountId, date: '2026-04-10', amount: -45000, category_id: 'cat_food' });
  insertTransaction(db, { account_id: accountId, date: '2026-05-11', amount: -30000, category_id: 'cat_food' });
  insertTransaction(db, { account_id: accountId, date: '2026-06-04', amount: -10000, category_id: 'cat_food' });
  insertTransaction(db, {
    account_id: accountId,
    date: '2026-06-05',
    amount: -99900,
    category_id: 'cat_food',
    pending: 1,
  });

  return db;
}

/** What the Budget screen says `budget_food` carries into `monthKey`. */
function screenCarryover(db: Database.Database, monthKey: string, now: Date): number {
  const [year, month] = monthKey.split('-').map(Number);
  const budget = getMonthlyBudgetsWithProjection(db, year, month, now)
    .find((row) => row.id === 'budget_food');
  assert.ok(budget, `budget_food is missing from the ${monthKey} budget screen`);
  return budget.rollover_balance ?? 0;
}

/** What the carryover ledger says the same budget carries into the same month, or null if it says nothing. */
function ledgerCarryover(db: Database.Database, monthKey: string, now: Date): number | null {
  const rows = computeBudgetRolloverLedger(db, {
    budgetId: 'budget_food',
    month: monthKey,
    months: 1,
    now,
  });
  return rows.length === 0 ? null : rows[0].starting_rollover;
}

function ledgerShape(rows: ReturnType<typeof computeBudgetRolloverLedger>) {
  return rows.map((row) => ({
    month: row.month,
    starting: row.starting_rollover,
    budget: row.budget_amount,
    spent: row.actual_spend,
    ending: row.ending_rollover,
  }));
}

function ledgerTableState(db: Database.Database): { count: number; latest: string | null } {
  return db.prepare(`
    SELECT COUNT(*) AS count, MAX(calculated_at) AS latest
    FROM budget_rollover_ledger
  `).get() as { count: number; latest: string | null };
}

test('rollover ledger reads month by month carryover math without recording it', (t) => {
  const db = setupRolloverDb();
  t.after(() => db.close());

  const ledger = computeBudgetRolloverLedger(db, {
    budgetId: 'budget_food',
    month: '2026-06',
    months: 3,
    now: new Date('2026-06-15T12:00:00.000Z'),
  });

  assert.deepEqual(ledgerShape(ledger), [
    { month: '2026-04', starting: 0, budget: 50000, spent: 45000, ending: 5000 },
    { month: '2026-05', starting: 5000, budget: 50000, spent: 30000, ending: 25000 },
    { month: '2026-06', starting: 25000, budget: 50000, spent: 10000, ending: 65000 },
  ]);

  // A budget nothing has recorded yet still renders its whole history: the read falls back to the
  // live amount for every month it has no row for, so the panel is never empty waiting for a sync.
  assert.deepEqual(ledgerTableState(db), { count: 0, latest: null });
});

// GET /api/budgets/rollover-ledger used to upsert every month it walked, and localGuard exempts GET
// from the cross-origin check on the assumption that a GET cannot write.
test('reading the rollover ledger twice writes nothing either time', (t) => {
  const db = setupRolloverDb();
  t.after(() => db.close());

  recordBudgetRolloverLedger(db, { now: new Date('2026-06-15T12:00:00.000Z') });
  const recorded = ledgerTableState(db);
  assert.equal(recorded.count, 3);
  assert.equal(recorded.latest, '2026-06-15T12:00:00.000Z');

  const first = computeBudgetRolloverLedger(db, { now: new Date('2026-07-20T12:00:00.000Z') });
  assert.deepEqual(ledgerTableState(db), recorded);

  const second = computeBudgetRolloverLedger(db, { now: new Date('2026-07-20T12:00:00.000Z') });
  assert.deepEqual(ledgerTableState(db), recorded);
  assert.deepEqual(ledgerShape(second), ledgerShape(first));
});

// The walk used to take `budgets.amount` for every month it touched, so raising a budget in August
// rewrote July's carryover as though July had always been at the new number.
test('a recorded month keeps its own budget amount when the budget changes later', (t) => {
  const db = setupRolloverDb();
  t.after(() => db.close());

  recordBudgetRolloverLedger(db, { now: new Date('2026-06-15T12:00:00.000Z') });
  db.prepare(`UPDATE budgets SET amount = 90000 WHERE id = 'budget_food'`).run();

  const ledger = computeBudgetRolloverLedger(db, {
    budgetId: 'budget_food',
    month: '2026-06',
    months: 3,
    now: new Date('2026-06-15T12:00:00.000Z'),
  });

  // April and May are closed and hold the amount that was in force. June is the month in progress
  // and tracks the live budget, so raising it today is visible today rather than at month end.
  assert.deepEqual(ledgerShape(ledger), [
    { month: '2026-04', starting: 0, budget: 50000, spent: 45000, ending: 5000 },
    { month: '2026-05', starting: 5000, budget: 50000, spent: 30000, ending: 25000 },
    { month: '2026-06', starting: 25000, budget: 90000, spent: 10000, ending: 105000 },
  ]);
});

test('a month freezes once a later month has opened', (t) => {
  const db = setupRolloverDb();
  t.after(() => db.close());

  recordBudgetRolloverLedger(db, { now: new Date('2026-06-15T12:00:00.000Z') });
  db.prepare(`UPDATE budgets SET amount = 90000 WHERE id = 'budget_food'`).run();
  recordBudgetRolloverLedger(db, { now: new Date('2026-07-02T12:00:00.000Z') });

  const june = db.prepare(`
    SELECT budget_amount, ending_rollover FROM budget_rollover_ledger
    WHERE budget_id = 'budget_food' AND month = '2026-06'
  `).get() as { budget_amount: number; ending_rollover: number };
  assert.equal(june.budget_amount, 50000);
  assert.equal(june.ending_rollover, 65000);

  const july = db.prepare(`
    SELECT budget_amount, starting_rollover FROM budget_rollover_ledger
    WHERE budget_id = 'budget_food' AND month = '2026-07'
  `).get() as { budget_amount: number; starting_rollover: number };
  assert.equal(july.budget_amount, 90000);
  assert.equal(july.starting_rollover, 65000);
});

// Spend is re-derived, never frozen: a transaction that posts or is recategorized weeks later
// belongs to the month it happened in, however long ago that month closed.
test('a late transaction still reaches the closed month it belongs to', (t) => {
  const db = setupRolloverDb();
  t.after(() => db.close());

  recordBudgetRolloverLedger(db, { now: new Date('2026-06-15T12:00:00.000Z') });
  insertTransaction(db, { date: '2026-04-28', amount: -2500, category_id: 'cat_food' });

  const ledger = computeBudgetRolloverLedger(db, {
    budgetId: 'budget_food',
    month: '2026-06',
    months: 3,
    now: new Date('2026-06-15T12:00:00.000Z'),
  });

  assert.deepEqual(ledgerShape(ledger), [
    { month: '2026-04', starting: 0, budget: 50000, spent: 47500, ending: 2500 },
    { month: '2026-05', starting: 2500, budget: 50000, spent: 30000, ending: 22500 },
    { month: '2026-06', starting: 22500, budget: 50000, spent: 10000, ending: 62500 },
  ]);
});

// The sync path records every hour. A pass that restates a settled month would put a different
// number on the carryover panel every hour on data that never moved.
test('recording twice over unchanged data changes nothing but the timestamp', (t) => {
  const db = setupRolloverDb();
  t.after(() => db.close());

  const figures = () => db.prepare(`
    SELECT id, starting_rollover, budget_amount, actual_spend, ending_rollover
    FROM budget_rollover_ledger ORDER BY id
  `).all();

  recordBudgetRolloverLedger(db, { now: new Date('2026-06-15T12:00:00.000Z') });
  const first = figures();

  recordBudgetRolloverLedger(db, { now: new Date('2026-06-15T13:00:00.000Z') });
  assert.deepEqual(figures(), first);
  assert.equal(ledgerTableState(db).latest, '2026-06-15T13:00:00.000Z');
});

test('a budget that does not roll over is neither recorded nor returned', (t) => {
  const db = setupRolloverDb();
  t.after(() => db.close());

  db.prepare(`UPDATE budgets SET rollover = 0 WHERE id = 'budget_food'`).run();

  const now = new Date('2026-06-15T12:00:00.000Z');
  assert.deepEqual(recordBudgetRolloverLedger(db, { now }), { recorded: 0 });
  assert.deepEqual(ledgerTableState(db), { count: 0, latest: null });
  assert.deepEqual(computeBudgetRolloverLedger(db, { now }), []);
});

test('one budget freezing does not freeze another budget', (t) => {
  const db = setupRolloverDb();
  t.after(() => db.close());

  db.prepare(`
    INSERT INTO budgets (id, category_id, amount, period, rollover, rollover_balance, created_at, updated_at)
    VALUES ('budget_home', 'cat_home', 120000, 'monthly', 1, 0, '2026-05-01', '2026-05-01')
  `).run();
  insertTransaction(db, { date: '2026-05-03', amount: -70000, category_id: 'cat_home_rent' });
  insertTransaction(db, { date: '2026-06-03', amount: -40000, category_id: 'cat_home_rent' });

  recordBudgetRolloverLedger(db, { budgetId: 'budget_food', now: new Date('2026-06-15T12:00:00.000Z') });
  db.prepare('UPDATE budgets SET amount = 90000').run();

  const ledger = computeBudgetRolloverLedger(db, {
    month: '2026-06',
    months: 3,
    now: new Date('2026-06-15T12:00:00.000Z'),
  });

  const amountsFor = (budgetId: string) =>
    ledger.filter((row) => row.budget_id === budgetId).map((row) => [row.month, row.budget_amount]);

  assert.deepEqual(amountsFor('budget_food'), [['2026-04', 50000], ['2026-05', 50000], ['2026-06', 90000]]);
  assert.deepEqual(amountsFor('budget_home'), [['2026-05', 90000], ['2026-06', 90000]]);
});

// The Budget screen's rollover_balance and the carryover panel are the same quantity read twice.
// They were two separate walks and one of them missed the read/write split, so an ordinary budget
// raise made them disagree by exactly the raise. Every case below asserts equality, not closeness.

test('both carryover walkers agree when a budget is raised mid-month', (t) => {
  const db = setupRolloverDb();
  t.after(() => db.close());

  const now = new Date('2026-06-15T12:00:00.000Z');
  recordBudgetRolloverLedger(db, { now });
  db.prepare(`UPDATE budgets SET amount = 90000 WHERE id = 'budget_food'`).run();

  // April and May closed at $500 and stay there; the raise lands on June, which is still open.
  assert.equal(ledgerCarryover(db, '2026-06', now), 25000);
  assert.equal(screenCarryover(db, '2026-06', now), 25000);
});

test('both carryover walkers agree when a budget is raised after a month closed', (t) => {
  const db = setupRolloverDb();
  t.after(() => db.close());

  recordBudgetRolloverLedger(db, { now: new Date('2026-06-15T12:00:00.000Z') });
  const july = new Date('2026-07-05T12:00:00.000Z');
  db.prepare(`UPDATE budgets SET amount = 90000 WHERE id = 'budget_food'`).run();

  // Walking June at the new $900 would carry 185000 into July. Both sides read the recorded $500.
  assert.equal(ledgerCarryover(db, '2026-07', july), 65000);
  assert.equal(screenCarryover(db, '2026-07', july), 65000);
});

test('both carryover walkers agree that a budget with rollover off carries nothing', (t) => {
  const db = setupRolloverDb();
  t.after(() => db.close());

  db.prepare(`UPDATE budgets SET rollover = 0 WHERE id = 'budget_food'`).run();
  const now = new Date('2026-06-15T12:00:00.000Z');

  assert.equal(ledgerCarryover(db, '2026-06', now), null);
  assert.equal(screenCarryover(db, '2026-06', now), 0);
});

test('both carryover walkers agree on a month nothing has recorded', (t) => {
  const db = setupRolloverDb();
  t.after(() => db.close());

  const now = new Date('2026-06-15T12:00:00.000Z');
  assert.deepEqual(ledgerTableState(db), { count: 0, latest: null });

  // With no recorded row either side, both fall back to the live amount for every month.
  assert.equal(ledgerCarryover(db, '2026-06', now), 25000);
  assert.equal(screenCarryover(db, '2026-06', now), 25000);
});

// The sync narrates the carryover stage only when this is true. An install that never turned
// rollover on was told about a stage that wrote nothing, every hour.
test('an install with no rollover budget reports nothing to carry over', (t) => {
  const db = setupRolloverDb();
  t.after(() => db.close());

  assert.equal(hasRolloverBudgets(db), true);

  db.prepare(`UPDATE budgets SET rollover = 0 WHERE id = 'budget_food'`).run();
  assert.equal(hasRolloverBudgets(db), false);

  db.prepare(`DELETE FROM budgets`).run();
  assert.equal(hasRolloverBudgets(db), false);
});

// The lookup used to key on the ledger row's `id` while the upsert conflicts on
// (budget_id, month). A row stored under any other id was updated by the writer and missed by the
// reader, so its month silently reverted to the live amount with no error anywhere.
test('a recorded month is honored whatever its row id is', (t) => {
  const db = setupRolloverDb();
  t.after(() => db.close());

  const insertLedgerRow = db.prepare(`
    INSERT INTO budget_rollover_ledger (
      id, budget_id, month, starting_rollover, budget_amount, actual_spend, ending_rollover, calculated_at
    ) VALUES (?, 'budget_food', ?, ?, 50000, ?, ?, '2026-06-15T12:00:00.000Z')
  `);
  insertLedgerRow.run('legacy-april', '2026-04', 0, 45000, 5000);
  insertLedgerRow.run('legacy-may', '2026-05', 5000, 30000, 25000);

  db.prepare(`UPDATE budgets SET amount = 90000 WHERE id = 'budget_food'`).run();
  const now = new Date('2026-06-15T12:00:00.000Z');

  assert.deepEqual(
    ledgerShape(computeBudgetRolloverLedger(db, { budgetId: 'budget_food', month: '2026-06', months: 3, now })),
    [
      { month: '2026-04', starting: 0, budget: 50000, spent: 45000, ending: 5000 },
      { month: '2026-05', starting: 5000, budget: 50000, spent: 30000, ending: 25000 },
      { month: '2026-06', starting: 25000, budget: 90000, spent: 10000, ending: 105000 },
    ]
  );
  assert.equal(screenCarryover(db, '2026-06', now), 25000);

  // And the writer updates those same rows rather than inserting a second April.
  recordBudgetRolloverLedger(db, { budgetId: 'budget_food', now });
  const april = db.prepare(`
    SELECT id, budget_amount FROM budget_rollover_ledger
    WHERE budget_id = 'budget_food' AND month = '2026-04'
  `).all() as Array<{ id: string; budget_amount: number }>;
  assert.deepEqual(april, [{ id: 'legacy-april', budget_amount: 50000 }]);
});

// The advisor is the second writer of budgets.amount. Left unrecorded until the next hourly sync,
// a month that turns over inside that window freezes at the pre-change amount permanently.
test('an advisor budget change records the carryover it just changed', (t) => {
  const db = setupRolloverDb();
  t.after(() => db.close());

  confirmAdvisorDraft(
    db,
    {
      id: 'draft_budget',
      kind: 'update_budget',
      label: 'Raise the Food budget',
      summary: 'Move the Food budget to $900.',
      route: '/budget',
      payload: { kind: 'update_budget', category_id: 'cat_food', amount: 900, period: 'monthly', rollover: true },
      changes: [],
      citations: [],
      confirmation_required: true,
    } as unknown as AdvisorDraftAction,
    true,
    'user_confirm'
  );

  const months = db.prepare(`
    SELECT month, budget_amount FROM budget_rollover_ledger
    WHERE budget_id = 'budget_food' ORDER BY month
  `).all() as Array<{ month: string; budget_amount: number }>;

  // Recorded from the budget's creation month through the month in progress, and the amount the
  // advisor just set is what the open month holds. confirmBudget records against the real clock,
  // so the last month is read from it rather than pinned to a date this test would rot on.
  const openMonth = format(new Date(), 'yyyy-MM');
  assert.equal(months[0]?.month, '2026-04');
  assert.equal(months[months.length - 1]?.month, openMonth);
  assert.equal(months[months.length - 1]?.budget_amount, 90000);
});

test('both carryover walkers agree after a late transaction posts into a closed month', (t) => {
  const db = setupRolloverDb();
  t.after(() => db.close());

  recordBudgetRolloverLedger(db, { now: new Date('2026-06-15T12:00:00.000Z') });
  insertTransaction(db, { date: '2026-04-28', amount: -2500, category_id: 'cat_food' });
  const july = new Date('2026-07-05T12:00:00.000Z');

  // Spend is re-derived on both sides, so the $25 reaches April and shifts every later month.
  assert.equal(ledgerCarryover(db, '2026-07', july), 62500);
  assert.equal(screenCarryover(db, '2026-07', july), 62500);
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

// The projection walked occurrences by chaining addMonths from each previous value, so a bill
// anchored on the 31st drifted to the 28th after the first short month and then fell behind
// "today" three days early, contributing nothing to the month it is actually due in.
test('a month-end bill still counts toward the month it falls in', (t) => {
  const db = setupBudgetDb();
  t.after(() => db.close());

  db.prepare(`
    INSERT INTO recurring_patterns (
      id, merchant_name, category_id, average_amount, frequency, last_seen, next_expected,
      is_active, is_confirmed, transaction_count, created_at, updated_at
    )
    VALUES ('month_end', 'Month End Bill', 'cat_food', 300, 'monthly', '2026-01-31', '2026-01-31',
            1, 1, 4, '2026-01-01', '2026-01-01')
  `).run();

  // Due 2026-03-31. The chained walk put it on 03-28, already behind this "today".
  const food = getMonthlyBudgetsWithProjection(db, 2026, 3, new Date('2026-03-29T12:00:00.000Z'))
    .find((budget) => budget.category_id === 'cat_food');

  assert.equal(food?.expected_recurring, 300);
  assert.equal(food?.forecast_confidence, 'confirmed');
});

// End to end over the real migrations: detection never wrote recurring_patterns.category_id, so
// every detected pattern carried NULL, recurringRows' `rp.category_id IS NOT NULL` filter dropped
// all of them, and expected_recurring was 0 with forecast_confidence 'none' for every budget in
// every month on real data.
test('a budget whose category has a detected pattern projects that pattern', (t) => {
  const db = migratedTestDb();
  _setDbForTesting(db);
  t.after(() => {
    _setDbForTesting(undefined as unknown as Database.Database);
    db.close();
  });

  const today = new Date();
  const thisMonthSeventeenth = new Date(today.getFullYear(), today.getMonth(), 17);
  const anchor = thisMonthSeventeenth > today ? subMonths(thisMonthSeventeenth, 1) : thisMonthSeventeenth;
  const accountId = insertAccount(db);
  for (let back = 5; back >= 0; back--) {
    insertTransaction(db, {
      account_id: accountId,
      date: format(subMonths(anchor, back), 'yyyy-MM-dd'),
      amount: -1803,
      merchant_name: 'Backblaze',
      original_name: 'BACKBLAZE',
      category_id: 'cat_sub_software',
    });
  }

  db.prepare(`
    INSERT INTO budgets (id, category_id, amount, period, rollover, rollover_balance, created_at, updated_at)
    VALUES ('budget_subs', 'cat_subscriptions', 50000, 'monthly', 0, 0, '2026-01-01', '2026-01-01')
  `).run();

  detectRecurring();

  const pattern = db.prepare(
    "SELECT category_id, next_expected FROM recurring_patterns WHERE merchant_name = 'backblaze'"
  ).get() as { category_id: string | null; next_expected: string };
  assert.equal(pattern.category_id, 'cat_sub_software');
  assert.equal(pattern.next_expected, format(addMonths(anchor, 1), 'yyyy-MM-dd'));

  const due = parseISO(pattern.next_expected);
  const budget = getMonthlyBudgetsWithProjection(db, due.getFullYear(), due.getMonth() + 1, today)
    .find((row) => row.category_id === 'cat_subscriptions');

  // The budget is on the parent category; the pattern sits on a child, so this also covers the
  // descendant expansion the projection does.
  assert.equal(budget?.expected_recurring, 1803);
  assert.equal(budget?.forecast_confidence, 'likely');
});
