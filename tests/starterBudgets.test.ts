import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type Database from 'better-sqlite3';
import express from 'express';
import { format, setDate, subMonths } from 'date-fns';
import { detectStarterBudgets } from '../server/src/services/starterBudgets';
import { listDeclinedProposals, restoreDeclinedProposal } from '../server/src/services/advisorDrafts';
import { listOpenDrafts } from '../server/src/services/advisorProposals';
import { runAgentTool } from '../server/src/services/advisorAgentTools';
import { _setDbForTesting } from '../server/src/db/index';
import budgetsRouter from '../server/src/routes/budgets';
import { insertAccount, insertTransaction, migratedTestDb } from './helpers/schema';
import type { StarterBudgetReading } from '../shared/types';

const NOW = new Date();
const monthsAgo = (n: number, day = 15) => format(setDate(subMonths(NOW, n), day), 'yyyy-MM-dd');

/** One row per month, `amounts[0]` twelve months ago and `amounts[11]` last month. */
function ledger(series: Record<string, Array<number | null>>, opts: { history?: number } = {}) {
  const db = migratedTestDb();
  const checking = insertAccount(db, { account_name: 'Checking', type: 'checking' });
  insertTransaction(db, { account_id: checking, date: monthsAgo(opts.history ?? 13, 1), amount: 100000, category_id: 'cat_income_paycheck' });
  for (const [category, amounts] of Object.entries(series)) {
    amounts.forEach((cents, i) => {
      if (cents !== null) insertTransaction(db, { account_id: checking, date: monthsAgo(12 - i), amount: -cents, category_id: category });
    });
  }
  return db;
}

const STEADY = [80000, 81000, 79000, 82000, 120000, 78000, 80500, 79500, 81500, 30000, 80000, 81000];

test('a steady category gets its median rounded to $10, measured over its whole tree', () => {
  // Groceries and restaurants are children of Food & Drink; the starter is offered on the root.
  const db = ledger({ cat_food_groceries: STEADY, cat_food_restaurants: [null, null, null, null, null, null, null, null, null, null, null, 1000] });
  const [food, ...rest] = detectStarterBudgets(db, NOW);
  assert.equal(rest.length, 0);
  assert.equal(food.category_id, 'cat_food');
  assert.equal(food.months.length, 12);
  assert.equal(food.months[11].spent, 82000);
  // Sorted: 30000 78000 79000 79500 80000 80000 80500 81000 81500 82000 82000 120000; median (80000 + 80500) / 2.
  assert.equal(food.median_cents, 80250);
  assert.equal(food.amount_cents, 80000);
  assert.equal(food.months_with_spend, 12);
  assert.equal(food.months_at_or_under, 6);
});

test('a refund month nets down and a month with no rows counts as zero', () => {
  const db = ledger({ cat_transport: [10000, 10000, -2000, 10000, 10000, null, 10000, 10000, 10000, 10000, 10000, 10000] });
  const [transport] = detectStarterBudgets(db, NOW);
  assert.equal(transport.months[2].spent, -2000);
  assert.equal(transport.months[5].spent, 0);
  assert.equal(transport.months_with_spend, 10);
  assert.equal(transport.amount_cents, 10000);
});

test('silent: occasional spending, a short ledger, an existing budget, transfers and income', () => {
  const twoMonths = [null, null, null, 50000, null, null, null, null, 25000, null, null, null];
  assert.deepEqual(detectStarterBudgets(ledger({ cat_home: twoMonths }), NOW), []);
  assert.deepEqual(detectStarterBudgets(ledger({ cat_food_groceries: [...STEADY.slice(0, 8), null, null, null, null] }), NOW), []);
  // Eleven months of history, so the twelve-month window is not covered.
  assert.deepEqual(detectStarterBudgets(ledger({ cat_food_groceries: [null, ...STEADY.slice(1)] }, { history: 11 }), NOW), []);

  const budgeted = ledger({ cat_food_groceries: STEADY });
  budgeted.prepare("INSERT INTO budgets (id, category_id, amount, period, rollover, rollover_balance, created_at, updated_at) VALUES ('b1', 'cat_food_groceries', 50000, 'monthly', 0, 0, 'x', 'x')").run();
  assert.deepEqual(detectStarterBudgets(budgeted, NOW), [], 'a budget on a child covers the root');

  assert.deepEqual(detectStarterBudgets(ledger({ cat_xfer_out: STEADY, cat_inv_buy: STEADY }), NOW), []);
  assert.deepEqual(detectStarterBudgets(ledger({ cat_income_other: STEADY.map((c) => -c) }), NOW), []);
});

