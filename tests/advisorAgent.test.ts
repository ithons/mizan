import test from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { listOpenDrafts, proposeChanges } from '../server/src/services/advisorProposals';
import { confirmAdvisorDraftsByIds } from '../server/src/services/advisorDrafts';
import { ADVISOR_TOOLS, runAdvisorTool } from '../server/src/services/advisorChatTools';
import { ADVISOR_SYSTEM_PROMPT } from '../server/src/services/aiContext';
import { createMemory } from '../server/src/services/aiMemory';
import { insertAccount, insertTransaction, migratedTestDb } from './helpers/schema';

function propose(db: Database.Database, payload: Record<string, unknown>) {
  return proposeChanges(db, { changes: [{ label: 'Change', summary: 'Because.', payload }] });
}

function confirmOne(db: Database.Database, payload: Record<string, unknown>) {
  const { proposed, refused } = propose(db, payload);
  assert.deepEqual(refused, []);
  return confirmAdvisorDraftsByIds(db, [proposed[0].id]).outcomes[0];
}

test('a proposal is stored open and applies nothing until confirmed', () => {
  const db = migratedTestDb();
  const { proposed } = propose(db, { kind: 'update_budget', category_id: 'cat_food', amount: 300, period: 'monthly', rollover: false });
  assert.equal(proposed.length, 1);
  assert.equal(proposed[0].route, '/plan');
  assert.deepEqual(db.prepare('SELECT status FROM advisor_drafts WHERE id = ?').get(proposed[0].id), { status: 'open' });
  assert.deepEqual(db.prepare('SELECT COUNT(*) AS n FROM budgets').get(), { n: 0 });
  assert.equal(confirmAdvisorDraftsByIds(db, [proposed[0].id]).outcomes[0].status, 'applied');
  assert.deepEqual(db.prepare("SELECT amount FROM budgets WHERE category_id = 'cat_food'").get(), { amount: 30000 });
});

test('a malformed proposal is refused with its reason and stores nothing', () => {
  const db = migratedTestDb();
  const result = proposeChanges(db, { changes: [{ label: 'Bad', summary: '', payload: { kind: 'update_budget', category_id: 'cat_food' } }, { payload: { kind: 'launch_rocket' } }] });
  assert.equal(result.proposed.length, 0);
  assert.deepEqual(result.refused.map((r) => r.index), [0, 1]);
  assert.deepEqual(db.prepare('SELECT COUNT(*) AS n FROM advisor_drafts').get(), { n: 0 });
});

test('the owner can have the advisor remove a budget, create a goal and dismiss a recurring item', () => {
  const db = migratedTestDb();
  confirmOne(db, { kind: 'update_budget', category_id: 'cat_food', amount: 300, period: 'monthly', rollover: false });
  assert.equal(confirmOne(db, { kind: 'delete_budget', category_id: 'cat_food' }).status, 'applied');
  assert.deepEqual(db.prepare('SELECT COUNT(*) AS n FROM budgets').get(), { n: 0 });

  assert.equal(confirmOne(db, { kind: 'create_goal', name: 'Laptop', type: 'savings', target_amount: 1800, target_date: '2027-06-01' }).status, 'applied');
  assert.deepEqual(db.prepare('SELECT name, target_amount, target_date FROM goals').get(), { name: 'Laptop', target_amount: 180000, target_date: '2027-06-01' });

  db.prepare(`
    INSERT INTO recurring_patterns (id, merchant_name, average_amount, frequency, last_seen, next_expected, is_active, is_confirmed, transaction_count, created_at, updated_at)
    VALUES ('p_gym', 'gym', 4000, 'monthly', '2026-09-01', '2026-10-01', 1, 0, 4, '2026-01-01', '2026-01-01')
  `).run();
  assert.equal(confirmOne(db, { kind: 'dismiss_recurring', recurring_id: 'p_gym' }).status, 'applied');
  assert.deepEqual(db.prepare("SELECT is_active FROM recurring_patterns WHERE id = 'p_gym'").get(), { is_active: 0 });
});

