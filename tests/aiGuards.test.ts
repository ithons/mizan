import test from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { addDays, differenceInCalendarDays, format, parseISO, subDays } from 'date-fns';
import {
  SCHEDULED_FORECAST_DAYS,
  captureHeadlines,
  diffHeadlines,
  listAiIncidents,
  runGuardedCategoryBatch,
  type HeadlineSnapshot,
} from '../server/src/services/aiGuards';
import { writeTransactionCategories } from '../server/src/services/categoryWrites';
import { buildRecurringForecast } from '../server/src/services/recurringForecast';
import {
  TEST_NOW,
  insertAccount,
  insertAdvisorAction,
  insertTransaction,
  migratedTestDb,
} from './helpers/schema';

/**
 * The whole test of this design is the healthy side. A guard that only proves it detects a defect is
 * the guard this codebase has shipped and deleted twice: `direction_conflict` alarmed on any
 * brokerage deposit during a down month, and the first `flowConservation` predicate fired on a
 * payday split. Every pass below that a real autonomous worker could produce is asserted SILENT,
 * including the two that legitimately move the month's totals.
 */

const MONTH = '2026-07';

interface Fixture {
  db: Database.Database;
  accountId: string;
}

function fixture(): Fixture {
  const db = migratedTestDb();
  const accountId = insertAccount(db, { current_balance: 500_000, type: 'checking' });
  return { db, accountId };
}

/** A settled expense row inside the guarded month. `amount` is cents, negative for spend. */
function spendRow(
  fx: Fixture,
  overrides: { id?: string; amount?: number; date?: string; category_id?: string | null } = {}
): string {
  return insertTransaction(fx.db, {
    account_id: fx.accountId,
    date: overrides.date ?? '2026-07-10',
    amount: overrides.amount ?? -2_500,
    category_id: overrides.category_id ?? null,
    id: overrides.id,
  });
}

/** Apply an autonomous categorization the way the confirm path does: one action id over N rows. */
function categorize(
  db: Database.Database,
  actionId: string,
  writes: Array<{ id: string; categoryId: string | null }>
): number {
  return writeTransactionCategories(
    db,
    writes.map((write) => ({
      transactionId: write.id,
      categoryId: write.categoryId,
      source: 'ai' as const,
      actionId,
      reviewStatus: 'reviewed' as const,
    }))
  );
}

const GUARD_NOW = '2026-07-31T09:00:00.000Z';

function guarded(db: Database.Database, run: () => { actionIds: string[] }, now: string = GUARD_NOW) {
  return runGuardedCategoryBatch(
    db,
    {
      name: 'worker_autonomous_pass',
      run: () => {
        const { actionIds } = run();
        return { value: actionIds.length, actionIds };
      },
    },
    { month: MONTH, now }
  );
}

/**
 * A confirmed recurring pattern the forecast will emit, dated relative to the pinned anchor.
 *
 * `average_amount` is cents and the sign comes from the category, so an uncategorized pattern is a
 * bill. No linked transactions, so the forecast falls back to this amount.
 */
function insertRecurringPattern(
  db: Database.Database,
  overrides: { id?: string; nextExpected: string; averageAmount: number }
): string {
  const id = overrides.id ?? 'rp_test';
  db.prepare(`
    INSERT INTO recurring_patterns
      (id, merchant_name, category_id, average_amount, frequency, last_seen, next_expected,
       is_active, is_confirmed, transaction_count, amount_variance, created_at, updated_at)
    VALUES (?, ?, NULL, ?, 'annual', ?, ?, 1, 1, 4, 0, ?, ?)
  `).run(
    id,
    `merchant ${id}`,
    overrides.averageAmount,
    overrides.nextExpected,
    overrides.nextExpected,
    TEST_NOW,
    TEST_NOW
  );
  return id;
}

// ── Silence on ordinary autonomous passes ─────────────────────────────────────

