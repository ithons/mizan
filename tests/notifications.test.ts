import test from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import {
  migratedTestDb,
  insertAccount,
  insertCategory,
  insertTransaction,
  dayInThisMonth,
  localToday,
  localDaysFromToday,
  TEST_NOW,
} from './helpers/schema';
import {
  deleteNotificationRule,
  dismissNotification,
  evaluateNotifications,
  listNotificationRules,
  listNotifications,
  markNotificationsRead,
  setNotificationRuleEnabled,
  unreadCount,
  upsertNotificationRule,
  type UpsertNotificationRuleInput,
} from '../server/src/services/notifications';
import { NOTIFICATION_RULE_KINDS } from '../shared/types';

function withOnlyRule(input: UpsertNotificationRuleInput): { db: Database.Database; ruleId: string } {
  const db = migratedTestDb();
  db.prepare('DELETE FROM notification_rules').run();
  const result = upsertNotificationRule(db, input);
  if (!result.ok) throw new Error(result.error);
  return { db, ruleId: result.rule.id };
}

function fires(db: Database.Database): string[] {
  const summary = evaluateNotifications(db);
  assert.deepEqual(summary.errors, []);
  return summary.created.map((n) => n.dedupe_key);
}

function assertIdempotent(db: Database.Database): void {
  const before = (db.prepare('SELECT COUNT(*) AS n FROM notifications').get() as { n: number }).n;
  const again = evaluateNotifications(db);
  assert.equal(again.created.length, 0);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM notifications').get() as { n: number }).n, before);
}

function insertBudget(db: Database.Database, categoryId: string, amount: number): string {
  const id = `budget_${categoryId}`;
  db.prepare(`INSERT INTO budgets (id, category_id, amount, period, created_at, updated_at)
    VALUES (?, ?, ?, 'monthly', ?, ?)`).run(id, categoryId, amount, TEST_NOW, TEST_NOW);
  return id;
}

function insertPattern(db: Database.Database, overrides: Partial<{
  id: string; next_expected: string; average_amount: number; category_id: string;
  amount_changed_from: number | null; amount_changed_on: string | null;
}> = {}): string {
  const id = overrides.id ?? 'pattern_1';
  db.prepare(`INSERT INTO recurring_patterns
    (id, merchant_name, category_id, frequency, average_amount, last_seen, next_expected, is_active,
     is_confirmed, transaction_count, amount_changed_from, amount_changed_on, created_at, updated_at)
    VALUES (?, ?, ?, 'monthly', ?, ?, ?, 1, 1, 6, ?, ?, ?, ?)`).run(
    id, id === 'pattern_1' ? 'Electric Co' : `Merchant ${id}`, overrides.category_id ?? 'cat_food', overrides.average_amount ?? 1500, localDaysFromToday(-28),
    overrides.next_expected ?? localDaysFromToday(2), overrides.amount_changed_from ?? null,
    overrides.amount_changed_on ?? null, TEST_NOW, TEST_NOW
  );
  return id;
}

function insertRun(db: Database.Database, id: string, status: string, startedAt: string): void {
  db.prepare(`INSERT INTO sync_runs (id, scope, status, started_at, completed_at, error_message)
    VALUES (?, 'full', ?, ?, ?, ?)`).run(id, status, startedAt, startedAt, status === 'succeeded' ? null : 'SimpleFIN returned 403');
}

function insertGoal(db: Database.Database, current: number): string {
  db.prepare(`INSERT INTO goals (id, name, type, target_amount, current_amount, created_at, updated_at)
    VALUES ('goal_1', 'Emergency Fund', 'savings', 100000, ?, ?, ?)`).run(current, TEST_NOW, TEST_NOW);
  return 'goal_1';
}

