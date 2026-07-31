import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  confirmAdvisorDraft,
  isAutonomousDraftKind,
  undoAdvisorAction,
} from '../server/src/services/advisorDrafts';
import { updateTransaction } from '../server/src/services/transactions';
import type { AdvisorDraftAction, AdvisorDraftPayload } from '../shared/types';

// The AI applies categorization and merchant rules with no human in the loop. That is only safe
// if a bad batch is findable and reversible, which is what the provenance columns are for
// (migration 041). These tests pin the boundary and the undo path together, because either one
// alone is worthless: autonomy without undo is unrecoverable, undo without provenance can't
// find the rows.

function setup(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE categories (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT,
      is_income INTEGER NOT NULL DEFAULT 0, is_investment INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE accounts (id TEXT PRIMARY KEY, account_name TEXT NOT NULL);
    CREATE TABLE transactions (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL, date TEXT NOT NULL, amount INTEGER NOT NULL,
      merchant_name TEXT, original_name TEXT NOT NULL DEFAULT '', category_id TEXT, notes TEXT,
      pending INTEGER NOT NULL DEFAULT 0, is_manual INTEGER NOT NULL DEFAULT 0, recurring_id TEXT,
      duplicate_group_id TEXT, duplicate_status TEXT NOT NULL DEFAULT 'none',
      transfer_pair_id TEXT, transfer_status TEXT NOT NULL DEFAULT 'none',
      review_status TEXT NOT NULL DEFAULT 'open', manually_categorized INTEGER NOT NULL DEFAULT 0,
      -- confirmCategorizeTransaction re-runs duplicate/transfer detection, which reads this.
      source_type TEXT NOT NULL DEFAULT 'manual',
      category_source TEXT, category_action_id TEXT, category_previous_id TEXT,
      created_at TEXT NOT NULL DEFAULT '2026-07-01', updated_at TEXT NOT NULL DEFAULT '2026-07-01'
    );
    CREATE TABLE merchant_rules (
      id TEXT PRIMARY KEY,
      pattern TEXT NOT NULL,
      category_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'human',
      action_id TEXT,
      updated_at TEXT,
      retired_at TEXT
    );
    CREATE UNIQUE INDEX idx_merchant_rules_pattern_live
      ON merchant_rules(lower(pattern)) WHERE retired_at IS NULL;
    CREATE TABLE merchant_rule_revisions (
      id TEXT PRIMARY KEY, rule_id TEXT NOT NULL, pattern TEXT NOT NULL,
      from_category_id TEXT, to_category_id TEXT, source TEXT NOT NULL,
      action_id TEXT, operation TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE transaction_category_revisions (
      id TEXT PRIMARY KEY, transaction_id TEXT NOT NULL,
      from_category_id TEXT, to_category_id TEXT, from_source TEXT, to_source TEXT,
      action_id TEXT, revert_of TEXT, reverted_at TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE advisor_drafts (
      id TEXT PRIMARY KEY, kind TEXT, label TEXT, summary TEXT, route TEXT, payload TEXT,
      changes TEXT, citations TEXT, status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL DEFAULT '2026-07-01', updated_at TEXT NOT NULL DEFAULT '2026-07-01'
    );
    CREATE TABLE advisor_actions (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, label TEXT NOT NULL, summary TEXT NOT NULL,
      source TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL
    );
    -- undoAdvisorAction records the reversal here (migration 047). See tests/aiFeedback.test.ts for
    -- what it writes; this schema only has to exist for the undo path to complete.
    CREATE TABLE ai_feedback (
      id TEXT PRIMARY KEY, signal TEXT NOT NULL, proposal_kind TEXT NOT NULL,
      action_id TEXT, draft_id TEXT, transaction_id TEXT, merchant_name TEXT,
      proposed_category_id TEXT, proposed_pattern TEXT, proposal_summary TEXT,
      owner_choice TEXT NOT NULL, owner_category_id TEXT,
      affected_transactions INTEGER NOT NULL DEFAULT 0, stale INTEGER,
      created_at TEXT NOT NULL
    );
    CREATE TABLE budgets (
      id TEXT PRIMARY KEY, category_id TEXT NOT NULL, amount INTEGER NOT NULL,
      period TEXT NOT NULL DEFAULT 'monthly', rollover INTEGER NOT NULL DEFAULT 0,
      rollover_balance INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT '2026-07-01', updated_at TEXT NOT NULL DEFAULT '2026-07-01'
    );
  `);
  db.prepare("INSERT INTO accounts VALUES ('acct','Checking')").run();
  const cat = db.prepare('INSERT INTO categories (id,name,parent_id) VALUES (?,?,?)');
  cat.run('cat_food', 'Food & Drink', null);
  cat.run('cat_food_coffee', 'Coffee & Tea', 'cat_food');
  cat.run('cat_shop', 'Shopping', null);
  cat.run('cat_xfer', 'Transfers', null);
  cat.run('cat_xfer_in', 'Transfer In', 'cat_xfer');
  cat.run('cat_xfer_out', 'Transfer Out', 'cat_xfer');
  return db;
}

function txn(db: Database.Database, id: string, merchant: string, categoryId: string | null = null): void {
  db.prepare(`
    INSERT INTO transactions (id, account_id, date, amount, merchant_name, original_name, category_id)
    VALUES (?, 'acct', '2026-07-10', -1200, ?, ?, ?)
  `).run(id, merchant, merchant, categoryId);
}

function draft(payload: AdvisorDraftPayload): AdvisorDraftAction {
  return {
    id: `draft_${payload.kind}`,
    kind: payload.kind,
    label: 'test draft',
    summary: 'test draft',
    route: '/transactions',
    payload,
    changes: [],
    citations: [],
    confirmation_required: true,
  } as AdvisorDraftAction;
}

test('the autonomy boundary is drawn by domain, not by confidence', () => {
  // Observations about existing data: the model reads a merchant name and says what it is.
  assert.equal(isAutonomousDraftKind('categorize_transaction'), true);
  assert.equal(isAutonomousDraftKind('create_merchant_rule'), true);

  // Targets the owner set. The model cannot know the intent behind the number.
  for (const kind of [
    'update_budget',
    'update_goal_target',
    'confirm_recurring',
    'create_budget_group',
    'rename_budget_group',
    'assign_category_to_budget_group',
    'create_recurring_adjustment',
    'set_manual_cost_basis',
    'set_sector_metadata',
  ]) {
    assert.equal(isAutonomousDraftKind(kind), false, `${kind} must require confirmation`);
  }
});

test('an AI categorization stamps provenance and the action id on the row', () => {
  const db = setup();
  txn(db, 't1', 'Blue Bottle');

  const res = confirmAdvisorDraft(
    db,
    draft({ kind: 'categorize_transaction', transaction_id: 't1', category_id: 'cat_food_coffee' }),
    true,
    'worker_auto'
  );
  assert.equal(res.changed, 1);

  const row = db.prepare('SELECT * FROM transactions WHERE id = ?').get('t1') as Record<string, unknown>;
  assert.equal(row.category_id, 'cat_food_coffee');
  assert.equal(row.category_source, 'ai');
  assert.equal(row.category_previous_id, null, 'it was uncategorized before');

  const action = db.prepare('SELECT id FROM advisor_actions').get() as { id: string };
  assert.equal(row.category_action_id, action.id, 'the row points at the action that set it');
  db.close();
});

test('an AI categorization no longer mints a merchant rule as a side effect', () => {
  const db = setup();
  txn(db, 't1', 'PURCHASE AUTHORIZED ON 07/10 SQ *SOME CAFE 4471');

  confirmAdvisorDraft(
    db,
    draft({ kind: 'categorize_transaction', transaction_id: 't1', category_id: 'cat_food_coffee' }),
    true,
    'worker_auto'
  );

  // It used to build a rule from raw bank description text on every categorization and match it
  // fuzzily across the whole ledger. Unattended, that installs standing rules nobody asked for.
  const rules = db.prepare('SELECT COUNT(*) AS n FROM merchant_rules').get() as { n: number };
  assert.equal(rules.n, 0);
  db.close();
});

test('undo reverts every row a rule application swept in, not just the one proposed', () => {
  const db = setup();
  txn(db, 't1', 'Blue Bottle Coffee');
  txn(db, 't2', 'Blue Bottle Coffee');
  txn(db, 't3', 'Blue Bottle Coffee');
  txn(db, 'other', 'Shell Gas');

  confirmAdvisorDraft(
    db,
    draft({ kind: 'create_merchant_rule', pattern: 'Blue Bottle Coffee', category_id: 'cat_food_coffee', apply_existing: true }),
    true,
    'worker_auto'
  );

  const categorized = db.prepare(
    "SELECT COUNT(*) AS n FROM transactions WHERE category_id = 'cat_food_coffee'"
  ).get() as { n: number };
  assert.equal(categorized.n, 3, 'the rule swept in all three matching rows');

  const action = db.prepare('SELECT id FROM advisor_actions').get() as { id: string };
  const undone = undoAdvisorAction(db, action.id);
  assert.equal(undone.ok, true);
  assert.equal(undone.reverted, 3, 'undo covers the whole blast radius, not one row');

  const after = db.prepare(
    'SELECT COUNT(*) AS n FROM transactions WHERE category_id IS NOT NULL'
  ).get() as { n: number };
  assert.equal(after.n, 0);

  // The rule itself survives: deleting it would be a second unasked change, and it is visible
  // and removable in Settings.
  const rules = db.prepare('SELECT COUNT(*) AS n FROM merchant_rules').get() as { n: number };
  assert.equal(rules.n, 1);
  db.close();
});

test('undo restores the displaced category rather than clearing to uncategorized', () => {
  const db = setup();
  txn(db, 't1', 'Blue Bottle', 'cat_shop'); // already categorized, wrongly

  confirmAdvisorDraft(
    db,
    draft({ kind: 'categorize_transaction', transaction_id: 't1', category_id: 'cat_food_coffee' }),
    true,
    'worker_auto'
  );
  const action = db.prepare('SELECT id FROM advisor_actions').get() as { id: string };
  undoAdvisorAction(db, action.id);

  const row = db.prepare('SELECT category_id, category_action_id FROM transactions WHERE id = ?').get('t1') as {
    category_id: string | null; category_action_id: string | null;
  };
  assert.equal(row.category_id, 'cat_shop', 'the prior category comes back, not NULL');
  assert.equal(row.category_action_id, null);
  db.close();
});

test('undo does not reach back through a hand edit made after the fact', () => {
  const db = setup();
  txn(db, 't1', 'Blue Bottle');

  confirmAdvisorDraft(
    db,
    draft({ kind: 'categorize_transaction', transaction_id: 't1', category_id: 'cat_food_coffee' }),
    true,
    'worker_auto'
  );

  // The user disagrees and fixes it by hand. That is now the current truth.
  const updated = updateTransaction(db, 't1', { category_id: 'cat_shop' });
  assert.equal(updated.ok, true);

  const action = db.prepare('SELECT id FROM advisor_actions').get() as { id: string };
  const undone = undoAdvisorAction(db, action.id);

  assert.equal(undone.ok, false);
  assert.equal(undone.reason, 'nothing_to_undo');
  const row = db.prepare('SELECT category_id, category_source FROM transactions WHERE id = ?').get('t1') as {
    category_id: string; category_source: string;
  };
  assert.equal(row.category_id, 'cat_shop', 'the human decision stands');
  assert.equal(row.category_source, 'human');
  db.close();
});

test('undoing an unknown action is a 404, not a silent no-op', () => {
  const db = setup();
  const res = undoAdvisorAction(db, 'nope');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'not_found');
  db.close();
});