test('categorizing six uncategorized rows breaches nothing, reverts nothing and writes no incident', (t) => {
  const fx = fixture();
  t.after(() => fx.db.close());

  const rows = [
    spendRow(fx, { amount: -1_250 }),
    spendRow(fx, { amount: -3_499 }),
    spendRow(fx, { amount: -899 }),
    spendRow(fx, { amount: -14_000 }),
    spendRow(fx, { amount: -2_075 }),
    spendRow(fx, { amount: -640 }),
  ];
  const categories = ['cat_food', 'cat_food', 'cat_shop', 'cat_home', 'cat_transport', 'cat_pets'];
  const actionId = insertAdvisorAction(fx.db);

  const report = guarded(fx.db, () => {
    categorize(fx.db, actionId, rows.map((id, index) => ({ id, categoryId: categories[index] })));
    return { actionIds: [actionId] };
  });

  assert.equal(report.status, 'clean');
  assert.deepEqual(report.breaches, []);
  assert.equal(report.incident_id, null);
  assert.equal(report.reverted_rows, 0);
  assert.equal(listAiIncidents(fx.db).length, 0);

  // The conservation property itself: the magnitude did not move while the filing did.
  assert.equal(report.after.month_spend_cents, report.before.month_spend_cents);
  assert.equal(report.after.month_income_cents, report.before.month_income_cents);
  assert.equal(report.after.savings_rate_percent, report.before.savings_rate_percent);
  assert.ok(report.category_moves.length > 0, 'per-category totals must move: that is what the pass is for');
});

test('filing a row into a transfer category is silent even though the month spend drops', (t) => {
  const fx = fixture();
  t.after(() => fx.db.close());

  const transferRow = spendRow(fx, { amount: -50_000 });
  spendRow(fx, { amount: -2_500, category_id: 'cat_food' });
  const actionId = insertAdvisorAction(fx.db);

  const report = guarded(fx.db, () => {
    categorize(fx.db, actionId, [{ id: transferRow, categoryId: 'cat_xfer_out' }]);
    return { actionIds: [actionId] };
  });

  assert.equal(report.status, 'clean');
  assert.deepEqual(report.breaches, []);
  assert.equal(listAiIncidents(fx.db).length, 0);
  // cat_xfer is outside report scope, so the $500 leaves spend. Legitimate, and accounted for.
  assert.equal(report.before.month_spend_cents, 52_500);
  assert.equal(report.after.month_spend_cents, 2_500);
});

test('filing a row across the income boundary is silent even though income and spend both move', (t) => {
  const fx = fixture();
  t.after(() => fx.db.close());

  const paycheck = insertTransaction(fx.db, {
    account_id: fx.accountId,
    date: '2026-07-15',
    amount: 250_000,
    category_id: 'cat_shop',
  });
  const actionId = insertAdvisorAction(fx.db);

  const before = captureHeadlines(fx.db, { month: MONTH });
  assert.equal(before.month_spend_cents, -250_000, 'a positive row in an expense category nets that category down');
  assert.equal(before.month_income_cents, 0);

  const report = guarded(fx.db, () => {
    categorize(fx.db, actionId, [{ id: paycheck, categoryId: 'cat_income_paycheck' }]);
    return { actionIds: [actionId] };
  });

  assert.equal(report.status, 'clean');
  assert.deepEqual(report.breaches, []);
  assert.equal(report.after.month_spend_cents, 0);
  assert.equal(report.after.month_income_cents, 250_000);
  assert.equal(listAiIncidents(fx.db).length, 0);
});

test('pulling a row back OUT of an excluded root is silent, and raises spend', (t) => {
  const fx = fixture();
  t.after(() => fx.db.close());

  const misfiled = spendRow(fx, { amount: -8_000, category_id: 'cat_inv_transfer' });
  const actionId = insertAdvisorAction(fx.db);

  const report = guarded(fx.db, () => {
    categorize(fx.db, actionId, [{ id: misfiled, categoryId: 'cat_shop' }]);
    return { actionIds: [actionId] };
  });

  assert.equal(report.status, 'clean');
  assert.deepEqual(report.breaches, []);
  assert.equal(report.before.month_spend_cents, 0);
  assert.equal(report.after.month_spend_cents, 8_000);
  assert.equal(listAiIncidents(fx.db).length, 0);
});