test('every shared rule kind is accepted by the table CHECK, and an unknown kind is refused', () => {
  const db = migratedTestDb();
  const insert = db.prepare(`INSERT INTO notification_rules (id, kind, params, enabled, created_by, created_at, updated_at)
    VALUES (?, ?, '{}', 0, 'owner', ?, ?)`);
  for (const kind of NOTIFICATION_RULE_KINDS) insert.run(`check_${kind}`, kind, TEST_NOW, TEST_NOW);
  assert.throws(() => insert.run('check_bogus', 'bogus', TEST_NOW, TEST_NOW), /CHECK/);
});

test('HEALTHY: the seeded rules are silent on an ordinary ledger', () => {
  const db = migratedTestDb();
  const account = insertAccount(db, { current_balance: 500000 });
  insertBudget(db, 'cat_food', 50000);
  insertTransaction(db, { account_id: account, amount: -12000, category_id: 'cat_food', date: dayInThisMonth(1) });
  insertRun(db, 'run_ok', 'succeeded', '2026-10-01T10:00:00.000Z');
  insertGoal(db, 10000);
  insertPattern(db, { next_expected: localDaysFromToday(12) });
  assert.deepEqual(fires(db), []);
});

test('budget_threshold fires at the percent, once per budget per month', () => {
  const { db } = withOnlyRule({ kind: 'budget_threshold', params: { category_id: null, percent: 90 } });
  const budgetId = insertBudget(db, 'cat_food', 10000);
  insertTransaction(db, { amount: -9500, category_id: 'cat_food', date: dayInThisMonth(1) });
  const [key] = fires(db);
  assert.match(key, new RegExp(`^budget_threshold:${budgetId}:\\d{4}-\\d{2}:90$`));
  const [n] = listNotifications(db);
  assert.equal(n.payload.spent, 9500);
  assert.equal(n.route, '/plan');
  assertIdempotent(db);
});

test('HEALTHY: budget_threshold is silent under the percent, and a recurring bill alone does not trip it', () => {
  const { db } = withOnlyRule({ kind: 'budget_threshold', params: { category_id: null, percent: 90 } });
  insertBudget(db, 'cat_food', 10000);
  insertTransaction(db, { amount: -5000, category_id: 'cat_food', date: dayInThisMonth(1) });
  insertPattern(db, { average_amount: 20000, next_expected: localDaysFromToday(5) });
  assert.deepEqual(fires(db), []);
});

test('large_transaction fires per transaction at or above the minimum within the lookback', () => {
  const { db } = withOnlyRule({ kind: 'large_transaction', params: { min_amount: 50000, account_id: null, lookback_days: 7 } });
  const txn = insertTransaction(db, { amount: -60000, date: localToday(), merchant_name: 'Apple' });
  assert.deepEqual(fires(db), [`large_transaction:${txn}`]);
  assertIdempotent(db);
});

test('HEALTHY: large_transaction is silent on small rows, transfers, pending rows and history', () => {
  const { db } = withOnlyRule({ kind: 'large_transaction', params: { min_amount: 50000, account_id: null, lookback_days: 7 } });
  insertTransaction(db, { amount: -1000, date: localToday() });
  insertTransaction(db, { amount: -90000, date: localToday(), pending: 1 });
  insertTransaction(db, { amount: -90000, date: localDaysFromToday(-30) });
  insertTransaction(db, { amount: 90000, date: localToday() });
  const transfer = insertTransaction(db, { amount: -90000, date: localToday() });
  db.prepare("UPDATE transactions SET transfer_status = 'confirmed' WHERE id = ?").run(transfer);
  assert.deepEqual(fires(db), []);
});

test('bill_due fires for a scheduled outflow inside the window', () => {
  const { db } = withOnlyRule({ kind: 'bill_due', params: { days_ahead: 3 } });
  const pattern = insertPattern(db, { next_expected: localDaysFromToday(2) });
  assert.deepEqual(fires(db), [`bill_due:${pattern}:${localDaysFromToday(2)}`]);
  assert.equal(listNotifications(db)[0].payload.amount, 1500);
  assertIdempotent(db);
});

