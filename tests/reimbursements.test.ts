import test from 'node:test';
import assert from 'node:assert/strict';
import { findReimbursements } from '../server/src/services/reimbursements';
import { proposeChanges } from '../server/src/services/advisorProposals';
import { confirmAdvisorDraftsByIds } from '../server/src/services/advisorDrafts';
import { insertAccount, insertTransaction, localDaysFromToday, migratedTestDb } from './helpers/schema';

function dinnerAndPayback() {
  const db = migratedTestDb();
  const checking = insertAccount(db, { type: 'checking' });
  const card = insertAccount(db, { type: 'credit', is_liability: 1 });
  const dinner = insertTransaction(db, { account_id: card, date: localDaysFromToday(-5), amount: -6000, merchant_name: 'Salumeria', category_id: 'cat_food_restaurants' });
  const back = insertTransaction(db, { account_id: checking, date: localDaysFromToday(-3), amount: 2500, original_name: 'Zelle payment from STACY CHEN', category_id: 'cat_xfer_in', source_type: 'simplefin' });
  return { db, dinner, back };
}

test('a friend\'s Zelle is offered against the dinner before it, and linking it files it with the dinner', () => {
  const { db, dinner, back } = dinnerAndPayback();
  const found = findReimbursements(db);
  assert.deepEqual(found.inflows.map((i) => [i.id, i.could_pay_back.map((p) => p.id)]), [[back, [dinner]]]);

  const { proposed, refused } = proposeChanges(db, { changes: [{ label: 'Stacy paid back dinner', summary: '', payload: { kind: 'link_reimbursement', reimbursement_id: back, purchase_id: dinner } }] });
  assert.deepEqual(refused, []);
  assert.equal(proposed[0].changes?.[1]?.after, 'Restaurants');
  assert.equal(confirmAdvisorDraftsByIds(db, [proposed[0].id]).outcomes[0].status, 'applied');
  assert.deepEqual(db.prepare('SELECT refund_of_id, category_id FROM transactions WHERE id = ?').get(back), { refund_of_id: dinner, category_id: 'cat_food_restaurants' });
  assert.deepEqual(findReimbursements(db).inflows, []);
});

test('HEALTHY: nothing is offered for a ledger with no peer payments, or one the owner said pays nothing back', () => {
  const plain = migratedTestDb();
  insertTransaction(plain, { date: localDaysFromToday(-3), amount: 50000, original_name: 'PAYROLL', category_id: 'cat_income_paycheck' });
  assert.deepEqual(findReimbursements(plain).inflows, []);

  const { db, back } = dinnerAndPayback();
  db.prepare("UPDATE transactions SET refund_link_source = 'rejected' WHERE id = ?").run(back);
  assert.deepEqual(findReimbursements(db).inflows, []);
});

test('a purchase already paid back in full is not offered again', () => {
  const { db, dinner } = dinnerAndPayback();
  const earlier = insertTransaction(db, { date: localDaysFromToday(-4), amount: 6000, original_name: 'refund' });
  db.prepare('UPDATE transactions SET refund_of_id = ? WHERE id = ?').run(dinner, earlier);
  assert.deepEqual(findReimbursements(db).inflows[0].could_pay_back, []);
});

test('re-checking every rule leaves a linked reimbursement filed with its purchase', async () => {
  const { recategorizeAll, upsertMerchantRule } = await import('../server/src/services/rules');
  const { db, dinner, back } = dinnerAndPayback();
  upsertMerchantRule(db, 'Zelle payment from', 'cat_xfer_in', '2026-10-01T00:00:00Z', { source: 'ai' });
  const { proposed } = proposeChanges(db, { changes: [{ label: 'x', summary: '', payload: { kind: 'link_reimbursement', reimbursement_id: back, purchase_id: dinner } }] });
  confirmAdvisorDraftsByIds(db, [proposed[0].id]);
  recategorizeAll(db);
  assert.deepEqual(db.prepare('SELECT category_id FROM transactions WHERE id = ?').get(back), { category_id: 'cat_food_restaurants' });
});

test('the review pass is shown a candidate until the owner declines a link for it', async () => {
  const { promptReimbursements } = await import('../server/src/services/aiWorker');
  const { db, dinner, back } = dinnerAndPayback();
  assert.deepEqual(promptReimbursements(db).map((r) => r.id), [back]);
  db.prepare(`INSERT INTO advisor_drafts (id, kind, label, summary, route, payload, changes, citations, status, created_at, updated_at)
    VALUES ('d_no', 'link_reimbursement', 'x', 's', '/ledger', ?, '[]', '[]', 'dismissed', '2026-10-17', '2026-10-17')`)
    .run(JSON.stringify({ kind: 'link_reimbursement', reimbursement_id: back, purchase_id: dinner }));
  assert.deepEqual(promptReimbursements(db), []);
});
