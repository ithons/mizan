import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { analyzeAdvisorQuestion, buildAdvisorReadTools } from '../server/src/services/advisorTools';

function setupAdvisorDb(): Database.Database {
  const db = new Database(':memory:');
  const now = new Date().toISOString();

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
  `).run(now);

  db.prepare(`
    INSERT INTO accounts (
      id, connection_id, connection_type, institution_name, account_name, type, current_balance, is_hidden, is_liability
    )
    VALUES ('acct_checking', 'item_1', 'plaid', 'Mizan Test Bank', 'Everyday Checking', 'checking', 2500, 0, 0)
  `).run();

  const insertTransaction = db.prepare(`
    INSERT INTO transactions (
      id, account_id, date, amount, merchant_name, original_name, category_id, pending,
      recurring_id, review_status, duplicate_status, transfer_status, created_at, updated_at
    )
    VALUES (?, 'acct_checking', ?, ?, ?, ?, ?, 0, NULL, ?, 'none', 'none', ?, ?)
  `);

  insertTransaction.run('paycheck', '2026-06-03', 1000, 'Employer', 'Employer', 'cat_income_paycheck', 'reviewed', now, now);
  insertTransaction.run('restaurant', '2026-06-07', -100, 'Restaurant', 'Restaurant', 'cat_food_restaurants', 'reviewed', now, now);
  insertTransaction.run('uncategorized', '2026-06-08', -25, 'Mystery', 'Mystery', null, 'open', now, now);

  db.prepare(`
    INSERT INTO budgets (id, category_id, amount, period, rollover, rollover_balance, created_at, updated_at)
    VALUES ('budget_food', 'cat_food', 120, 'monthly', 0, 0, ?, ?)
  `).run(now, now);

  db.prepare(`
    INSERT INTO goals (
      id, name, type, target_amount, current_amount, starting_amount, account_id, target_date, color, is_archived, created_at, updated_at
    )
    VALUES ('goal_emergency', 'Emergency Fund', 'savings', 5000, 1500, NULL, NULL, '2026-12-31', '#4ecba3', 0, ?, ?)
  `).run(now, now);

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