test('HEALTHY: bill_due is silent for a bill outside the window and for scheduled income', () => {
  const { db } = withOnlyRule({ kind: 'bill_due', params: { days_ahead: 3 } });
  insertPattern(db, { id: 'far', next_expected: localDaysFromToday(10) });
  insertPattern(db, { id: 'pay', next_expected: localDaysFromToday(1), category_id: 'cat_income_paycheck' });
  assert.ok(db.prepare("SELECT 1 FROM categories WHERE id = 'cat_income_paycheck' AND is_income = 1").get());
  assert.deepEqual(fires(db), []);
});

test('low_balance fires for an account and for the liquid pool under the threshold', () => {
  const { db } = withOnlyRule({ kind: 'low_balance', params: { account_id: null, threshold: 50000 } });
  const account = insertAccount(db, { current_balance: 20000 });
  assert.equal(upsertNotificationRule(db, { kind: 'low_balance', params: { account_id: account, threshold: 30000 } }).ok, true);
  const keys = fires(db).sort();
  assert.equal(keys.length, 2);
  assert.match(keys[0], new RegExp(`^low_balance:${account}:`));
  assert.match(keys[1], /^low_balance:pool:/);
  assertIdempotent(db);
});

test('HEALTHY: low_balance is silent above the threshold', () => {
  const { db } = withOnlyRule({ kind: 'low_balance', params: { account_id: null, threshold: 50000 } });
  insertAccount(db, { current_balance: 100000 });
  assert.deepEqual(fires(db), []);
});

test('safe_to_spend_negative fires when card claims exceed the pool', () => {
  const { db } = withOnlyRule({ kind: 'safe_to_spend_negative', params: {} });
  insertAccount(db, { current_balance: 100000 });
  insertAccount(db, { type: 'credit', is_liability: 1, current_balance: 250000 });
  const [key] = fires(db);
  assert.match(key, /^safe_to_spend_negative:\d{4}-\d{2}$/);
  assert.equal(listNotifications(db)[0].payload.free, -150000);
  assertIdempotent(db);
});

test('HEALTHY: safe_to_spend_negative is silent when the pool covers the claims, including a card in credit', () => {
  const { db } = withOnlyRule({ kind: 'safe_to_spend_negative', params: {} });
  insertAccount(db, { current_balance: 100000 });
  insertAccount(db, { type: 'credit', is_liability: 1, current_balance: -5000 });
  assert.deepEqual(fires(db), []);
});

test('sync_failed notifies once per run of failures, and again after a success breaks it', () => {
  const { db } = withOnlyRule({ kind: 'sync_failed', params: { include_partial: true } });
  insertRun(db, 'r1', 'succeeded', '2026-10-01T10:00:00.000Z');
  insertRun(db, 'r2', 'failed', '2026-10-01T11:00:00.000Z');
  assert.deepEqual(fires(db), ['sync_failed:r2']);
  insertRun(db, 'r3', 'partial', '2026-10-01T12:00:00.000Z');
  assert.deepEqual(fires(db), []);
  insertRun(db, 'r4', 'succeeded', '2026-10-01T13:00:00.000Z');
  insertRun(db, 'r5', 'failed', '2026-10-01T14:00:00.000Z');
  assert.deepEqual(fires(db), ['sync_failed:r5']);
  assertIdempotent(db);
});

test('HEALTHY: sync_failed is silent when the latest finished run succeeded, past failures notwithstanding', () => {
  const { db } = withOnlyRule({ kind: 'sync_failed', params: { include_partial: true } });
  insertRun(db, 'r1', 'failed', '2026-10-01T10:00:00.000Z');
  insertRun(db, 'r2', 'succeeded', '2026-10-01T11:00:00.000Z');
  insertRun(db, 'r3', 'running', '2026-10-01T12:00:00.000Z');
  assert.deepEqual(fires(db), []);
});

