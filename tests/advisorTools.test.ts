import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { confirmAdvisorDraft } from '../server/src/services/advisorDrafts';
import { analyzeAdvisorQuestion, buildAdvisorReadTools } from '../server/src/services/advisorTools';

const TEST_NOW = '2026-06-30T12:00:00.000Z';

function insertTransaction(
  db: Database.Database,
  params: {
    id: string;
    date: string;
    amount: number;
    merchant: string;
    categoryId: string | null;
    reviewStatus?: 'open' | 'reviewed';
  }
): void {
  db.prepare(`
    INSERT INTO transactions (
      id, account_id, date, amount, merchant_name, original_name, category_id, pending,
      recurring_id, review_status, duplicate_status, transfer_status, created_at, updated_at
    )
    VALUES (?, 'acct_checking', ?, ?, ?, ?, ?, 0, NULL, ?, 'none', 'none', ?, ?)
  `).run(
    params.id,
    params.date,
    params.amount,
    params.merchant,
    params.merchant,
    params.categoryId,
    params.reviewStatus ?? 'reviewed',
    TEST_NOW,
    TEST_NOW
  );
}

function setupAdvisorDb(): Database.Database {
  const db = new Database(':memory:');

  db.exec(`
    CREATE TABLE categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      icon TEXT,
      color TEXT,
      parent_id TEXT,
      is_income INTEGER NOT NULL DEFAULT 0,
      is_investment INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      connection_id TEXT,
      connection_type TEXT NOT NULL DEFAULT 'manual',
      institution_name TEXT NOT NULL,
      account_name TEXT NOT NULL,
      type TEXT NOT NULL,
      current_balance REAL NOT NULL DEFAULT 0,
      is_hidden INTEGER NOT NULL DEFAULT 0,
      is_liability INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE plaid_items (
      id TEXT PRIMARY KEY,
      institution_name TEXT,
      status TEXT NOT NULL,
      last_synced_at TEXT
    );

    CREATE TABLE coinbase_connections (
      id TEXT PRIMARY KEY,
      display_name TEXT,
      status TEXT NOT NULL,
      last_synced_at TEXT
    );

    CREATE TABLE transactions (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      date TEXT NOT NULL,
      amount REAL NOT NULL,
      merchant_name TEXT,
      original_name TEXT NOT NULL,
      category_id TEXT,
      pending INTEGER NOT NULL DEFAULT 0,
      recurring_id TEXT,
      review_status TEXT NOT NULL DEFAULT 'open',
      duplicate_group_id TEXT,
      duplicate_status TEXT NOT NULL DEFAULT 'none',
      transfer_pair_id TEXT,
      transfer_status TEXT NOT NULL DEFAULT 'none',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE merchant_rules (
      id TEXT PRIMARY KEY,
      pattern TEXT NOT NULL,
      category_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE recurring_patterns (
      id TEXT PRIMARY KEY,
      merchant_name TEXT NOT NULL,
      category_id TEXT,
      average_amount REAL NOT NULL,
      frequency TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      next_expected TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      is_confirmed INTEGER NOT NULL DEFAULT 0,
      transaction_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE budgets (
      id TEXT PRIMARY KEY,
      category_id TEXT NOT NULL,
      amount REAL NOT NULL,
      period TEXT NOT NULL,
      rollover INTEGER NOT NULL DEFAULT 0,
      rollover_balance REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE goals (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      target_amount REAL NOT NULL,
      current_amount REAL NOT NULL DEFAULT 0,
      starting_amount REAL,
      account_id TEXT,
      target_date TEXT,
      color TEXT,
      is_archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  db.prepare(`
    INSERT INTO categories (id, name, color, parent_id, is_income, is_investment)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('cat_income_paycheck', 'Paycheck', '#4ecba3', null, 1, 0);
  db.prepare(`
    INSERT INTO categories (id, name, color, parent_id, is_income, is_investment)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('cat_food', 'Food', '#e07070', null, 0, 0);
  db.prepare(`
    INSERT INTO categories (id, name, color, parent_id, is_income, is_investment)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('cat_food_restaurants', 'Restaurants', '#e07070', 'cat_food', 0, 0);
  for (const id of ['cat_xfer', 'cat_inv', 'cat_crypto']) {
    db.prepare(`
      INSERT INTO categories (id, name, color, parent_id, is_income, is_investment)
      VALUES (?, ?, ?, NULL, 0, ?)
    `).run(id, id, '#6b6b7a', id === 'cat_inv' ? 1 : 0);
  }

  db.prepare(`
    INSERT INTO plaid_items (id, institution_name, status, last_synced_at)
    VALUES ('item_1', 'Mizan Test Bank', 'active', ?)
  `).run(TEST_NOW);

  db.prepare(`
    INSERT INTO accounts (
      id, connection_id, connection_type, institution_name, account_name, type, current_balance, is_hidden, is_liability
    )
    VALUES ('acct_checking', 'item_1', 'plaid', 'Mizan Test Bank', 'Everyday Checking', 'checking', 2500, 0, 0)
  `).run();

  insertTransaction(db, {
    id: 'paycheck',
    date: '2026-06-03',
    amount: 1000,
    merchant: 'Employer',
    categoryId: 'cat_income_paycheck',
  });
  insertTransaction(db, {
    id: 'restaurant',
    date: '2026-06-07',
    amount: -100,
    merchant: 'Restaurant',
    categoryId: 'cat_food_restaurants',
  });
  insertTransaction(db, {
    id: 'uncategorized',
    date: '2026-06-08',
    amount: -25,
    merchant: 'Mystery',
    categoryId: null,
    reviewStatus: 'open',
  });

  db.prepare(`
    INSERT INTO budgets (id, category_id, amount, period, rollover, rollover_balance, created_at, updated_at)
    VALUES ('budget_food', 'cat_food', 120, 'monthly', 0, 0, ?, ?)
  `).run(TEST_NOW, TEST_NOW);

  db.prepare(`
    INSERT INTO goals (
      id, name, type, target_amount, current_amount, starting_amount, account_id, target_date, color, is_archived, created_at, updated_at
    )
    VALUES ('goal_emergency', 'Emergency Fund', 'savings', 5000, 1500, NULL, NULL, '2026-12-31', '#4ecba3', 0, ?, ?)
  `).run(TEST_NOW, TEST_NOW);

  return db;
}

test('advisor read tools summarize local availability and attention states', (t) => {
  const db = setupAdvisorDb();
  t.after(() => db.close());

  const tools = buildAdvisorReadTools(db, new Date('2026-06-30T12:00:00.000Z'));
  const byId = new Map(tools.map((tool) => [tool.id, tool]));

  assert.equal(byId.get('sync_health')?.status, 'available');
  assert.equal(byId.get('accounts')?.count, 1);
  assert.equal(byId.get('review')?.status, 'attention');
  assert.equal(byId.get('review')?.count, 1);
});

test('advisor report analysis cites the report slice and backing categories', (t) => {
  const db = setupAdvisorDb();
  t.after(() => db.close());

  const analysis = analyzeAdvisorQuestion(
    db,
    'What changed in my cash flow this month?',
    new Date('2026-06-30T12:00:00.000Z')
  );

  assert.equal(analysis.intent, 'reports');
  assert.match(analysis.answer, /Mizān sees \$1\.0k income/);
  assert.ok(analysis.citations.some((citation) => citation.id.startsWith('report:summary:')));
  assert.ok(analysis.citations.some((citation) => citation.record_id === 'cat_food'));
});

test('advisor review analysis cites the Review Inbox queues', (t) => {
  const db = setupAdvisorDb();
  t.after(() => db.close());

  const analysis = analyzeAdvisorQuestion(
    db,
    'What transactions need review?',
    new Date('2026-06-30T12:00:00.000Z')
  );

  assert.equal(analysis.intent, 'review');
  assert.match(analysis.answer, /1 open review item/);
  assert.ok(analysis.citations.some((citation) => citation.id === 'review:uncategorized'));
});

test('advisor drafts and confirms a transaction category change', (t) => {
  const db = setupAdvisorDb();
  t.after(() => db.close());

  const analysis = analyzeAdvisorQuestion(
    db,
    'Categorize Mystery as Food',
    new Date(TEST_NOW)
  );
  const draft = analysis.drafts.find((item) => item.kind === 'categorize_transaction');
  assert.ok(draft);

  confirmAdvisorDraft(db, draft, true);

  const transaction = db.prepare('SELECT category_id, review_status FROM transactions WHERE id = ?').get('uncategorized') as {
    category_id: string;
    review_status: string;
  };
  assert.equal(transaction.category_id, 'cat_food');
  assert.equal(transaction.review_status, 'reviewed');
});

test('advisor drafts and confirms budget and goal updates', (t) => {
  const db = setupAdvisorDb();
  t.after(() => db.close());

  const budgetAnalysis = analyzeAdvisorQuestion(
    db,
    'Set Food budget to $200',
    new Date(TEST_NOW)
  );
  const budgetDraft = budgetAnalysis.drafts.find((item) => item.kind === 'update_budget');
  assert.ok(budgetDraft);
  confirmAdvisorDraft(db, budgetDraft, true);

  const budget = db.prepare('SELECT amount FROM budgets WHERE id = ?').get('budget_food') as { amount: number };
  assert.equal(budget.amount, 200);

  const goalAnalysis = analyzeAdvisorQuestion(
    db,
    'Set Emergency Fund goal target to $6000',
    new Date(TEST_NOW)
  );
  const goalDraft = goalAnalysis.drafts.find((item) => item.kind === 'update_goal_target');
  assert.ok(goalDraft);
  confirmAdvisorDraft(db, goalDraft, true);

  const goal = db.prepare('SELECT target_amount FROM goals WHERE id = ?').get('goal_emergency') as {
    target_amount: number;
  };
  assert.equal(goal.target_amount, 6000);
});

test('advisor draft confirmation requires explicit confirmation', (t) => {
  const db = setupAdvisorDb();
  t.after(() => db.close());

  db.prepare(`
    INSERT INTO recurring_patterns (
      id, merchant_name, category_id, average_amount, frequency, last_seen, next_expected,
      is_active, is_confirmed, transaction_count, created_at, updated_at
    )
    VALUES ('rec_gym', 'Gym Club', 'cat_food', 40, 'monthly', '2026-06-01', '2026-07-01', 1, 0, 3, ?, ?)
  `).run(TEST_NOW, TEST_NOW);

  const analysis = analyzeAdvisorQuestion(
    db,
    'Confirm recurring Gym Club',
    new Date(TEST_NOW)
  );
  const draft = analysis.drafts.find((item) => item.kind === 'confirm_recurring');
  assert.ok(draft);
  assert.throws(() => confirmAdvisorDraft(db, draft, false), /Explicit confirmation/);

  confirmAdvisorDraft(db, draft, true);
  const recurring = db.prepare('SELECT is_confirmed FROM recurring_patterns WHERE id = ?').get('rec_gym') as {
    is_confirmed: number;
  };
  assert.equal(recurring.is_confirmed, 1);
});

test('advisor drafts and confirms a suggested merchant rule', (t) => {
  const db = setupAdvisorDb();
  t.after(() => db.close());

  insertTransaction(db, {
    id: 'coffee_1',
    date: '2026-06-09',
    amount: -6,
    merchant: 'Coffee Shop',
    categoryId: 'cat_food',
  });
  insertTransaction(db, {
    id: 'coffee_2',
    date: '2026-06-10',
    amount: -7,
    merchant: 'Coffee Shop',
    categoryId: 'cat_food',
  });
  insertTransaction(db, {
    id: 'coffee_3',
    date: '2026-06-11',
    amount: -8,
    merchant: 'Coffee Shop',
    categoryId: null,
    reviewStatus: 'open',
  });

  const analysis = analyzeAdvisorQuestion(
    db,
    'Review rule suggestions',
    new Date(TEST_NOW)
  );
  const draft = analysis.drafts.find((item) => item.kind === 'create_merchant_rule');
  assert.ok(draft);

  confirmAdvisorDraft(db, draft, true);

  const rule = db.prepare('SELECT category_id FROM merchant_rules WHERE lower(pattern) = lower(?)').get('Coffee Shop') as {
    category_id: string;
  };
  const updated = db.prepare('SELECT category_id FROM transactions WHERE id = ?').get('coffee_3') as {
    category_id: string;
  };
  assert.equal(rule.category_id, 'cat_food');
  assert.equal(updated.category_id, 'cat_food');
});
