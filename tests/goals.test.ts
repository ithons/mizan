import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGoal, updateGoal } from '../server/src/services/goals';
import { TABLE_MEANINGS } from '../server/src/services/schemaDoc';
import { insertAccount, migratedTestDb } from './helpers/schema';

function goalRow(db: ReturnType<typeof migratedTestDb>, id: string) {
  return db.prepare('SELECT type, current_amount, account_id FROM goals WHERE id = ?').get(id) as {
    type: string;
    current_amount: number;
    account_id: string | null;
  };
}

function linkedGoal(db: ReturnType<typeof migratedTestDb>): string {
  insertAccount(db, { id: 'acc_wf', type: 'savings', current_balance: 500370 });
  const created = createGoal(db, { name: 'Emergency Fund', type: 'savings', target_amount: 5000, account_id: 'acc_wf' });
  assert.ok(created.ok);
  return created.id;
}

test('an edit of a linked goal cannot snapshot the balance into current_amount', () => {
  const db = migratedTestDb();
  const id = linkedGoal(db);

  // The live shape: the form sent back the resolved $5,003.70 as the saved amount.
  assert.deepEqual(updateGoal(db, id, { name: 'Emergency Fund', current_amount: 5003.7 }), { ok: false, reason: 'saved_amount_on_linked_goal' });
  assert.equal(goalRow(db, id).current_amount, 0);
  db.close();
});

test('an edit that links a goal in the same request cannot set current_amount either', () => {
  const db = migratedTestDb();
  insertAccount(db, { id: 'acc_wf', type: 'savings', current_balance: 500370 });
  const created = createGoal(db, { name: 'Trip', type: 'savings', target_amount: 2000 });
  assert.ok(created.ok);

  assert.equal(updateGoal(db, created.id, { account_id: 'acc_wf', current_amount: 12 }).ok, false);
  assert.equal(goalRow(db, created.id).account_id, null);
  db.close();
});

test('unlinking in the same request records the owner\'s saved amount', () => {
  const db = migratedTestDb();
  const id = linkedGoal(db);

  assert.deepEqual(updateGoal(db, id, { account_id: null, current_amount: 1200 }), { ok: true });
  assert.deepEqual(goalRow(db, id), { type: 'savings', current_amount: 120000, account_id: null });
  db.close();
});

test('an edit without a type keeps a debt goal a debt goal', () => {
  const db = migratedTestDb();
  const created = createGoal(db, { name: 'Pay off Discover', type: 'debt', target_amount: 900 });
  assert.ok(created.ok);

  assert.deepEqual(updateGoal(db, created.id, { name: 'Pay off the Discover card', target_amount: 950 }), { ok: true });
  assert.equal(goalRow(db, created.id).type, 'debt');
  db.close();
});

test('HEALTHY: an unlinked goal edit still writes current_amount', () => {
  const db = migratedTestDb();
  const created = createGoal(db, { name: 'Trip', type: 'savings', target_amount: 2000, current_amount: 100 });
  assert.ok(created.ok);

  assert.deepEqual(updateGoal(db, created.id, { current_amount: 250.5 }), { ok: true });
  assert.equal(goalRow(db, created.id).current_amount, 25050);
  db.close();
});

test('HEALTHY: an ordinary edit of a linked goal goes through', () => {
  const db = migratedTestDb();
  const id = linkedGoal(db);

  assert.deepEqual(updateGoal(db, id, { name: 'Cushion', target_amount: 6000 }), { ok: true });
  assert.equal(goalRow(db, id).account_id, 'acc_wf');
  db.close();
});

test('the schema doc says a linked goal\'s current_amount is not its saved amount', () => {
  assert.match(TABLE_MEANINGS.goals.columns.current_amount.note ?? '', /linked goal it is stale/);
});
