import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { format, subDays } from 'date-fns';
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
    recurringId?: string | null;
  }
): void {
  db.prepare(`
    INSERT INTO transactions (
      id, account_id, date, amount, merchant_name, original_name, category_id, pending,
      source_type, recurring_id, review_status, duplicate_status, transfer_status, created_at, updated_at
    )
    VALUES (?, 'acct_checking', ?, ?, ?, ?, ?, 0, 'manual', ?, ?, 'none', 'none', ?, ?)
  `).run(
    params.id,
    params.date,
    params.amount,
    params.merchant,
    params.merchant,
    params.categoryId,
    params.recurringId ?? null,
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

    CREATE TABLE teller_items (
      id TEXT PRIMARY KEY,
      enrollment_id TEXT UNIQUE NOT NULL,
      institution_name TEXT NOT NULL DEFAULT '',
      last_synced_at TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL
    );

    CREATE TABLE advisor_drafts (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      label TEXT NOT NULL,
      summary TEXT NOT NULL,
      route TEXT NOT NULL,
      payload TEXT NOT NULL,
      changes TEXT NOT NULL,
      citations TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'confirmed', 'dismissed')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE advisor_actions (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      label TEXT NOT NULL,
      summary TEXT NOT NULL,
      source TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE simplefin_connections (
      id TEXT PRIMARY KEY,
      access_url TEXT UNIQUE NOT NULL,
      last_synced_at TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL
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
      source_type TEXT NOT NULL DEFAULT 'manual',
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

    CREATE TABLE recurring_occurrence_adjustments (
      id TEXT PRIMARY KEY,
      recurring_id TEXT NOT NULL,
      original_date TEXT NOT NULL,
      action TEXT NOT NULL,
      adjusted_date TEXT,
      adjusted_amount REAL,
      note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(recurring_id, original_date)
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

    CREATE TABLE budget_groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE budget_group_members (
      group_id TEXT NOT NULL,
      category_id TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      PRIMARY KEY (group_id, category_id),
      UNIQUE(category_id)
    );

    CREATE TABLE budget_rollover_ledger (
      id TEXT PRIMARY KEY,
      budget_id TEXT NOT NULL,
      month TEXT NOT NULL,
      starting_rollover REAL NOT NULL,
      budget_amount REAL NOT NULL,
      actual_spend REAL NOT NULL,
      ending_rollover REAL NOT NULL,
      calculated_at TEXT NOT NULL,
      UNIQUE(budget_id, month)
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

    CREATE TABLE net_worth_snapshots (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      total_assets REAL NOT NULL DEFAULT 0,
      total_liabilities REAL NOT NULL DEFAULT 0,
      net_worth REAL NOT NULL DEFAULT 0,
      breakdown TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE securities (
      id TEXT PRIMARY KEY,
      plaid_security_id TEXT,
      ticker TEXT,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      sector TEXT,
      sector_source TEXT
    );

    CREATE TABLE holdings (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      security_id TEXT NOT NULL,
      quantity REAL NOT NULL,
      institution_price REAL NOT NULL,
      institution_value REAL NOT NULL,
      cost_basis REAL,
      manual_cost_basis REAL,
      manual_cost_basis_note TEXT,
      manual_cost_basis_updated_at TEXT,
      currency TEXT NOT NULL DEFAULT 'USD',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE investment_transactions (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      date TEXT NOT NULL,
      type TEXT NOT NULL,
      security_id TEXT,
      quantity REAL,
      price REAL,
      amount REAL NOT NULL,
      fees REAL,
      name TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE data_import_runs (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      rows_seen INTEGER NOT NULL,
      rows_imported INTEGER NOT NULL,
      rows_invalid INTEGER NOT NULL DEFAULT 0,
      duplicate_candidates INTEGER NOT NULL DEFAULT 0,
      transfer_candidates INTEGER NOT NULL DEFAULT 0,
      warnings_count INTEGER NOT NULL DEFAULT 0,
      errors_count INTEGER NOT NULL DEFAULT 0,
      summary TEXT NOT NULL,
      created_at TEXT NOT NULL
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
  db.prepare(`
    INSERT INTO accounts (
      id, connection_id, connection_type, institution_name, account_name, type, current_balance, is_hidden, is_liability
    )
    VALUES ('acct_brokerage', 'item_1', 'plaid', 'Mizan Test Bank', 'Brokerage', 'brokerage', 1500, 0, 0)
  `).run();

  insertTransaction(db, {
    id: 'paycheck',
    date: '2026-06-03',
    amount: 100000,
    merchant: 'Employer',
    categoryId: 'cat_income_paycheck',
  });
  insertTransaction(db, {
    id: 'restaurant',
    date: '2026-06-07',
    amount: -10000,
    merchant: 'Restaurant',
    categoryId: 'cat_food_restaurants',
  });
  insertTransaction(db, {
    id: 'uncategorized',
    date: '2026-06-08',
    amount: -2500,
    merchant: 'Mystery',
    categoryId: null,
    reviewStatus: 'open',
  });

  db.prepare(`
    INSERT INTO budgets (id, category_id, amount, period, rollover, rollover_balance, created_at, updated_at)
    VALUES ('budget_food', 'cat_food', 12000, 'monthly', 0, 0, ?, ?)
  `).run(TEST_NOW, TEST_NOW);

  db.prepare(`
    INSERT INTO budget_groups (id, name, color, sort_order, created_at, updated_at)
    VALUES ('group_needs', 'Needs', '#32bfa3', 0, ?, ?)
  `).run(TEST_NOW, TEST_NOW);
  db.prepare(`
    INSERT INTO budget_group_members (group_id, category_id, sort_order, created_at)
    VALUES ('group_needs', 'cat_food', 0, ?)
  `).run(TEST_NOW);

  db.prepare(`
    INSERT INTO goals (
      id, name, type, target_amount, current_amount, starting_amount, account_id, target_date, color, is_archived, created_at, updated_at
    )
    VALUES ('goal_emergency', 'Emergency Fund', 'savings', 5000, 1500, NULL, NULL, '2026-12-31', '#4ecba3', 0, ?, ?)
  `).run(TEST_NOW, TEST_NOW);

  db.prepare(`
    INSERT INTO securities (id, plaid_security_id, ticker, name, type, currency, sector, sector_source)
    VALUES
      ('sec_vti', NULL, 'VTI', 'Vanguard Total Stock Market ETF', 'etf', 'USD', 'Broad Market', 'manual'),
      ('sec_cash', NULL, 'CASH', 'Cash Sweep', 'cash', 'USD', NULL, NULL)
  `).run();
  db.prepare(`
    INSERT INTO holdings (
      id, account_id, security_id, quantity, institution_price, institution_value,
      cost_basis, manual_cost_basis, manual_cost_basis_note, manual_cost_basis_updated_at, currency, updated_at
    )
    VALUES
      ('holding_vti', 'acct_brokerage', 'sec_vti', 10, 100, 1000, 800, NULL, NULL, NULL, 'USD', ?),
      ('holding_cash', 'acct_brokerage', 'sec_cash', 500, 1, 500, NULL, NULL, NULL, NULL, 'USD', ?)
  `).run(TEST_NOW, TEST_NOW);
  db.prepare(`
    INSERT INTO investment_transactions (
      id, account_id, date, type, security_id, quantity, price, amount, fees, name, created_at
    )
    VALUES ('inv_sell', 'acct_brokerage', '2026-06-20', 'sell', 'sec_vti', 1, 100, 100, NULL, 'VTI sale', ?)
  `).run(TEST_NOW);
  db.prepare(`
    INSERT INTO data_import_runs (
      id, source, status, rows_seen, rows_imported, rows_invalid,
      duplicate_candidates, transfer_candidates, warnings_count, errors_count, summary, created_at
    )
    VALUES ('import_csv', 'csv', 'partial', 10, 8, 2, 1, 1, 2, 0, 'Imported 8 transactions with review warnings.', ?)
  `).run(TEST_NOW);

  return db;
}

test('advisor read tools summarize local availability and attention states', (t) => {
  const db = setupAdvisorDb();
  t.after(() => db.close());

  const tools = buildAdvisorReadTools(db, new Date('2026-06-30T12:00:00.000Z'));
  const byId = new Map(tools.map((tool) => [tool.id, tool]));

  assert.equal(byId.get('sync_health')?.status, 'empty');
  assert.equal(byId.get('accounts')?.count, 2);
  assert.equal(byId.get('review')?.status, 'attention');
  assert.equal(byId.get('review')?.count, 1);
  assert.equal(byId.get('budget_groups')?.count, 1);
  assert.equal(byId.get('investment_quality')?.status, 'attention');
  assert.equal(byId.get('sector_allocation')?.status, 'available');
  assert.equal(byId.get('import_audits')?.status, 'available');
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

test('advisor budget analysis uses rollover-adjusted available amount', (t) => {
  const db = setupAdvisorDb();
  t.after(() => db.close());

  db.prepare(`
    UPDATE budgets
    SET rollover = 1, created_at = '2026-05-01'
    WHERE id = 'budget_food'
  `).run();
  insertTransaction(db, {
    id: 'may_food',
    date: '2026-05-12',
    amount: -2000,
    merchant: 'May Restaurant',
    categoryId: 'cat_food_restaurants',
  });

  const analysis = analyzeAdvisorQuestion(
    db,
    'How am I doing against budget?',
    new Date(TEST_NOW)
  );

  assert.equal(analysis.intent, 'budget');
  assert.match(analysis.answer, /Food: projected \$100\.00 of \$220\.00, \$120\.00 remaining\./);
  assert.match(analysis.answer, /Budget groups/);
  assert.match(analysis.answer, /Recent rollover ledger/);
  assert.ok(analysis.citations.some((citation) => citation.id === 'budget:budget_food'));
  assert.ok(analysis.citations.some((citation) => citation.id === 'budget-group:group_needs'));
  assert.ok(analysis.citations.some((citation) => citation.id.startsWith('rollover-ledger:')));
});

test('advisor investment analysis cites cost basis and sector quality', (t) => {
  const db = setupAdvisorDb();
  t.after(() => db.close());

  const analysis = analyzeAdvisorQuestion(
    db,
    'How is my investment cost basis and sector allocation quality?',
    new Date(TEST_NOW)
  );

  assert.equal(analysis.intent, 'investments');
  assert.match(analysis.answer, /Cost basis is available for 1\/2 holdings/);
  assert.match(analysis.answer, /lack sector metadata/);
  assert.match(analysis.answer, /realized gain stays unavailable/);
  assert.ok(analysis.citations.some((citation) => citation.id === 'holding:cost-basis:holding_cash'));
  assert.ok(analysis.citations.some((citation) => citation.id === 'holding:sector:holding_cash'));
});

test('advisor import analysis cites audit runs', (t) => {
  const db = setupAdvisorDb();
  t.after(() => db.close());

  const analysis = analyzeAdvisorQuestion(
    db,
    'Explain my latest CSV import audit',
    new Date(TEST_NOW)
  );

  assert.equal(analysis.intent, 'imports');
  assert.match(analysis.answer, /imported 8\/10 rows/);
  assert.ok(analysis.citations.some((citation) => citation.id === 'import-run:import_csv'));
});

test('advisor quality analysis cites local trust issues', (t) => {
  const db = setupAdvisorDb();
  t.after(() => db.close());

  const analysis = analyzeAdvisorQuestion(
    db,
    'Can I trust the data quality right now?',
    new Date(TEST_NOW)
  );

  assert.equal(analysis.intent, 'quality');
  assert.match(analysis.answer, /Data quality is/);
  assert.ok(analysis.citations.some((citation) => citation.kind === 'data_quality'));
  assert.ok(analysis.citations.some((citation) => citation.id === 'data-quality:transaction-review'));
});

test('advisor subscription analysis cites recurring subscription evidence', (t) => {
  const db = setupAdvisorDb();
  t.after(() => db.close());

  db.prepare(`
    INSERT INTO recurring_patterns (
      id, merchant_name, category_id, average_amount, frequency, last_seen, next_expected,
      is_active, is_confirmed, transaction_count, created_at, updated_at
    )
    VALUES ('rec_streaming', 'Streaming', 'cat_food', 1500, 'monthly', ?, ?, 1, 1, 4, ?, ?)
  `).run(
    format(subDays(new Date(), 30), 'yyyy-MM-dd'),
    format(new Date(), 'yyyy-MM-dd'),
    TEST_NOW,
    TEST_NOW
  );
  insertTransaction(db, {
    id: 'streaming_1',
    date: format(subDays(new Date(), 90), 'yyyy-MM-dd'),
    amount: -1500,
    merchant: 'Streaming',
    categoryId: 'cat_food',
    recurringId: 'rec_streaming',
  });
  insertTransaction(db, {
    id: 'streaming_2',
    date: format(subDays(new Date(), 60), 'yyyy-MM-dd'),
    amount: -1500,
    merchant: 'Streaming',
    categoryId: 'cat_food',
    recurringId: 'rec_streaming',
  });
  insertTransaction(db, {
    id: 'streaming_3',
    date: format(subDays(new Date(), 30), 'yyyy-MM-dd'),
    amount: -1900,
    merchant: 'Streaming',
    categoryId: 'cat_food',
    recurringId: 'rec_streaming',
  });

  const analysis = analyzeAdvisorQuestion(
    db,
    'What subscriptions or price increases should I review?',
    new Date(TEST_NOW)
  );

  assert.equal(analysis.intent, 'subscriptions');
  assert.match(analysis.answer, /subscription-like recurring bill/);
  assert.match(analysis.answer, /Price increases/);
  assert.ok(analysis.citations.some((citation) => citation.id === 'subscription:rec_streaming'));
});

test('advisor recurring analysis cites adjusted occurrences', (t) => {
  const db = setupAdvisorDb();
  t.after(() => db.close());

  const today = format(new Date(), 'yyyy-MM-dd');
  db.prepare(`
    INSERT INTO recurring_patterns (
      id, merchant_name, category_id, average_amount, frequency, last_seen, next_expected,
      is_active, is_confirmed, transaction_count, created_at, updated_at
    )
    VALUES ('rec_rent', 'Rent', 'cat_food', 1000, 'monthly', ?, ?, 1, 1, 4, ?, ?)
  `).run(today, today, TEST_NOW, TEST_NOW);
  db.prepare(`
    INSERT INTO recurring_occurrence_adjustments (
      id, recurring_id, original_date, action, adjusted_date, adjusted_amount, note, created_at, updated_at
    )
    VALUES ('adj_rent', 'rec_rent', ?, 'adjust', NULL, -900, NULL, ?, ?)
  `).run(today, TEST_NOW, TEST_NOW);

  const analysis = analyzeAdvisorQuestion(
    db,
    'What bills are coming up?',
    new Date(TEST_NOW)
  );

  assert.equal(analysis.intent, 'recurring');
  assert.match(analysis.answer, /Adjusted occurrences: Rent amount adjustment/);
  assert.ok(analysis.citations.some((citation) =>
    citation.id.includes('rec_rent') && citation.detail?.includes('amount adjustment')
  ));
});

test('advisor anomaly analysis cites unusual report signals', (t) => {
  const db = setupAdvisorDb();
  t.after(() => db.close());

  insertTransaction(db, {
    id: 'previous_paycheck',
    date: '2026-05-25',
    amount: 300000,
    merchant: 'Employer',
    categoryId: 'cat_income_paycheck',
  });

  const analysis = analyzeAdvisorQuestion(
    db,
    'Are there any unusual income gaps?',
    new Date(TEST_NOW)
  );

  assert.equal(analysis.intent, 'insights');
  assert.match(analysis.answer, /Income gap detected/);
  assert.ok(analysis.citations.some((citation) => citation.id === 'insight:income-gap'));
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
  assert.equal(budget.amount, 20000);

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
  assert.equal(goal.target_amount, 600000);
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

test('advisor drafts and confirms budget group changes', (t) => {
  const db = setupAdvisorDb();
  t.after(() => db.close());

  const createAnalysis = analyzeAdvisorQuestion(
    db,
    'Create budget group called Fun',
    new Date(TEST_NOW)
  );
  const createDraft = createAnalysis.drafts.find((item) => item.kind === 'create_budget_group');
  assert.ok(createDraft);
  confirmAdvisorDraft(db, createDraft, true);

  const created = db.prepare('SELECT id FROM budget_groups WHERE name = ?').get('Fun') as { id: string };
  assert.ok(created.id);

  const renameAnalysis = analyzeAdvisorQuestion(
    db,
    'Rename Needs group to Essentials',
    new Date(TEST_NOW)
  );
  const renameDraft = renameAnalysis.drafts.find((item) => item.kind === 'rename_budget_group');
  assert.ok(renameDraft);
  confirmAdvisorDraft(db, renameDraft, true);

  const renamed = db.prepare('SELECT name FROM budget_groups WHERE id = ?').get('group_needs') as { name: string };
  assert.equal(renamed.name, 'Essentials');

  const assignAnalysis = analyzeAdvisorQuestion(
    db,
    'Add Restaurants to Essentials group',
    new Date(TEST_NOW)
  );
  const assignDraft = assignAnalysis.drafts.find((item) => item.kind === 'assign_category_to_budget_group');
  assert.ok(assignDraft);
  confirmAdvisorDraft(db, assignDraft, true);

  const member = db.prepare(`
    SELECT group_id
    FROM budget_group_members
    WHERE category_id = 'cat_food_restaurants'
  `).get() as { group_id: string };
  assert.equal(member.group_id, 'group_needs');
});

test('advisor drafts and confirms recurring occurrence adjustments', (t) => {
  const db = setupAdvisorDb();
  t.after(() => db.close());

  db.prepare(`
    INSERT INTO recurring_patterns (
      id, merchant_name, category_id, average_amount, frequency, last_seen, next_expected,
      is_active, is_confirmed, transaction_count, created_at, updated_at
    )
    VALUES ('rec_rent', 'Rent', 'cat_food', 1000, 'monthly', '2026-06-01', '2026-07-01', 1, 1, 4, ?, ?)
  `).run(TEST_NOW, TEST_NOW);

  const analysis = analyzeAdvisorQuestion(
    db,
    'Skip recurring Rent on 2026-07-01',
    new Date(TEST_NOW)
  );
  const draft = analysis.drafts.find((item) => item.kind === 'create_recurring_adjustment');
  assert.ok(draft);
  confirmAdvisorDraft(db, draft, true);

  const adjustment = db.prepare(`
    SELECT action, original_date
    FROM recurring_occurrence_adjustments
    WHERE recurring_id = 'rec_rent'
  `).get() as { action: string; original_date: string };
  assert.equal(adjustment.action, 'skip');
  assert.equal(adjustment.original_date, '2026-07-01');
});

test('advisor drafts and confirms investment metadata changes', (t) => {
  const db = setupAdvisorDb();
  t.after(() => db.close());

  const basisAnalysis = analyzeAdvisorQuestion(
    db,
    'Set CASH cost basis to $500',
    new Date(TEST_NOW)
  );
  const basisDraft = basisAnalysis.drafts.find((item) => item.kind === 'set_manual_cost_basis');
  assert.ok(basisDraft);
  confirmAdvisorDraft(db, basisDraft, true);

  const holding = db.prepare('SELECT manual_cost_basis FROM holdings WHERE id = ?').get('holding_cash') as {
    manual_cost_basis: number;
  };
  assert.equal(holding.manual_cost_basis, 50000);

  const sectorAnalysis = analyzeAdvisorQuestion(
    db,
    'Set CASH sector to Cash',
    new Date(TEST_NOW)
  );
  const sectorDraft = sectorAnalysis.drafts.find((item) => item.kind === 'set_sector_metadata');
  assert.ok(sectorDraft);
  confirmAdvisorDraft(db, sectorDraft, true);

  const security = db.prepare('SELECT sector, sector_source FROM securities WHERE id = ?').get('sec_cash') as {
    sector: string;
    sector_source: string;
  };
  assert.equal(security.sector, 'Cash');
  assert.equal(security.sector_source, 'manual');
});
