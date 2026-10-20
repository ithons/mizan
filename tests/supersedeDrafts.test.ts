import { test } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { supersedeLapsedDrafts } from '../server/src/services/advisorDrafts';
import { proposeChanges } from '../server/src/services/advisorProposals';
import { insertAccount, insertTransaction, migratedTestDb } from './helpers/schema';

function draft(db: Database.Database, id: string, payload: object, status = 'open') {
  db.prepare(`INSERT INTO advisor_drafts (id, kind, label, summary, route, payload, changes, citations, status, created_at, updated_at)
    VALUES (?, ?, 'label', 'summary', '/ledger', ?, '[]', '[]', ?, '2026-07-25T00:00:00Z', '2026-07-25T00:00:00Z')`)
    .run(id, (payload as { kind: string }).kind, JSON.stringify(payload), status);
}

const state = (db: Database.Database, id: string) =>
  db.prepare('SELECT status, closed_reason FROM advisor_drafts WHERE id = ?').get(id) as { status: string; closed_reason: string | null };

function ledger() {
  const db = migratedTestDb();
  const account = insertAccount(db, { account_name: 'Card', type: 'credit', is_liability: 1 });
  const filed = insertTransaction(db, { account_id: account, amount: -5284, original_name: 'FORMAGGIO KITCHEN', category_id: 'cat_food_groceries' });
  const open = insertTransaction(db, { account_id: account, amount: -923, original_name: 'LEAVITT AND PEIRCE' });
  return { db, filed, open };
}

test('a proposal to file a row where it already is closes as superseded, with its reason, and is not a refusal', () => {
  const { db, filed } = ledger();
  draft(db, 'd1', { kind: 'categorize_transaction', transaction_id: filed, category_id: 'cat_food_groceries' });
  assert.equal(supersedeLapsedDrafts(db), 1);
  const after = state(db, 'd1');
  assert.equal(after.status, 'superseded');
  assert.match(after.closed_reason ?? '', /no longer applies/);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM advisor_drafts WHERE status = 'dismissed'").get() as { n: number }).n, 0);
});

test('a proposal naming a category that no longer exists closes as superseded', () => {
  const { db, open } = ledger();
  draft(db, 'd2', { kind: 'categorize_transaction', transaction_id: open, category_id: 'cat_shop_general' });
  supersedeLapsedDrafts(db);
  assert.equal(state(db, 'd2').status, 'superseded');
});

test('HEALTHY: a proposal that would still change something stays open, and a dismissed one is left alone', () => {
  const { db, open, filed } = ledger();
  draft(db, 'd3', { kind: 'categorize_transaction', transaction_id: open, category_id: 'cat_shop_smoke' });
  draft(db, 'd4', { kind: 'categorize_transaction', transaction_id: filed, category_id: 'cat_food_groceries' }, 'dismissed');
  assert.equal(supersedeLapsedDrafts(db), 0);
  assert.equal(state(db, 'd3').status, 'open');
  assert.equal(state(db, 'd4').status, 'dismissed');
});

interface Premise {
  payload: object;
  remove: (db: Database.Database) => void;
}