test('a merchant-rule sweep across two actions and many rows is silent', (t) => {
  const fx = fixture();
  t.after(() => fx.db.close());

  const swept = Array.from({ length: 9 }, (_, index) =>
    spendRow(fx, { amount: -1_099 - index, date: `2026-07-0${(index % 9) + 1}` })
  );
  const ruleAction = insertAdvisorAction(fx.db, { kind: 'create_merchant_rule' });
  const categorizeAction = insertAdvisorAction(fx.db);

  const report = guarded(fx.db, () => {
    categorize(fx.db, ruleAction, swept.slice(0, 6).map((id) => ({ id, categoryId: 'cat_subscriptions' })));
    categorize(fx.db, categorizeAction, swept.slice(6).map((id) => ({ id, categoryId: 'cat_food' })));
    return { actionIds: [ruleAction, categorizeAction] };
  });

  assert.equal(report.status, 'clean');
  assert.deepEqual(report.breaches, []);
  assert.equal(report.after.month_spend_cents, report.before.month_spend_cents);
  assert.equal(listAiIncidents(fx.db).length, 0);
});

test('rewriting rows in another month is silent, and moves no headline', (t) => {
  const fx = fixture();
  t.after(() => fx.db.close());

  const march = spendRow(fx, { amount: -12_000, date: '2026-03-04' });
  spendRow(fx, { amount: -2_500, category_id: 'cat_food' });
  const actionId = insertAdvisorAction(fx.db);

  const report = guarded(fx.db, () => {
    categorize(fx.db, actionId, [{ id: march, categoryId: 'cat_xfer_out' }]);
    return { actionIds: [actionId] };
  });

  assert.equal(report.status, 'clean');
  assert.deepEqual(report.category_moves, []);
  assert.equal(listAiIncidents(fx.db).length, 0);
});

test('a pass that finds nothing to do is silent', (t) => {
  const fx = fixture();
  t.after(() => fx.db.close());
  spendRow(fx, { amount: -2_500, category_id: 'cat_food' });

  const report = guarded(fx.db, () => ({ actionIds: [] }));

  assert.equal(report.status, 'clean');
  assert.deepEqual(report.breaches, []);
  assert.deepEqual(report.action_ids, []);
  assert.equal(listAiIncidents(fx.db).length, 0);
});

test('filing a refund beside its purchase is silent, though it crosses the income boundary inward', (t) => {
  const fx = fixture();
  t.after(() => fx.db.close());

  // An uncategorized positive row counts as income because there is no category to ask. Filing it
  // into the expense category it belongs to nets that category down instead, which moves BOTH
  // totals: this is the shape that made Reports drop $2,054.24 once, and it must be silent here.
  const refund = insertTransaction(fx.db, {
    account_id: fx.accountId,
    date: '2026-07-19',
    amount: 95_519,
  });
  const purchase = spendRow(fx, { amount: -123_595 });
  const actionId = insertAdvisorAction(fx.db);

  const report = guarded(fx.db, () => {
    categorize(fx.db, actionId, [
      { id: refund, categoryId: 'cat_shop' },
      { id: purchase, categoryId: 'cat_shop' },
    ]);
    return { actionIds: [actionId] };
  });

  assert.equal(report.status, 'clean');
  assert.deepEqual(report.breaches, []);
  assert.equal(report.before.month_income_cents, 95_519);
  assert.equal(report.after.month_income_cents, 0);
  assert.equal(report.before.month_spend_cents, 123_595);
  assert.equal(report.after.month_spend_cents, 28_076);
  assert.equal(listAiIncidents(fx.db).length, 0);
});

// ── Breaches ──────────────────────────────────────────────────────────────────

