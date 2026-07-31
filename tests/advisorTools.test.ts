import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { format, subDays } from 'date-fns';
import { migratedTestDb, insertAccount } from './helpers/schema';
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
  const db = migratedTestDb();

  // `connection_type` is CHECK-constrained to coinbase/simplefin/manual, and the hand-written
  // schema this replaced still declared the `plaid_items` and `teller_items` tables migration 014
  // dropped and filed both accounts under a 'plaid' connection type production cannot store.
  insertAccount(db, {
    id: 'acct_checking', account_name: 'Everyday Checking', institution_name: 'Mizan Test Bank',
    current_balance: 2500,
  });
  insertAccount(db, {
    id: 'acct_brokerage', account_name: 'Brokerage', institution_name: 'Mizan Test Bank',
    type: 'brokerage', current_balance: 1500,
  });

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
    INSERT INTO goals (
      id, name, type, target_amount, current_amount, starting_amount, account_id, target_date, color, is_archived, created_at, updated_at
    )
    VALUES ('goal_emergency', 'Emergency Fund', 'savings', 5000, 1500, NULL, NULL, '2026-12-31', '#4ecba3', 0, ?, ?)
  `).run(TEST_NOW, TEST_NOW);

  db.prepare(`
    INSERT INTO securities (id, ticker, name, type, currency, sector, sector_source)
    VALUES
      ('sec_vti', 'VTI', 'Vanguard Total Stock Market ETF', 'etf', 'USD', 'Broad Market', 'manual'),
      ('sec_cash', 'CASH', 'Cash Sweep', 'cash', 'USD', NULL, NULL)
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
  assert.match(analysis.answer, /Food & Drink: projected \$100\.00 of \$220\.00, \$120\.00 remaining\./);
  assert.match(analysis.answer, /Recent rollover ledger/);
  assert.ok(analysis.citations.some((citation) => citation.id === 'budget:budget_food'));
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
    'Categorize Mystery as Food & Drink',
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
    'Set Food & Drink budget to $200',
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
