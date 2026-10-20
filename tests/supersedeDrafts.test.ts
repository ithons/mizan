import { test } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { supersedeLapsedDrafts } from '../server/src/services/advisorDrafts';
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