test('a batch that changes an amount as well as a category breaches and is taken back', (t) => {
  const fx = fixture();
  t.after(() => fx.db.close());

  const row = spendRow(fx, { amount: -2_500 });
  const actionId = insertAdvisorAction(fx.db);

  const report = guarded(fx.db, () => {
    categorize(fx.db, actionId, [{ id: row, categoryId: 'cat_food' }]);
    fx.db.prepare('UPDATE transactions SET amount = ? WHERE id = ?').run(-9_900, row);
    return { actionIds: [actionId] };
  });

  assert.equal(report.status, 'reverted');
  assert.equal(report.reverted_rows, 1);
  assert.equal(report.headlines_restored, false, 'a reverted category cannot take back a rewritten amount');

  const shape = report.breaches.find((breach) => breach.headline === 'ledger_shape');
  assert.ok(shape, 'the amount rewrite is the structural finding');
  assert.match(shape.detail, /changed amount from -2500 to -9900 cents/);

  const spend = report.breaches.find((breach) => breach.headline === 'month_spend');
  assert.ok(spend, 'and it is quantified against the headline');
  assert.equal(spend.moved, 7_400);
  assert.equal(spend.explained, 0);

  // The category is back where it started even though the amount is not.
  const after = fx.db.prepare('SELECT category_id, category_source FROM transactions WHERE id = ?').get(row);
  assert.deepEqual(after, { category_id: null, category_source: null });
});

test('an incident row survives the revert and records what moved and what was undone', (t) => {
  const fx = fixture();
  t.after(() => fx.db.close());

  const row = spendRow(fx, { amount: -2_500 });
  const actionId = insertAdvisorAction(fx.db);

  const report = guarded(fx.db, () => {
    categorize(fx.db, actionId, [{ id: row, categoryId: 'cat_food' }]);
    fx.db.prepare('UPDATE transactions SET amount = ? WHERE id = ?').run(-9_900, row);
    return { actionIds: [actionId] };
  });

  const incidents = listAiIncidents(fx.db);
  assert.equal(incidents.length, 1);
  const incident = incidents[0];
  assert.equal(incident.id, report.incident_id);
  assert.equal(incident.batch_name, 'worker_autonomous_pass');
  assert.equal(incident.month, MONTH);
  assert.equal(incident.revert_status, 'reverted');
  assert.equal(incident.reverted_rows, 1);
  assert.equal(incident.headlines_restored, 0);
  assert.ok(incident.revert_error && incident.revert_error.length > 0, 'a residual movement is named, not swallowed');
  assert.deepEqual(JSON.parse(incident.action_ids), [actionId]);
  assert.deepEqual(JSON.parse(incident.reverted_action_ids ?? 'null'), [actionId]);

  // The evidence outlives the revert: both headline sets are on the row.
  const before = JSON.parse(incident.before_headlines) as HeadlineSnapshot;
  const after = JSON.parse(incident.after_headlines) as HeadlineSnapshot;
  assert.equal(before.month_spend_cents, 2_500);
  assert.equal(after.month_spend_cents, 9_900);
});

test('a category write with no action id blocks the revert rather than half-undoing the batch', (t) => {
  const fx = fixture();
  t.after(() => fx.db.close());

  const tracked = spendRow(fx, { amount: -2_500 });
  const untracked = spendRow(fx, { amount: -4_000 });
  const actionId = insertAdvisorAction(fx.db);

  const report = guarded(fx.db, () => {
    categorize(fx.db, actionId, [{ id: tracked, categoryId: 'cat_food' }]);
    // No action id: nothing this harness can revert, which is the whole reason it refuses.
    writeTransactionCategories(fx.db, [{ transactionId: untracked, categoryId: 'cat_xfer_out', source: 'ai' }]);
    fx.db.prepare('UPDATE transactions SET amount = ? WHERE id = ?').run(-9_900, tracked);
    return { actionIds: [actionId] };
  });

  assert.equal(report.status, 'revert_failed');
  assert.equal(report.unrevertable_rows, 1);
  assert.equal(report.reverted_rows, 0);

  const incident = listAiIncidents(fx.db)[0];
  assert.equal(incident.revert_status, 'failed');
  assert.equal(incident.unrevertable_rows, 1);
  assert.match(incident.revert_error ?? '', /no action id/);

  // Nothing was undone: a partial revert is never entered, so the batch is left whole and visible.
  const still = fx.db.prepare('SELECT category_id FROM transactions WHERE id = ?').get(tracked);
  assert.deepEqual(still, { category_id: 'cat_food' });
});