test('HEALTHY: sync_failed ignores a partial run when partials are excluded', () => {
  const { db } = withOnlyRule({ kind: 'sync_failed', params: { include_partial: false } });
  insertRun(db, 'r1', 'partial', '2026-10-01T10:00:00.000Z');
  assert.deepEqual(fires(db), []);
});

test('goal_milestone fires the highest milestone reached, then the next one when it is reached', () => {
  const { db } = withOnlyRule({ kind: 'goal_milestone', params: { goal_id: null, milestones: [25, 50, 100] } });
  const goal = insertGoal(db, 60000);
  assert.deepEqual(fires(db), [`goal_milestone:${goal}:50`]);
  assertIdempotent(db);
  db.prepare('UPDATE goals SET current_amount = 100000 WHERE id = ?').run(goal);
  assert.deepEqual(fires(db), [`goal_milestone:${goal}:100`]);
});

test('HEALTHY: goal_milestone is silent below the first milestone and for an archived goal', () => {
  const { db } = withOnlyRule({ kind: 'goal_milestone', params: { goal_id: null, milestones: [50, 100] } });
  insertGoal(db, 10000);
  db.prepare(`INSERT INTO goals (id, name, type, target_amount, current_amount, is_archived, created_at, updated_at)
    VALUES ('archived', 'Old', 'savings', 100, 100, 1, ?, ?)`).run(TEST_NOW, TEST_NOW);
  assert.deepEqual(fires(db), []);
});