test('the advisor can set the wallet balance, but never hand-set a synced account balance', () => {
  const db = migratedTestDb();
  const wallet = insertAccount(db, { account_name: 'Wallet', type: 'cash', connection_type: 'manual', is_manual: 1, current_balance: 0 });
  assert.equal(confirmOne(db, { kind: 'update_account', account_id: wallet, current_balance: 85 }).status, 'applied');
  assert.deepEqual(db.prepare('SELECT current_balance FROM accounts WHERE id = ?').get(wallet), { current_balance: 8500 });

  const synced = insertAccount(db, { account_name: 'Chase', type: 'checking', connection_type: 'simplefin', is_manual: 0, current_balance: 100000 });
  const outcome = confirmOne(db, { kind: 'update_account', account_id: synced, current_balance: 5 });
  assert.equal(outcome.status, 'skipped');
  assert.deepEqual(db.prepare('SELECT current_balance FROM accounts WHERE id = ?').get(synced), { current_balance: 100000 });
});

test('memories the advisor records are marked as its own, and it cannot delete the owner\'s', () => {
  const db = migratedTestDb();
  const recorded = runAdvisorTool(db, 'remember', {
    statement: 'Prefers to keep at least $1,000 in checking',
    kind: 'constraint',
    scope: 'household',
    evidence: 'Said so in chat on 2026-10-16',
  }) as { ok: boolean };
  assert.equal(recorded.ok, true);
  assert.deepEqual(db.prepare('SELECT source FROM ai_memory').all(), [{ source: 'ai' }]);

  const owner = createMemory(db, { statement: 'Rent is paid through Zeffy', kind: 'interpretation', scope: 'household', evidence: 'Owner wrote this in Settings' }) as { ok: true; memory: { id: string } };
  assert.equal((runAdvisorTool(db, 'forget', { memory_id: owner.memory.id }) as { ok: boolean }).ok, false);
});

test('the advisor reads accounts with their balance-only flag and the categories it proposes against', () => {
  const db = migratedTestDb();
  const wallet = insertAccount(db, { account_name: 'Wallet', type: 'cash', connection_type: 'manual', is_manual: 1, current_balance: 4000 });
  db.prepare('UPDATE accounts SET balance_only = 1 WHERE id = ?').run(wallet);
  insertTransaction(db, { amount: -100 });
  const accounts = (runAdvisorTool(db, 'get_accounts', {}) as { accounts: Array<{ id: string; balance: number; balance_only: boolean }> }).accounts;
  assert.deepEqual(accounts.find((a) => a.id === wallet), { ...accounts.find((a) => a.id === wallet), balance: 40, balance_only: true });
  const categories = (runAdvisorTool(db, 'get_categories', {}) as { categories: Array<{ id: string }> }).categories;
  assert.ok(categories.some((c) => c.id === 'cat_food'));
});

test('every new ability is registered as a tool and named in the prompt', () => {
  const names = new Set(ADVISOR_TOOLS.map((tool) => tool.name));
  for (const name of ['propose_changes', 'get_accounts', 'get_categories', 'get_safe_to_spend', 'get_recurring_patterns', 'get_insights', 'get_memories', 'remember', 'forget', 'get_open_proposals']) {
    assert.ok(names.has(name), name);
  }
  assert.match(ADVISOR_SYSTEM_PROMPT, /propose_changes/);
  assert.match(ADVISOR_SYSTEM_PROMPT, /remember/);
});

test('the waiting list holds open proposals only, newest first', () => {
  const db = migratedTestDb();
  const a = propose(db, { kind: 'update_budget', category_id: 'cat_food', amount: 300, period: 'monthly', rollover: false }).proposed[0];
  const b = propose(db, { kind: 'create_goal', name: 'Trip', type: 'savings', target_amount: 900 }).proposed[0];
  const c = propose(db, { kind: 'create_goal', name: 'Bike', type: 'savings', target_amount: 400 }).proposed[0];
  db.prepare("UPDATE advisor_drafts SET created_at = '2026-10-01' WHERE id = ?").run(a.id);
  db.prepare("UPDATE advisor_drafts SET status = 'dismissed' WHERE id = ?").run(b.id);
  confirmAdvisorDraftsByIds(db, [c.id]);
  assert.deepEqual(listOpenDrafts(db).map((draft) => draft.id), [a.id]);
});