async function withRouter(db: Database.Database, fn: (base: string) => Promise<void>): Promise<void> {
  _setDbForTesting(db);
  const app = express();
  app.use(express.json());
  app.use('/api/budgets', budgetsRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no server address');
    await fn(`http://127.0.0.1:${addr.port}/api/budgets/starter`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    _setDbForTesting(null);
    db.close();
  }
}

const post = (base: string, body: unknown) =>
  fetch(`${base}/decide`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const list = async (base: string) => ((await (await fetch(base)).json()) as { data: StarterBudgetReading[] }).data;

test('dismissing a starter keeps it gone, lists the decline, and restoring it brings it back', async () => {
  const db = ledger({ cat_food_groceries: STEADY, cat_transport: STEADY });
  await withRouter(db, async (base) => {
    const before = await list(base);
    assert.deepEqual(before.map((s) => [s.category_id, s.amount]), [['cat_food', 800], ['cat_transport', 800]]);
    assert.equal((await post(base, { category_id: 'cat_food', decision: 'dismiss' })).status, 200);
    assert.deepEqual((await list(base)).map((s) => s.category_id), ['cat_transport']);
    assert.equal((await post(base, { category_id: 'cat_food', decision: 'add' })).status, 409);

    const [declined] = listDeclinedProposals(db).filter((d) => d.kind === 'update_budget');
    assert.match(declined.summary ?? '', /^Food & Drink, \$800\.00 a month: the median of 12 complete months, \$802\.50, rounded to \$10\. Spending was at or under it in 6 of 12\./);
    restoreDeclinedProposal(db, declined.id);
    assert.deepEqual((await list(base)).map((s) => s.category_id), ['cat_food', 'cat_transport']);
  });
});

test('adding a starter writes the budget it showed, without rollover, and it stops being offered', async () => {
  const db = ledger({ cat_food_groceries: STEADY });
  await withRouter(db, async (base) => {
    assert.equal((await post(base, { category_id: 'cat_food', decision: 'add' })).status, 200);
    const row = db.prepare("SELECT amount, period, rollover FROM budgets WHERE category_id = 'cat_food'").get();
    assert.deepEqual({ ...(row as object) }, { amount: 80000, period: 'monthly', rollover: 0 });
    assert.deepEqual(await list(base), []);
    const action = db.prepare("SELECT kind, source FROM advisor_actions ORDER BY created_at DESC LIMIT 1").get() as { kind: string; source: string };
    assert.equal(action.kind, 'update_budget');
  });
});

test('a restored decline at an old median does not outlive the starter added at the new one', async () => {
  const db = ledger({ cat_food_groceries: STEADY });
  await withRouter(db, async (base) => {
    assert.equal((await post(base, { category_id: 'cat_food', decision: 'dismiss' })).status, 200);
    const [declined] = listDeclinedProposals(db).filter((d) => d.kind === 'update_budget');
    assert.deepEqual(restoreDeclinedProposal(db, declined.id), { ok: true, draft_reopened: true, queued: true });
    const old = db.prepare("SELECT id FROM advisor_drafts WHERE status = 'open'").get() as { id: string };

    // Spending rose while the decline stood, so the starter now offers more than the reopened draft.
    db.prepare("UPDATE transactions SET amount = amount - 5000 WHERE category_id = 'cat_food_groceries'").run();
    const [starter] = await list(base);
    assert.equal(starter.amount, 850);
    assert.equal((await post(base, { category_id: 'cat_food', decision: 'add' })).status, 200);

    assert.equal((db.prepare("SELECT amount FROM budgets WHERE category_id = 'cat_food'").get() as { amount: number }).amount, 85000);
    assert.equal((db.prepare('SELECT status FROM advisor_drafts WHERE id = ?').get(old.id) as { status: string }).status, 'superseded');
    assert.deepEqual(listOpenDrafts(db), []);
  });
});

test('HEALTHY: a restored decline at the same median is the draft the starter adds', async () => {
  const db = ledger({ cat_food_groceries: STEADY });
  await withRouter(db, async (base) => {
    assert.equal((await post(base, { category_id: 'cat_food', decision: 'dismiss' })).status, 200);
    const [declined] = listDeclinedProposals(db).filter((d) => d.kind === 'update_budget');
    restoreDeclinedProposal(db, declined.id);
    assert.equal(listOpenDrafts(db).length, 1, 'the reopened draft is listed while nothing has been written');
    assert.equal((await post(base, { category_id: 'cat_food', decision: 'add' })).status, 200);
    const statuses = db.prepare('SELECT status FROM advisor_drafts').all() as Array<{ status: string }>;
    assert.deepEqual(statuses.map((r) => r.status), ['confirmed']);
  });
});

test('the advisor reads the same starters in dollars', () => {
  const db = ledger({ cat_food_groceries: STEADY });
  const read = runAgentTool(db, 'get_starter_budgets', {}) as StarterBudgetReading[];
  assert.equal(read[0].amount, 800);
  assert.equal(read[0].median, 802.5);
  assert.equal(read[0].months[11].spent, 810);
});