function priorMonthDay1(monthsBack: number): string {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() - monthsBack, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

function unusualFixture(currentSpend: number): { db: Database.Database; category: string } {
  const { db } = withOnlyRule({ kind: 'unusual_spending', params: { category_id: null, ratio: 1.5, min_amount: 10000 } });
  const category = insertCategory(db, { name: 'Dining' });
  for (const back of [1, 2, 3]) insertTransaction(db, { amount: -10000, category_id: category, date: priorMonthDay1(back) });
  insertTransaction(db, { amount: -currentSpend, category_id: category, date: dayInThisMonth(1) });
  return { db, category };
}

test('unusual_spending fires when month-to-date spend runs past the trailing average by the ratio', () => {
  const { db, category } = unusualFixture(50000);
  const [key] = fires(db);
  assert.match(key, new RegExp(`^unusual_spending:${category}:`));
  const [n] = listNotifications(db);
  assert.equal(n.payload.baseline, 10000);
  assert.equal(n.payload.month_to_date, 50000);
  assertIdempotent(db);
});

test('HEALTHY: unusual_spending is silent at the usual pace and on a ledger younger than its baseline', () => {
  assert.deepEqual(fires(unusualFixture(11000).db), []);
  const { db } = withOnlyRule({ kind: 'unusual_spending', params: { category_id: null, ratio: 1.5, min_amount: 0 } });
  const category = insertCategory(db, { name: 'New' });
  insertTransaction(db, { amount: -1000, category_id: category, date: priorMonthDay1(1) });
  insertTransaction(db, { amount: -90000, category_id: category, date: dayInThisMonth(1) });
  assert.deepEqual(fires(db), []);
});

test('recurring_amount_changed fires once per level shift detection reports', () => {
  const { db } = withOnlyRule({ kind: 'recurring_amount_changed', params: {} });
  const pattern = insertPattern(db, { average_amount: 1800, amount_changed_from: 1500, amount_changed_on: localDaysFromToday(-3) });
  assert.deepEqual(fires(db), [`recurring_amount_changed:${pattern}:${localDaysFromToday(-3)}`]);
  const [n] = listNotifications(db);
  assert.match(n.title, /went up to \$18\.00/);
  assertIdempotent(db);
});

test('HEALTHY: recurring_amount_changed is silent on a steady pattern, a dismissed one and an old change', () => {
  const { db } = withOnlyRule({ kind: 'recurring_amount_changed', params: {} });
  insertPattern(db, { id: 'steady' });
  insertPattern(db, { id: 'gone', amount_changed_from: 1000, amount_changed_on: localToday() });
  db.prepare("UPDATE recurring_patterns SET dismissed_at = ? WHERE id = 'gone'").run(TEST_NOW);
  insertPattern(db, { id: 'old', amount_changed_from: 1000, amount_changed_on: localDaysFromToday(-90) });
  assert.deepEqual(fires(db), []);
});

test('a rule that throws is reported and the others still run', () => {
  const { db } = withOnlyRule({ kind: 'safe_to_spend_negative', params: {} });
  const account = insertAccount(db, { current_balance: 100 });
  insertAccount(db, { type: 'credit', is_liability: 1, current_balance: 500 });
  const broken = upsertNotificationRule(db, { kind: 'low_balance', params: { account_id: account, threshold: 1000 } });
  assert.ok(broken.ok);
  db.pragma('foreign_keys = OFF');
  db.prepare('DELETE FROM accounts WHERE id = ?').run(account);
  const summary = evaluateNotifications(db);
  assert.equal(summary.errors.length, 1);
  assert.equal(summary.errors[0].rule_id, broken.rule.id);
  assert.equal(summary.created.length, 1);
});

test('upsertNotificationRule refuses bad input with a result rather than a throw', () => {
  const db = migratedTestDb();
  const bad = (input: unknown) => {
    const result = upsertNotificationRule(db, input as UpsertNotificationRuleInput);
    assert.equal(result.ok, false);
  };
  bad({ kind: 'nope', params: {} });
  bad({ kind: 'budget_threshold', params: { percent: -5 } });
  bad({ kind: 'budget_threshold', params: { category_id: 'cat_missing', percent: 80 } });
  bad({ kind: 'goal_milestone', params: { milestones: [50, 50] } });
  bad({ kind: 'low_balance', params: { account_id: insertAccount(db, { is_liability: 1, type: 'credit' }), threshold: 1 } });
  bad({ id: 'nrule_budget_90', kind: 'bill_due', params: { days_ahead: 3 } });
  bad({ id: 'missing', kind: 'bill_due', params: { days_ahead: 3 } });
});

test('a rule edits in place, toggles, and deleting it keeps its notifications with rule_id null', () => {
  const { db, ruleId } = withOnlyRule({ kind: 'goal_milestone', params: { goal_id: null, milestones: [50] } });
  const edited = upsertNotificationRule(db, { id: ruleId, kind: 'goal_milestone', params: { goal_id: null, milestones: [40] } });
  assert.ok(edited.ok && !edited.created);
  assert.deepEqual(listNotificationRules(db)[0].params, { goal_id: null, milestones: [40] });
  assert.equal(setNotificationRuleEnabled(db, ruleId, false)?.enabled, false);
  insertGoal(db, 60000);
  assert.deepEqual(fires(db), []);
  setNotificationRuleEnabled(db, ruleId, true);
  assert.equal(fires(db).length, 1);
  assert.equal(deleteNotificationRule(db, ruleId), true);
  assert.equal(deleteNotificationRule(db, ruleId), false);
  assert.equal(listNotifications(db)[0].rule_id, null);
  assert.equal(setNotificationRuleEnabled(db, ruleId, true), null);
});

test('read and dismiss move the unread count, and dismissed rows leave the list', () => {
  const { db } = withOnlyRule({ kind: 'sync_failed', params: { include_partial: true } });
  insertRun(db, 'a', 'failed', '2026-10-01T10:00:00.000Z');
  fires(db);
  insertRun(db, 'b', 'succeeded', '2026-10-01T11:00:00.000Z');
  insertRun(db, 'c', 'failed', '2026-10-01T12:00:00.000Z');
  fires(db);
  assert.equal(unreadCount(db), 2);
  const [first, second] = listNotifications(db);
  assert.equal(markNotificationsRead(db, [first.id]), 1);
  assert.equal(markNotificationsRead(db, [first.id]), 0);
  assert.equal(unreadCount(db), 1);
  assert.equal(listNotifications(db, { unreadOnly: true }).length, 1);
  assert.equal(dismissNotification(db, second.id), true);
  assert.equal(dismissNotification(db, second.id), false);
  assert.equal(unreadCount(db), 0);
  assert.equal(listNotifications(db).length, 1);
  assert.equal(markNotificationsRead(db, 'all'), 0);
});

test('HEALTHY: a regular payment landing a day earlier than usual is not unusual spending', () => {
  const { db } = withOnlyRule({ kind: 'unusual_spending', params: { category_id: null, ratio: 1.5, min_amount: 10000 } });
  const category = insertCategory(db, { name: 'Housing' });
  for (const back of [1, 2, 3]) {
    const now = new Date();
    const d = new Date(now.getFullYear(), now.getMonth() - back, 2);
    insertTransaction(db, { amount: -200000, category_id: category, date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-02` });
  }
  insertTransaction(db, { amount: -200000, category_id: category, date: dayInThisMonth(1) });
  assert.deepEqual(fires(db), []);
});

test('HEALTHY: spending on a recurring bill is left out of unusual spending', () => {
  const { db } = withOnlyRule({ kind: 'unusual_spending', params: { category_id: null, ratio: 1.5, min_amount: 10000 } });
  const category = insertCategory(db, { name: 'Utilities' });
  const pattern = insertPattern(db, { category_id: category });
  for (const back of [1, 2, 3]) insertTransaction(db, { amount: -5000, category_id: category, date: priorMonthDay1(back) });
  const bill = insertTransaction(db, { amount: -90000, category_id: category, date: dayInThisMonth(1) });
  db.prepare('UPDATE transactions SET recurring_id = ? WHERE id = ?').run(pattern, bill);
  assert.deepEqual(fires(db), []);
});

function payFixture(gaps: number[], daysLate: number, amount = 50000): { db: Database.Database; pattern: string } {
  const { db } = withOnlyRule({ kind: 'income_late', params: { min_days_late: 2 } });
  const income = insertCategory(db, { name: 'Pay', is_income: 1 });
  const pattern = insertPattern(db, { category_id: income, next_expected: localDaysFromToday(-daysLate), average_amount: amount });
  let back = daysLate + gaps.reduce((sum, gap) => sum + gap, 0);
  const dates = [localDaysFromToday(-back)];
  for (const gap of gaps) { back -= gap; dates.push(localDaysFromToday(-back)); }
  for (const date of dates.slice(0, -1)) {
    const id = insertTransaction(db, { amount, category_id: income, date });
    db.prepare('UPDATE transactions SET recurring_id = ? WHERE id = ?').run(pattern, id);
  }
  return { db, pattern };
}

test('income_late warns once when steady weekly pay is well past due', () => {
  const { db, pattern } = payFixture([7, 7, 7, 7, 7], 5);
  const keys = fires(db);
  assert.equal(keys.length, 1);
  assert.match(keys[0], new RegExp(`^income_late:${pattern}:`));
  assertIdempotent(db);
});

test('HEALTHY: income_late is silent for pay within its usual wobble, and for a late bill', () => {
  assert.deepEqual(fires(payFixture([7, 10, 6, 7, 9], 3).db), []);
  assert.deepEqual(fires(payFixture([7, 7, 7, 7, 7], 1).db), []);
  const { db } = withOnlyRule({ kind: 'income_late', params: { min_days_late: 2 } });
  const bill = insertPattern(db, { next_expected: localDaysFromToday(-10), average_amount: 1500 });
  for (const back of [40, 33, 26, 19]) {
    const id = insertTransaction(db, { amount: -1500, category_id: 'cat_subscriptions', date: localDaysFromToday(-back) });
    db.prepare('UPDATE transactions SET recurring_id = ? WHERE id = ?').run(bill, id);
  }
  assert.deepEqual(fires(db), []);
});