test('a row inserted into the window is a breach a per-row check would not see', (t) => {
  const fx = fixture();
  t.after(() => fx.db.close());

  const row = spendRow(fx, { amount: -2_500 });
  const actionId = insertAdvisorAction(fx.db);

  const report = guarded(fx.db, () => {
    categorize(fx.db, actionId, [{ id: row, categoryId: 'cat_food' }]);
    spendRow(fx, { id: 'txn_injected', amount: -77_700, category_id: 'cat_food' });
    return { actionIds: [actionId] };
  });

  assert.equal(report.status, 'reverted');
  const shape = report.breaches.find((breach) => breach.headline === 'ledger_shape');
  assert.ok(shape);
  assert.match(shape.detail, /txn_injected entered the window/);
});

test('a category re-parented under Transfers breaches without any row being rewritten', (t) => {
  const fx = fixture();
  t.after(() => fx.db.close());

  spendRow(fx, { amount: -30_000, category_id: 'cat_pets' });

  // Re-parenting is inside the owner's proposal-only carve-out. If it ever happens autonomously it
  // silently empties a month of spending, and no per-row check sees a thing.
  const report = guarded(fx.db, () => {
    fx.db.prepare("UPDATE categories SET parent_id = 'cat_xfer' WHERE id = 'cat_pets'").run();
    return { actionIds: [] };
  });

  assert.equal(report.status, 'revert_failed', 'there is no action id to revert, so the batch stands and is recorded');
  const shape = report.breaches.find((breach) => breach.headline === 'ledger_shape');
  assert.ok(shape);
  assert.match(shape.detail, /without its category changing/);
  assert.equal(report.before.month_spend_cents, 30_000);
  assert.equal(report.after.month_spend_cents, 0);

  const incident = listAiIncidents(fx.db)[0];
  assert.equal(incident.revert_status, 'failed');
  assert.match(incident.revert_error ?? '', /no advisor action/);
});

test('net worth is invariant under a category batch and a movement is a breach', (t) => {
  const fx = fixture();
  t.after(() => fx.db.close());

  fx.db.prepare(`
    INSERT INTO net_worth_snapshots
      (id, date, total_assets, total_liabilities, net_worth, breakdown, is_estimated, created_at)
    VALUES ('nw1', '2026-07-30', 500000, 0, 500000, '{}', 0, '2026-07-30T00:00:00.000Z')
  `).run();

  const row = spendRow(fx, { amount: -2_500 });
  const actionId = insertAdvisorAction(fx.db);

  const report = guarded(fx.db, () => {
    categorize(fx.db, actionId, [{ id: row, categoryId: 'cat_food' }]);
    fx.db.prepare("UPDATE net_worth_snapshots SET net_worth = 400000 WHERE id = 'nw1'").run();
    return { actionIds: [actionId] };
  });

  const netWorth = report.breaches.find((breach) => breach.headline === 'net_worth');
  assert.ok(netWorth);
  assert.equal(netWorth.policy, 'invariant');
  assert.equal(netWorth.before, 500_000);
  assert.equal(netWorth.after, 400_000);
  assert.equal(netWorth.moved, -100_000);
});

// ── The movement policy itself ────────────────────────────────────────────────

function snapshot(overrides: Partial<HeadlineSnapshot> = {}): HeadlineSnapshot {
  return {
    month: MONTH,
    start_date: '2026-07-01',
    end_date: '2026-07-31',
    net_worth_cents: 378_723,
    month_spend_cents: 78_222,
    month_income_cents: 217_122,
    savings_rate_percent: 63.97,
    scheduled_net_cents: -12_000,
    scheduled_forecast_start: '2026-07-31',
    scheduled_forecast_end: '2026-09-29',
    scheduled_forecast_days: 60,
    category_totals_cents: {},
    ...overrides,
  };
}