function premises(db: Database.Database): Record<string, Premise> {
  const now = '2026-07-25T00:00:00Z';
  const brokerage = insertAccount(db, { account_name: 'Brokerage', type: 'brokerage' });
  const spare = insertAccount(db, { account_name: 'Spare' });
  db.prepare(`INSERT INTO recurring_patterns (id, merchant_name, average_amount, frequency, last_seen, next_expected, created_at, updated_at)
    VALUES ('rp_gym', 'Gym', -4000, 'monthly', '2026-07-01', '2026-08-01', ?, ?)`).run(now, now);
  db.prepare("INSERT INTO budgets (id, category_id, amount, created_at, updated_at) VALUES ('b_food', 'cat_food', 50000, ?, ?)").run(now, now);
  db.prepare("INSERT INTO securities (id, name) VALUES ('sec_held', 'Held'), ('sec_bare', 'Bare')").run();
  db.prepare(`INSERT INTO holdings (id, account_id, security_id, quantity, institution_price, institution_value, updated_at)
    VALUES ('h_1', ?, 'sec_held', 1, 100, 10000, ?)`).run(brokerage, now);
  const purchase = insertTransaction(db, { account_id: brokerage, amount: -6000 });
  const payback = insertTransaction(db, { account_id: brokerage, amount: 3000 });
  const run = (sql: string, ...args: string[]) => (d: Database.Database) => {
    d.prepare(sql).run(...args);
  };
  const rule = { kind: 'set_notification_rule', rule_id: 'nrule_bill_due_3', rule_kind: 'bill_due', params: { days_ahead: 5 } };
  return {
    delete_budget: { payload: { kind: 'delete_budget', category_id: 'cat_food' }, remove: run("DELETE FROM budgets WHERE id = 'b_food'") },
    update_account: { payload: { kind: 'update_account', account_id: spare, is_hidden: true }, remove: run('DELETE FROM accounts WHERE id = ?', spare) },
    dismiss_recurring: { payload: { kind: 'dismiss_recurring', recurring_id: 'rp_gym' }, remove: run("DELETE FROM recurring_patterns WHERE id = 'rp_gym'") },
    create_recurring_adjustment: {
      payload: { kind: 'create_recurring_adjustment', recurring_id: 'rp_gym', original_date: '2026-08-01', action: 'snooze', adjusted_date: '2026-08-05' },
      remove: run("DELETE FROM recurring_patterns WHERE id = 'rp_gym'"),
    },
    set_manual_cost_basis: { payload: { kind: 'set_manual_cost_basis', holding_id: 'h_1', manual_cost_basis: 80 }, remove: run("DELETE FROM holdings WHERE id = 'h_1'") },
    set_sector_metadata: { payload: { kind: 'set_sector_metadata', security_id: 'sec_bare', sector: 'Energy' }, remove: run("DELETE FROM securities WHERE id = 'sec_bare'") },
    link_reimbursement: { payload: { kind: 'link_reimbursement', reimbursement_id: payback, purchase_id: purchase }, remove: run('DELETE FROM transactions WHERE id = ?', payback) },
    delete_notification_rule: { payload: { kind: 'delete_notification_rule', rule_id: 'nrule_bill_due_3' }, remove: run("DELETE FROM notification_rules WHERE id = 'nrule_bill_due_3'") },
    set_notification_rule: { payload: rule, remove: run("DELETE FROM notification_rules WHERE id = 'nrule_bill_due_3'") },
  };
}

const JUDGED_BY_TARGET = Object.keys(premises(migratedTestDb()));

for (const kind of JUDGED_BY_TARGET) {
  test(`${kind}: open while its target exists, superseded once the target is gone`, () => {
    const db = migratedTestDb();
    const premise = premises(db)[kind];
    draft(db, 'd_kind', premise.payload);

    assert.equal(supersedeLapsedDrafts(db), 0, 'HEALTHY: nothing changed, so the proposal stays open');
    assert.equal(state(db, 'd_kind').status, 'open');

    premise.remove(db);
    assert.equal(supersedeLapsedDrafts(db), 1);
    assert.equal(state(db, 'd_kind').status, 'superseded');
  });
}

test('HEALTHY: a proposal to create a notification rule names nothing that can lapse, so it stays open', () => {
  const db = migratedTestDb();
  draft(db, 'd_new_rule', { kind: 'set_notification_rule', rule_kind: 'income_late', params: { min_days_late: 4 } });
  assert.equal(supersedeLapsedDrafts(db), 0);
  assert.equal(state(db, 'd_new_rule').status, 'open');
});

test('a notification rule proposal with an unknown kind or bad params is refused before it becomes a card', () => {
  const db = migratedTestDb();
  const propose = (payload: object) => proposeChanges(db, { changes: [{ label: 'Rule', summary: 'Because.', payload }] });

  const unknown = propose({ kind: 'set_notification_rule', rule_kind: 'weather_alert', params: {} });
  assert.equal(unknown.proposed.length, 0);
  assert.match(unknown.refused[0].reason, /rule_kind must be one of/);

  const badParams = propose({ kind: 'set_notification_rule', rule_kind: 'bill_due', params: { days_ahead: 400 } });
  assert.equal(badParams.proposed.length, 0);
  assert.match(badParams.refused[0].reason, /days_ahead/);

  const kindChange = propose({ kind: 'set_notification_rule', rule_id: 'nrule_bill_due_3', rule_kind: 'income_late', params: {} });
  assert.match(kindChange.refused[0].reason, /kind cannot change/);

  const healthy = propose({ kind: 'set_notification_rule', rule_id: 'nrule_bill_due_3', rule_kind: 'bill_due', params: { days_ahead: 5 } });
  assert.deepEqual(healthy.refused, []);
  assert.equal(healthy.proposed.length, 1);
});