test('a spend movement matched to the cent by the rewrites is not a breach', () => {
  const before = snapshot();
  const after = snapshot({ month_spend_cents: 28_222, savings_rate_percent: 87.0 });
  assert.deepEqual(diffHeadlines(before, after, { spend: -50_000, income: 0 }), []);
});

test('a spend movement one cent wider than the rewrites explain is a breach', () => {
  const before = snapshot();
  const after = snapshot({ month_spend_cents: 28_221, savings_rate_percent: 87.0 });
  const breaches = diffHeadlines(before, after, { spend: -50_000, income: 0 });
  assert.equal(breaches.length, 1);
  assert.equal(breaches[0].headline, 'month_spend');
  assert.equal(breaches[0].moved, -50_001);
  assert.equal(breaches[0].explained, -50_000);
});

test('the savings rate may move when spend moved, and may not move on its own', () => {
  const moved = diffHeadlines(
    snapshot(),
    snapshot({ month_spend_cents: 28_222, savings_rate_percent: 87.0 }),
    { spend: -50_000, income: 0 }
  );
  assert.deepEqual(moved, []);

  const alone = diffHeadlines(snapshot(), snapshot({ savings_rate_percent: 12.5 }), { spend: 0, income: 0 });
  assert.equal(alone.length, 1);
  assert.equal(alone[0].headline, 'savings_rate');
  assert.equal(alone[0].unit, 'percent');
});

test('a null savings rate on both sides is not a movement', () => {
  const before = snapshot({ month_income_cents: 0, savings_rate_percent: null });
  const after = snapshot({ month_income_cents: 0, savings_rate_percent: null });
  assert.deepEqual(diffHeadlines(before, after, { spend: 0, income: 0 }), []);
});

test('two headline sets over different forecast windows are refused, not compared', () => {
  const before = snapshot();
  const after = snapshot({ scheduled_forecast_start: '2026-08-01', scheduled_forecast_end: '2026-09-30' });
  assert.throws(
    () => diffHeadlines(before, after, { spend: 0, income: 0 }),
    /different forecast windows/
  );
});

// ── The pinned forecast window ────────────────────────────────────────────────

test('both captures read one pinned forecast window, so a clock tick cannot move the headline', (t) => {
  const fx = fixture();
  t.after(() => fx.db.close());

  const row = spendRow(fx, { amount: -2_500 });
  const actionId = insertAdvisorAction(fx.db);

  const report = guarded(fx.db, () => {
    categorize(fx.db, actionId, [{ id: row, categoryId: 'cat_food' }]);
    return { actionIds: [actionId] };
  });

  assert.equal(report.status, 'clean');
  assert.equal(report.before.scheduled_forecast_start, report.after.scheduled_forecast_start);
  assert.equal(report.before.scheduled_forecast_end, report.after.scheduled_forecast_end);
  assert.equal(
    differenceInCalendarDays(
      parseISO(report.before.scheduled_forecast_end),
      parseISO(report.before.scheduled_forecast_start)
    ),
    60,
    'the pinned window is the 60 days the headline claims to cover'
  );
});

test('an ordinary pass is silent while a live recurring forecast sits in the pinned window', (t) => {
  const fx = fixture();
  t.after(() => fx.db.close());

  // Anchored on the real clock so the pinned window and the forecast service cover the same days,
  // which is what the production caller does. A fixed `now` would drift out of the service's window.
  const now = new Date();
  insertRecurringPattern(fx.db, {
    nextExpected: format(addDays(now, 5), 'yyyy-MM-dd'),
    averageAmount: 4_200,
  });

  const row = spendRow(fx, { amount: -2_500 });
  const actionId = insertAdvisorAction(fx.db);

  const report = guarded(
    fx.db,
    () => {
      categorize(fx.db, actionId, [{ id: row, categoryId: 'cat_food' }]);
      return { actionIds: [actionId] };
    },
    now.toISOString()
  );

  assert.equal(report.status, 'clean');
  assert.deepEqual(report.breaches, []);
  assert.equal(report.before.scheduled_net_cents, -4_200, 'the bill is inside the window and counted');
  assert.equal(report.after.scheduled_net_cents, -4_200);
  assert.equal(listAiIncidents(fx.db).length, 0);
});

test('an occurrence past the pinned end is dropped even though the forecast service reaches it', (t) => {
  const fx = fixture();
  t.after(() => fx.db.close());

  const now = new Date();
  insertRecurringPattern(fx.db, {
    nextExpected: format(addDays(now, SCHEDULED_FORECAST_DAYS), 'yyyy-MM-dd'),
    averageAmount: 4_200,
  });

  // The service resolves its own window from the clock, so it emits this occurrence.
  assert.equal(buildRecurringForecast(fx.db, SCHEDULED_FORECAST_DAYS).net, -4_200);

  // A capture pinned one day earlier drops it, because the pin and not the clock decides the end.
  // That is the mechanism: a pass whose second capture lands after local midnight sees the service's
  // window reach one day further, and the pin cuts it back to the days the first capture asked about.
  const pinned = captureHeadlines(fx.db, {
    month: MONTH,
    forecastAnchor: format(subDays(now, 1), 'yyyy-MM-dd'),
  });
  assert.equal(pinned.scheduled_forecast_end, format(addDays(now, SCHEDULED_FORECAST_DAYS - 1), 'yyyy-MM-dd'));
  assert.equal(pinned.scheduled_net_cents, 0);
});

test('a batch that moves a recurring amount still breaches the pinned scheduled net', (t) => {
  const fx = fixture();
  t.after(() => fx.db.close());

  const now = new Date();
  const patternId = insertRecurringPattern(fx.db, {
    nextExpected: format(addDays(now, 5), 'yyyy-MM-dd'),
    averageAmount: 4_200,
  });

  const row = spendRow(fx, { amount: -2_500 });
  const actionId = insertAdvisorAction(fx.db);

  const report = guarded(
    fx.db,
    () => {
      categorize(fx.db, actionId, [{ id: row, categoryId: 'cat_food' }]);
      fx.db.prepare('UPDATE recurring_patterns SET average_amount = ? WHERE id = ?').run(9_900, patternId);
      return { actionIds: [actionId] };
    },
    now.toISOString()
  );

  const scheduled = report.breaches.find((breach) => breach.headline === 'scheduled_net');
  assert.ok(scheduled, 'pinning the window must not make the invariant vacuous');
  assert.equal(scheduled.policy, 'invariant');
  assert.equal(scheduled.before, -4_200);
  assert.equal(scheduled.after, -9_900);
  assert.match(scheduled.detail, /pinned across both captures/);
});

// ── The revert underneath the guard ───────────────────────────────────────────

/**
 * One breaching batch, two actions writing the same transaction in sequence, and the ids supplied by
 * discovery rather than by the caller. That is the `confirmAdvisorDraft` shape: it returns no action
 * id, so the harness reads them out of `advisor_actions`, which is scanned by primary key and hands
 * them back sorted by uuid. Reverting a uuid sort cannot unbury a stack.
 */
function stackedBatch(firstId: string, secondId: string) {
  const fx = fixture();
  const row = spendRow(fx, { amount: -2_500 });

  const report = guarded(fx.db, () => {
    const first = insertAdvisorAction(fx.db, { id: firstId });
    const second = insertAdvisorAction(fx.db, { id: secondId });
    categorize(fx.db, first, [{ id: row, categoryId: 'cat_food' }]);
    categorize(fx.db, second, [{ id: row, categoryId: 'cat_shop' }]);
    fx.db.prepare('UPDATE transactions SET amount = ? WHERE id = ?').run(-9_900, row);
    return { actionIds: [] };
  });

  const settled = fx.db
    .prepare('SELECT category_id, category_source FROM transactions WHERE id = ?')
    .get(row) as { category_id: string | null; category_source: string | null };
  return { fx, report, settled };
}

test('a batch whose action ids sort adversarially still reverts completely', (t) => {
  // 'aa_action' is created second and sits on top of the stack, so a uuid sort reverts the wrong one
  // first, finds the other buried, and rolls the whole undo back.
  const { fx, report, settled } = stackedBatch('zz_action', 'aa_action');
  t.after(() => fx.db.close());

  assert.equal(report.status, 'reverted');
  assert.equal(report.reverted_rows, 2, 'both writes to the row are taken back, not just the newest');
  assert.equal(report.unrevertable_rows, 0);
  assert.deepEqual(settled, { category_id: null, category_source: null });
  assert.deepEqual(report.action_ids, ['zz_action', 'aa_action'], 'reported in creation order');

  const incident = listAiIncidents(fx.db)[0];
  assert.equal(incident.revert_status, 'reverted');
  assert.equal(incident.reverted_rows, 2);
});

test('two batches differing only in which action id sorts first behave identically', (t) => {
  const ascending = stackedBatch('aa_first', 'zz_second');
  const descending = stackedBatch('zz_first', 'aa_second');
  t.after(() => {
    ascending.fx.db.close();
    descending.fx.db.close();
  });

  assert.equal(ascending.report.status, descending.report.status);
  assert.equal(ascending.report.status, 'reverted');
  assert.equal(ascending.report.reverted_rows, descending.report.reverted_rows);
  assert.equal(ascending.report.unrevertable_rows, descending.report.unrevertable_rows);
  assert.equal(ascending.report.headlines_restored, descending.report.headlines_restored);
  assert.deepEqual(ascending.settled, descending.settled);
  assert.deepEqual(ascending.settled, { category_id: null, category_source: null });
  assert.deepEqual(
    ascending.report.breaches.map((breach) => breach.headline),
    descending.report.breaches.map((breach) => breach.headline)
  );
});

test('an action that wrote the same transaction twice is reverted all the way back', (t) => {
  const fx = fixture();
  t.after(() => fx.db.close());

  const row = spendRow(fx, { amount: -2_500 });
  const untouched = spendRow(fx, { amount: -1_000, category_id: 'cat_pets' });
  const actionId = insertAdvisorAction(fx.db);

  // One action, two writes to one row. Only the newer revision is revertable, so a single
  // revertAction per id leaves the older one standing and the whole undo rolls back.
  const report = guarded(fx.db, () => {
    categorize(fx.db, actionId, [{ id: row, categoryId: 'cat_food' }]);
    categorize(fx.db, actionId, [{ id: row, categoryId: 'cat_shop' }]);
    fx.db.prepare('UPDATE transactions SET amount = ? WHERE id = ?').run(-9_900, row);
    return { actionIds: [actionId] };
  });

  assert.equal(report.status, 'reverted');
  assert.equal(report.reverted_rows, 2);
  assert.equal(report.unrevertable_rows, 0);

  const settled = fx.db.prepare('SELECT category_id, category_source FROM transactions WHERE id = ?').get(row);
  assert.deepEqual(settled, { category_id: null, category_source: null });
  // The revert reaches the batch's writes and stops there.
  const bystander = fx.db.prepare('SELECT category_id FROM transactions WHERE id = ?').get(untouched);
  assert.deepEqual(bystander, { category_id: 'cat_pets' });

  const standing = fx.db.prepare(`
    SELECT COUNT(*) AS count FROM transaction_category_revisions
    WHERE revert_of IS NULL AND reverted_at IS NULL
  `).get() as { count: number };
  assert.equal(standing.count, 0, 'no write the batch made is left standing');
});

test('the guard refuses to run inside an open transaction', (t) => {
  const fx = fixture();
  t.after(() => fx.db.close());

  const run = fx.db.transaction(() => {
    runGuardedCategoryBatch(fx.db, { name: 'nested', run: () => ({ value: 0 }) }, { month: MONTH });
  });

  assert.throws(run, /must not be called inside an open transaction/);
});
