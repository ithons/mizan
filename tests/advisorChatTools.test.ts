import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  ADVISOR_TOOLS,
  CHAT_TOOL_ACTION_PREFIX,
  CHAT_WRITE_KINDS,
  runAdvisorTool,
} from '../server/src/services/advisorChatTools';

// The aggregate tools delegate to reporting.ts / budgetProjection.ts / recurringForecast.ts, so
// this fixture carries the columns those services read: the exclusion flags
// (transfer_status, duplicate_status), the category classification flags, and the rollover /
// recurring tables. A tool that needs a column this schema lacks is a tool that started running
// its own SQL again.
function setup(): Database.Database {
  const db = migratedTestDb();
  insertAccount(db, { id: 'chk', account_name: 'Checking', institution_name: 'Bank' });
  const ins = db.prepare(`INSERT INTO transactions (id,account_id,date,amount,merchant_name,original_name,category_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?, '2026-06-01', '2026-06-01')`);
  ins.run('t1','chk','2026-06-05',-2500,'Cafe','Cafe','cat_food_restaurants');       // $25 expense
  ins.run('t2','chk','2026-06-10',-1000,'Diner','Diner','cat_food_restaurants');     // $10 expense
  ins.run('t3','chk','2026-06-01',100000,'Payroll','Payroll','cat_income_paycheck'); // $1000 income
  ins.run('t4','chk','2026-06-15',-50000,'Move','Move','cat_xfer_out');              // $500 transfer

  db.prepare(`INSERT INTO budgets (id,category_id,amount,created_at,updated_at)
    VALUES ('b1','cat_food',30000,'2026-06-01','2026-06-01')`).run(); // $300 budget on Food
  db.prepare(`INSERT INTO goals (id,name,type,target_amount,current_amount,created_at,updated_at)
    VALUES ('g1','Emergency Fund','savings',300000,150000,'2026-06-01','2026-06-01')`).run();
  db.prepare("INSERT INTO securities (id,ticker,name,type) VALUES ('s1','VTI','Vanguard Total Market','etf')").run();
  db.prepare(`INSERT INTO holdings (id,account_id,security_id,quantity,institution_price,institution_value,cost_basis,manual_cost_basis,updated_at)
    VALUES ('h1','chk','s1',10,200,200000,150000,NULL,'2026-06-01')`).run();
  // Confirmed so the forecast surfaces it: buildRecurringForecast only projects patterns that are
  // confirmed or backed by at least 3 observed transactions.
  db.prepare(`INSERT INTO recurring_patterns (id,merchant_name,category_id,average_amount,frequency,last_seen,next_expected,is_active,is_confirmed,created_at,updated_at)
    VALUES ('r1','Netflix','cat_ent',1599,'monthly','2026-06-01',date('now','+5 days'),1,1,'2026-06-01','2026-06-01')`).run();
  db.prepare(`INSERT INTO net_worth_snapshots (id,date,net_worth,total_assets,total_liabilities,breakdown,created_at)
    VALUES ('n1',date('now'),300000,500000,200000,'{}','2026-07-01')`).run();
  return db;
}

test('ADVISOR_TOOLS are all read-only, well-formed tool definitions', () => {
  assert.ok(ADVISOR_TOOLS.length >= 3);
  for (const t of ADVISOR_TOOLS) {
    assert.equal(typeof t.name, 'string');
    assert.equal(t.input_schema.type, 'object');
  }
});

test('list_transactions returns dollarized rows and honors the expense filter', (t) => {
  const db = setup();
  t.after(() => db.close());
  const r = runAdvisorTool(db, 'list_transactions', { type: 'expense' }) as {
    total: number; transactions: Array<{ amount: number; merchant: string; category: string }>;
  };
  assert.equal(r.total, 3); // t1, t2, t4 (transfers ARE listed here; only aggregates exclude them)
  const cafe = r.transactions.find((x) => x.merchant === 'Cafe');
  assert.equal(cafe?.amount, -25); // dollars, negative for expense
  assert.equal(cafe?.category, 'Restaurants');
});

test('list_transactions filters by merchant substring', (t) => {
  const db = setup();
  t.after(() => db.close());
  const r = runAdvisorTool(db, 'list_transactions', { merchant: 'Diner' }) as { total: number };
  assert.equal(r.total, 1);
});

test('spending_by_category rolls children up to the parent and excludes transfers', (t) => {
  const db = setup();
  t.after(() => db.close());
  const r = runAdvisorTool(db, 'spending_by_category', {}) as {
    total: number;
    categories: Array<{ category: string; spent: number }>;
  };
  assert.equal(r.total, 35); // $25 + $10, transfer excluded
  assert.deepEqual(r.categories.map((c) => [c.category, c.spent]), [['Food & Drink', 35]]);
});

test('monthly_cashflow computes income/expense/net in dollars, excluding transfers', (t) => {
  const db = setup();
  t.after(() => db.close());
  const r = runAdvisorTool(db, 'monthly_cashflow', { months: 36 }) as {
    months: Array<{ month: string; income: number; expenses: number; net: number }>;
  };
  assert.deepEqual(
    r.months.find((m) => m.month === '2026-06'),
    { month: '2026-06', income: 1000, expenses: 35, net: 965 }
  );
});

test('unknown tool returns an error object, not a throw', (t) => {
  const db = setup();
  t.after(() => db.close());
  const r = runAdvisorTool(db, 'delete_everything', {}) as { error: string };
  assert.match(r.error, /Unknown tool/);
});

test('get_budgets returns budget vs this-month actual, dollarized', (t) => {
  const db = setup();
  t.after(() => db.close());
  // A current-month expense (child category rolls up to the budgeted parent).
  db.prepare(`INSERT INTO transactions (id,account_id,date,amount,category_id,created_at,updated_at)
    VALUES ('tb','chk',date('now'),-4000,'cat_food_restaurants','2026-06-01','2026-06-01')`).run();
  const r = runAdvisorTool(db, 'get_budgets', {}) as {
    month: string;
    budgets: Array<{ category: string; budget: number; spent: number; remaining: number }>;
  };
  const food = r.budgets.find((b) => b.category === 'Food & Drink');
  assert.equal(food?.budget, 300);
  assert.equal(food?.spent, 40);      // the current-month $40 expense (child category rolls up)
  assert.equal(food?.remaining, 260);
});

test('list_goals returns progress percentage', (t) => {
  const db = setup();
  t.after(() => db.close());
  const r = runAdvisorTool(db, 'list_goals', {}) as { goals: Array<{ name: string; target: number; current: number; progress_pct: number }> };
  assert.equal(r.goals[0].target, 3000);
  assert.equal(r.goals[0].current, 1500);
  assert.equal(r.goals[0].progress_pct, 50);
});

test('list_holdings returns value, cost basis, and unrealized gain in dollars', (t) => {
  const db = setup();
  t.after(() => db.close());
  const r = runAdvisorTool(db, 'list_holdings', {}) as { holdings: Array<{ ticker: string; value: number; cost_basis: number; unrealized_gain: number; quantity: number; account: string }> };
  assert.equal(r.holdings[0].ticker, 'VTI');
  assert.equal(r.holdings[0].value, 2000);
  assert.equal(r.holdings[0].cost_basis, 1500);
  assert.equal(r.holdings[0].unrealized_gain, 500);
  assert.equal(r.holdings[0].quantity, 10); // share count stays a count, not dollarized
  assert.equal(r.holdings[0].account, 'Checking'); // named so the model can tell wallet from brokerage
});

test('get_upcoming_bills lists bills due within the window', (t) => {
  const db = setup();
  t.after(() => db.close());
  const r = runAdvisorTool(db, 'get_upcoming_bills', {}) as {
    window_days: number;
    scheduled_bills: number;
    bills: Array<{ merchant: string; amount: number; amount_varies: boolean; status: string }>;
  };

  // A monthly bill recurs twice inside the default 45-day window. The old implementation read
  // recurring_patterns.next_expected directly, so it reported one occurrence per pattern and
  // understated every window longer than the pattern's own period.
  assert.equal(r.window_days, 45);
  assert.equal(r.bills.length, 2);
  assert.ok(r.bills.every((b) => b.merchant === 'Netflix'));
  // Signed, matching the forecast convention everywhere else: a bill is money out.
  assert.equal(r.bills[0].amount, -15.99);
  assert.equal(r.bills[0].amount_varies, false);
  assert.equal(r.bills[0].status, 'upcoming');
  assert.equal(r.scheduled_bills, 31.98);
});

test('get_net_worth_history returns dollarized snapshots', (t) => {
  const db = setup();
  t.after(() => db.close());
  const r = runAdvisorTool(db, 'get_net_worth_history', {}) as { history: Array<{ net_worth: number; assets: number; liabilities: number }> };
  assert.equal(r.history[0].net_worth, 3000);
  assert.equal(r.history[0].assets, 5000);
  assert.equal(r.history[0].liabilities, 2000);
});

// ─────────────────────────────────────────────────────────────────────────────
// The typed read tools added for the advisor's structural work.
//
// Each one is a thin wrapper over a service, and each test below proves the wrapper returns the
// SAME figure the service returns rather than a parallel derivation. That is the failure this file
// already exists to prevent: these tools once ran their own SQL and reported $1,695.00 of spending
// where Reports reported $75.00 on the same data.
//
// These use the REAL migrated schema, not a hand-written one, because they touch provenance,
// revisions and snapshots, where a missing constraint changes the answer.
// ─────────────────────────────────────────────────────────────────────────────

import {
  insertAccount,
  insertAdvisorAction,
  insertCategory,
  insertTransaction,
  migratedTestDb,
} from './helpers/schema';
import {
  applyMerchantRulesToExistingTransactions,
  upsertMerchantRule,
  retireMerchantRule,
} from '../server/src/services/rules';
import { listAdvisorActions } from '../server/src/services/advisorDrafts';
import { revertableRevisionsForAction } from '../server/src/services/categoryWrites';
import { getHoldingHistory } from '../server/src/services/investmentMetadata';
import { getSyncRunDetail, listSyncRuns, recordSyncRunItem, startSyncRun } from '../server/src/services/syncHistory';
import { reconcileAccounts } from '../server/src/services/reconciliation';
import { getSpendingReport } from '../server/src/services/reporting';
import { getCategoryProvenance } from '../server/src/services/schemaDoc';
import { getTransactionById } from '../server/src/services/transactions';
import { toDollars } from '../server/src/services/money';
import { confirmAdvisorDraft } from '../server/src/services/advisorDrafts';
import { listAiIncidents } from '../server/src/services/aiGuards';
import { isAutonomousDraftKind } from '../server/src/services/draftAutonomy';
import type { AdvisorDraftAction } from '../shared/types';

// ─── get_merchant_rules ───

test('get_merchant_rules returns the rule that the apply path actually picks', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const streaming = insertCategory(db, { name: 'Streaming' });
  const subscriptions = insertCategory(db, { name: 'Subscriptions' });
  const account = insertAccount(db);
  const txn = insertTransaction(db, {
    account_id: account,
    merchant_name: 'SPOTIFY 877-778-1161, NY',
    category_id: null,
  });

  // Identical timestamps are the point: 236 live rules share 41 of them, so anything that leans on
  // created_at alone lets SQLite's sorter decide who wins.
  const sameInstant = '2026-07-01T00:00:00.000Z';
  upsertMerchantRule(db, 'SPOTIFY 877-778-1161, NY', streaming, sameInstant, { source: 'human' });
  upsertMerchantRule(db, 'Spotify USA', streaming, sameInstant, { source: 'human' });
  upsertMerchantRule(db, 'Spotify', subscriptions, sameInstant, { source: 'ai' });

  const tool = runAdvisorTool(db, 'get_merchant_rules', { merchant: 'SPOTIFY 877-778-1161, NY' }) as {
    winning_rule: { category: string; source: string } | null;
    rules: Array<{ pattern: string; source: string; wins: boolean }>;
  };

  applyMerchantRulesToExistingTransactions(db, { onlyUncategorized: true });
  const applied = db.prepare('SELECT category_id FROM transactions WHERE id = ?').get(txn) as {
    category_id: string | null;
  };

  assert.ok(tool.winning_rule, 'a matching rule must be reported as the winner');
  assert.equal(tool.winning_rule.source, 'human', 'an owner rule outranks the model on the same merchant');
  assert.equal(applied.category_id, streaming);
  assert.equal(
    tool.rules.find((r) => r.wins)?.pattern,
    'SPOTIFY 877-778-1161, NY',
    'the tool must name the rule the apply path used, not a different one'
  );
});

test('get_merchant_rules hides retired rules, because a retired rule applies to nothing', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const category = insertCategory(db);
  const created = upsertMerchantRule(db, 'Backblaze', category, '2026-07-01T00:00:00.000Z', { source: 'ai' });
  assert.ok(created.ruleId);
  retireMerchantRule(db, created.ruleId, { source: 'human' });

  const live = runAdvisorTool(db, 'get_merchant_rules', { merchant: 'Backblaze' }) as {
    winning_rule: unknown;
    rules: unknown[];
  };
  assert.deepEqual(live.rules, []);
  assert.equal(live.winning_rule, null);

  const all = runAdvisorTool(db, 'get_merchant_rules', { include_retired: true, merchant: 'Backblaze' }) as {
    winning_rule: unknown;
    rules: Array<{ retired: boolean; matches_merchant: boolean }>;
  };
  assert.equal(all.rules.length, 1);
  assert.equal(all.rules[0].retired, true);
  assert.equal(all.rules[0].matches_merchant, false, 'a retired rule must never be shown as matching');
  assert.equal(all.winning_rule, null);
});

test('get_merchant_rules on a merchant no rule covers reports no winner, not a wrong one', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const category = insertCategory(db);
  upsertMerchantRule(db, 'Trader Joes', category, '2026-07-01T00:00:00.000Z', { source: 'human' });

  const result = runAdvisorTool(db, 'get_merchant_rules', { merchant: 'Con Edison' }) as {
    winning_rule: unknown;
    total_rules: number;
    rules: unknown[];
  };
  assert.equal(result.winning_rule, null);
  // The rule that exists cannot match, so it is not listed. It is still counted, so "no winner"
  // cannot be confused with "no rules were looked at".
  assert.deepEqual(result.rules, []);
  assert.equal(result.total_rules, 1);
});

test('asking about one merchant returns that merchant\'s rules, not the whole rule book', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const streaming = insertCategory(db, { name: 'Streaming' });
  const noise = insertCategory(db, { name: 'Noise' });
  for (let i = 0; i < 235; i += 1) {
    upsertMerchantRule(db, `Filler Merchant Number ${String(i).padStart(4, '0')}`, noise, '2026-07-01T00:00:00.000Z', {
      source: 'human',
    });
  }
  upsertMerchantRule(db, 'Spotify', streaming, '2026-07-01T00:00:00.000Z', { source: 'human' });

  const focused = runAdvisorTool(db, 'get_merchant_rules', { merchant: 'SPOTIFY 877-778-1161, NY' }) as {
    total_rules: number;
    winning_rule: { pattern: string } | null;
    rules: Array<{ pattern: string; matches_merchant: boolean }>;
  };

  assert.equal(focused.total_rules, 236, 'every rule is still counted');
  assert.equal(focused.winning_rule?.pattern, 'Spotify');
  assert.ok(focused.rules.every((rule) => rule.matches_merchant), 'a listed rule must be one that matches');
  assert.ok(focused.rules.length <= 5, `listed ${focused.rules.length} rules for a one-merchant question`);

  // Measured on the owner's 236 rules, this call was 28,160 bytes before the filter. The whole
  // rule book is still one call away for anyone who wants it.
  const focusedBytes = Buffer.byteLength(JSON.stringify(focused), 'utf8');
  const everything = Buffer.byteLength(
    JSON.stringify(runAdvisorTool(db, 'get_merchant_rules', { limit: 500 })),
    'utf8'
  );
  assert.ok(focusedBytes * 10 < everything, `focused ${focusedBytes} b vs full book ${everything} b`);
});

// ─── get_provenance_summary ───

test('get_provenance_summary returns exactly what the service returns', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const account = insertAccount(db);
  const category = insertCategory(db);
  insertTransaction(db, { account_id: account, category_id: category });
  insertTransaction(db, { account_id: account, category_id: category, category_source: 'human' });
  insertTransaction(db, { account_id: account, category_id: category, category_source: 'ai' });

  assert.deepEqual(runAdvisorTool(db, 'get_provenance_summary', {}), getCategoryProvenance(db));
});

// ─── get_transaction_full ───

interface TransactionFullResult {
  transaction: Record<string, unknown>;
  reading: {
    counts_toward_reports: {
      spending_and_cashflow: boolean;
      side: 'expense' | 'income' | null;
      excluded_because: string[];
      definition: string;
    };
    category_source: string;
  };
}

function transactionFull(db: ReturnType<typeof migratedTestDb>, id: string): TransactionFullResult {
  return runAdvisorTool(db, 'get_transaction_full', { transaction_id: id }) as TransactionFullResult;
}

test('get_transaction_full dollarizes the amount and nothing else', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const account = insertAccount(db);
  const category = insertCategory(db);
  const id = insertTransaction(db, { account_id: account, category_id: category, amount: -123456 });
  db.prepare('UPDATE transactions SET quantity = 0.0031964 WHERE id = ?').run(id);

  const result = transactionFull(db, id);
  const raw = getTransactionById(db, id) as Record<string, unknown>;

  assert.equal(result.transaction.amount, toDollars(raw.amount as number));
  assert.equal(result.transaction.amount, -1234.56);
  assert.equal(result.transaction.quantity, 0.0031964, 'a unit count must never be divided by 100');
  assert.equal(result.transaction.id, id);
  assert.equal(result.reading.counts_toward_reports.spending_and_cashflow, true);
  assert.match(result.reading.category_source, /NULL/);
});

test('get_transaction_full reads the exclusion flags the way the totals do', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const account = insertAccount(db);
  const transfer = insertTransaction(db, { account_id: account });
  const dismissedDuplicate = insertTransaction(db, { account_id: account });
  db.prepare("UPDATE transactions SET transfer_status = 'confirmed' WHERE id = ?").run(transfer);
  // A DISMISSED duplicate is the owner saying the row is real. Excluding it would delete money the
  // owner said was there, so this must read as counting.
  db.prepare("UPDATE transactions SET duplicate_status = 'dismissed' WHERE id = ?").run(dismissedDuplicate);

  assert.equal(transactionFull(db, transfer).reading.counts_toward_reports.spending_and_cashflow, false);
  assert.equal(
    transactionFull(db, dismissedDuplicate).reading.counts_toward_reports.spending_and_cashflow,
    true
  );
});

test('an investment or transfer row does not read as counted just because nobody paired it yet', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  // transfer_status stays 'none' until the pairing pass runs, and it is the ORDINARY state of a
  // freshly synced row. Judging inclusion on that flag alone reported a brokerage contribution and
  // a card payment as spending, on a month whose Reports total was $80.00.
  const account = insertAccount(db);
  const purchase = insertTransaction(db, { account_id: account, date: '2026-07-02', amount: -8000, category_id: 'cat_food' });
  const contribution = insertTransaction(db, { account_id: account, date: '2026-07-03', amount: -50000, category_id: 'cat_inv_transfer' });
  const cardPayment = insertTransaction(db, { account_id: account, date: '2026-07-04', amount: -20000, category_id: 'cat_xfer_out' });
  for (const id of [purchase, contribution, cardPayment]) {
    const row = db.prepare('SELECT transfer_status FROM transactions WHERE id = ?').get(id) as { transfer_status: string };
    assert.equal(row.transfer_status, 'none', 'the fixture must be the unpaired state, or it proves nothing');
  }

  const report = getSpendingReport(db, { startDate: '2026-07-01', endDate: '2026-07-31' });
  assert.equal(report.total, 8000, 'Reports counts the $80 purchase and neither of the other two');

  const counted = transactionFull(db, purchase).reading.counts_toward_reports;
  assert.equal(counted.spending_and_cashflow, true);
  assert.equal(counted.side, 'expense');
  assert.deepEqual(counted.excluded_because, []);

  for (const id of [contribution, cardPayment]) {
    const reading = transactionFull(db, id).reading.counts_toward_reports;
    assert.equal(reading.spending_and_cashflow, false, `${id} must not be reported as counted`);
    assert.ok(reading.excluded_because.length > 0, `${id} must say WHY it does not count`);
  }
});

test('a pending purchase is not reported as counted, and says it is the pending flag', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const account = insertAccount(db);
  const id = insertTransaction(db, { account_id: account, date: '2026-07-02', amount: -3300, category_id: 'cat_food', pending: 1 });

  const reading = transactionFull(db, id).reading.counts_toward_reports;
  assert.equal(reading.spending_and_cashflow, false);
  assert.match(reading.excluded_because.join(' '), /pending = 1/);
});

test('a refund and a paycheck are counted, on the side their category decides', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const account = insertAccount(db);
  const salary = insertCategory(db, { name: 'Salary', is_income: 1 });
  // A refund is a POSITIVE amount inside an EXPENSE category. It counts, on the expense side, and
  // nets that category down. Deciding the side by the sign would drop it out of both totals.
  const refund = insertTransaction(db, { account_id: account, date: '2026-07-03', amount: 2500, category_id: 'cat_food' });
  const paycheck = insertTransaction(db, { account_id: account, date: '2026-07-04', amount: 400000, category_id: salary });

  const refundReading = transactionFull(db, refund).reading.counts_toward_reports;
  assert.equal(refundReading.spending_and_cashflow, true);
  assert.equal(refundReading.side, 'expense');
  assert.deepEqual(refundReading.excluded_because, []);

  const paycheckReading = transactionFull(db, paycheck).reading.counts_toward_reports;
  assert.equal(paycheckReading.spending_and_cashflow, true);
  assert.equal(paycheckReading.side, 'income');
  assert.deepEqual(paycheckReading.excluded_because, []);
});

test('the inclusion field names the reports it answers for, and the ones it does not', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const account = insertAccount(db);
  const id = insertTransaction(db, { account_id: account, category_id: 'cat_food' });
  const definition = transactionFull(db, id).reading.counts_toward_reports.definition;

  assert.match(definition, /getSpendingReport/);
  assert.match(definition, /getCashflowReport/);
  assert.match(definition, /budgets and reconciliation scope rows differently/);
});

test('get_transaction_full on an unknown id says so instead of returning an empty row', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());
  const result = runAdvisorTool(db, 'get_transaction_full', { transaction_id: 'nope' }) as { error: string };
  assert.match(result.error, /No transaction with id nope/);
});

// ─── get_my_action_history ───

test('get_my_action_history matches the service and counts revertable rows honestly', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const account = insertAccount(db);
  const category = insertCategory(db);
  const actionId = insertAdvisorAction(db, { kind: 'categorize_transaction' });
  const txn = insertTransaction(db, { account_id: account, category_id: category, category_source: 'ai' });
  db.prepare(`
    INSERT INTO transaction_category_revisions
      (id, transaction_id, action_id, from_category_id, from_source, to_category_id, to_source, created_at)
    VALUES ('rev_1', ?, ?, NULL, NULL, ?, 'ai', '2026-07-30T00:00:00.000Z')
  `).run(txn, actionId, category);

  const result = runAdvisorTool(db, 'get_my_action_history', {}) as {
    actions: Array<{ id: string; rows_still_revertable: number }>;
  };
  const service = listAdvisorActions(db, 25);

  assert.equal(result.actions.length, service.length);
  assert.equal(result.actions[0].id, service[0].id);
  assert.equal(result.actions[0].rows_still_revertable, revertableRevisionsForAction(db, actionId).length);
  assert.equal(result.actions[0].rows_still_revertable, 1);
});

test('an action that changed no categories reports zero revertable rows, not a failure', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  insertAdvisorAction(db, { kind: 'create_merchant_rule' });
  const result = runAdvisorTool(db, 'get_my_action_history', {}) as {
    actions: Array<{ kind: string; rows_still_revertable: number }>;
  };
  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].rows_still_revertable, 0);
});

test('get_my_action_history on a clean install is empty, and says nothing else', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());
  const result = runAdvisorTool(db, 'get_my_action_history', {}) as { actions: unknown[] };
  assert.deepEqual(result.actions, []);
});

// ─── get_holding_history ───

test('get_holding_history dollarizes values and leaves the per-unit price alone', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const account = insertAccount(db, { type: 'crypto_wallet' });
  db.prepare("INSERT INTO securities (id, ticker, name, type) VALUES ('sec_btc','BTC','Bitcoin','crypto')").run();
  db.prepare(`
    INSERT INTO holdings (id, account_id, security_id, quantity, institution_price, institution_value, cost_basis, updated_at)
    VALUES ('hold_1', ?, 'sec_btc', 0.0031964, 61234.56, 19575, NULL, '2026-07-30T00:00:00.000Z')
  `).run(account);
  db.prepare(`
    INSERT INTO holdings_history (id, account_id, security_id, date, quantity, institution_price, institution_value, cost_basis, created_at)
    VALUES ('hh_1', ?, 'sec_btc', date('now','-2 days'), 0.0031964, 61234.56, 19575, NULL, '2026-07-30T00:00:00.000Z')
  `).run(account);

  const result = runAdvisorTool(db, 'get_holding_history', { holding_id: 'hold_1' }) as {
    points: Array<{ price_per_unit: number; value: number; cost_basis: number | null; quantity: number }>;
  };
  const service = getHoldingHistory(db, 'hold_1', 90);

  assert.equal(result.points.length, service.length);
  assert.equal(result.points[0].value, toDollars(service[0].institution_value));
  assert.equal(result.points[0].value, 195.75);
  assert.equal(result.points[0].price_per_unit, 61234.56, 'a per-unit price is already dollars');
  assert.equal(result.points[0].quantity, 0.0031964);
  assert.equal(result.points[0].cost_basis, null, 'an unknown basis stays unknown, it does not become zero');
});

test('get_holding_history on an unknown holding reports it rather than throwing', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());
  const result = runAdvisorTool(db, 'get_holding_history', { holding_id: 'nope' }) as { error: string };
  assert.match(result.error, /Holding not found/);
});

// ─── get_sync_runs ───

test('get_sync_runs returns the service list, and expands one run into its stages', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const run = startSyncRun(db, 'full', 'test run');
  recordSyncRunItem(db, run.id, { provider: 'simplefin', status: 'succeeded', transactions_added: 3 });

  assert.deepEqual(runAdvisorTool(db, 'get_sync_runs', {}), { runs: listSyncRuns(db, 10) });
  assert.deepEqual(runAdvisorTool(db, 'get_sync_runs', { run_id: run.id }), { run: getSyncRunDetail(db, run.id) });
});

test('get_sync_runs before the first sync returns an empty list, not an error', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());
  assert.deepEqual(runAdvisorTool(db, 'get_sync_runs', {}), { runs: [] });
});

test('get_sync_runs on an unknown run id says so', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());
  const result = runAdvisorTool(db, 'get_sync_runs', { run_id: 'nope' }) as { error: string };
  assert.match(result.error, /Sync run not found/);
});

// ─── get_reconciliation ───

function seedReconciliation(db: ReturnType<typeof migratedTestDb>): { checking: string; brokerage: string } {
  const checking = insertAccount(db, { account_name: 'Checking', type: 'checking', current_balance: 150000 });
  const brokerage = insertAccount(db, { account_name: 'Brokerage', type: 'brokerage', current_balance: 900000 });
  const snapshot = db.prepare(`
    INSERT INTO net_worth_snapshots
      (id, date, total_assets, total_liabilities, net_worth, breakdown, is_estimated, created_at)
    VALUES (?, ?, ?, 0, ?, ?, 0, '2026-07-30T00:00:00.000Z')
  `);
  snapshot.run('nw_1', '2026-06-30', 1100000, 1100000, JSON.stringify({ [checking]: 100000, [brokerage]: 1000000 }));
  snapshot.run('nw_2', '2026-07-30', 1050000, 1050000, JSON.stringify({ [checking]: 150000, [brokerage]: 900000 }));
  return { checking, brokerage };
}

test('get_reconciliation reports the service figures, converted to dollars once', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const { checking } = seedReconciliation(db);
  // The ledger explains the checking movement exactly: +$500 in, and the balance rose $500.
  insertTransaction(db, { account_id: checking, date: '2026-07-15', amount: 50000 });

  const service = reconcileAccounts(db, {});
  const tool = runAdvisorTool(db, 'get_reconciliation', {}) as {
    total_residual: number;
    unreconciled: unknown[];
    accounts: Array<{ account_id: string; residual: number; adjusted_residual: number; boundary_amount: number }>;
  };

  assert.equal(tool.total_residual, toDollars(service.total_residual));
  assert.equal(tool.accounts.length, service.accounts.length);
  for (const account of service.accounts) {
    const reported = tool.accounts.find((a) => a.account_id === account.account_id);
    assert.ok(reported, `missing account ${account.account_id}`);
    assert.equal(reported.residual, toDollars(account.residual));
    assert.equal(reported.adjusted_residual, toDollars(account.adjusted_residual));
    assert.equal(reported.boundary_amount, toDollars(account.boundary_amount));
  }
});

test('every derived reconciliation field the tool emits is defined in the same payload', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const { checking } = seedReconciliation(db);
  insertTransaction(db, { account_id: checking, date: '2026-07-15', amount: 50000 });

  const tool = runAdvisorTool(db, 'get_reconciliation', {}) as {
    accounts: Array<Record<string, unknown>>;
    field_meanings: Record<string, string>;
  };

  // direction_conflict reads true on the owner's data right now with no definition anywhere the
  // model can see it. A true boolean whose meaning has to be guessed is worse than no boolean.
  assert.match(tool.field_meanings.direction_conflict ?? '', /OPPOSITE WAYS/);
  assert.match(tool.field_meanings.direction_conflict ?? '', /NOT a claim that a transaction is missing/);

  // Nothing self-describing enough to skip: every derived field on an account row needs an entry,
  // because none of them is a column describe_schema documents.
  const selfEvident = new Set(['account_id', 'account_name', 'is_liability', 'first_date', 'last_date']);
  for (const field of Object.keys(tool.accounts[0])) {
    if (selfEvident.has(field)) continue;
    assert.ok(tool.field_meanings[field], `${field} is emitted with no definition the model can read`);
  }
});

test('a healthy ledger reconciles silently, and a price move is not called a gap', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const { checking } = seedReconciliation(db);
  insertTransaction(db, { account_id: checking, date: '2026-07-15', amount: 50000 });

  const tool = runAdvisorTool(db, 'get_reconciliation', {}) as {
    unreconciled: Array<{ account_id: string }>;
    accounts: Array<{ account_id: string; is_market_driven: boolean; direction_conflict: boolean }>;
  };

  // The brokerage fell $1,000 with no transaction at all: an ordinary down month. It must not be
  // reported as unexplained, and it must not raise a direction conflict either.
  assert.deepEqual(tool.unreconciled, [], 'nothing is unexplained on a ledger that adds up');
  for (const account of tool.accounts) {
    assert.equal(account.direction_conflict, false, `${account.account_id} raised a conflict on healthy data`);
  }
});

test('a transaction dated on the first snapshot is reported as a boundary artifact, not a gap', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const { checking } = seedReconciliation(db);
  // The window is `date > first AND date <= last`, so a row on the horizon's own first date sits
  // outside `explained` while its balance effect sits inside. That is where the horizon was cut,
  // not a missing transaction, and the tool has to keep the two visible separately.
  insertTransaction(db, { account_id: checking, date: '2026-06-30', amount: 50000 });

  const tool = runAdvisorTool(db, 'get_reconciliation', {}) as {
    unreconciled: Array<{ account_id: string }>;
    accounts: Array<{ account_id: string; residual: number; boundary_amount: number; adjusted_residual: number }>;
  };

  const account = tool.accounts.find((a) => a.account_id === checking);
  assert.ok(account);
  assert.equal(account.residual, 500);
  assert.equal(account.boundary_amount, 500);
  assert.equal(account.adjusted_residual, 0);
  assert.deepEqual(tool.unreconciled, []);
});

// ─── Weight ───
//
// Tool results land uncached inside a loop that runs up to 8 rounds, so the size of an answer is
// part of whether the answer is usable. Measured on a copy of the owner's database with
// Buffer.byteLength(JSON.stringify(result), 'utf8'): describe_schema was 34,398 bytes (~8.6k
// tokens) and get_merchant_rules with a merchant argument was 28,160, so an ordinary two-tool turn
// spent ~15.6k tokens before answering anything.

test('a two-tool turn stays small enough to answer in', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const category = insertCategory(db, { name: 'Streaming' });
  for (let i = 0; i < 235; i += 1) {
    upsertMerchantRule(db, `Filler Merchant Number ${String(i).padStart(4, '0')}`, category, '2026-07-01T00:00:00.000Z', {
      source: 'human',
    });
  }
  upsertMerchantRule(db, 'Spotify', category, '2026-07-01T00:00:00.000Z', { source: 'human' });

  const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');
  const schema = bytes(runAdvisorTool(db, 'describe_schema', {}));
  const rules = bytes(runAdvisorTool(db, 'get_merchant_rules', { merchant: 'SPOTIFY 877-778-1161, NY' }));
  const expansion = bytes(runAdvisorTool(db, 'describe_schema', { tables: ['holdings'] }));

  assert.ok(schema < 28_000, `describe_schema returned ${schema} bytes`);
  assert.ok(rules < 3_000, `get_merchant_rules returned ${rules} bytes for one merchant`);
  assert.ok(expansion < 3_000, `expanding one table returned ${expansion} bytes`);
  assert.ok(schema + rules < 32_000, `a two-tool turn cost ${schema + rules} bytes`);
});

test('get_merchant_rules resolves over every rule, not just the page it returns', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const streaming = insertCategory(db, { name: 'Streaming' });
  const noise = insertCategory(db, { name: 'Noise' });

  // The real ledger has 236 rules against a default page of 100. The matching rule sat off the end
  // and the tool reported that nothing matched a merchant that had a rule. Long patterns sort
  // first, so a short one is pushed past the page boundary.
  for (let i = 0; i < 120; i += 1) {
    upsertMerchantRule(db, `Filler Merchant Number ${String(i).padStart(4, '0')}`, noise, '2026-07-01T00:00:00.000Z', {
      source: 'human',
    });
  }
  upsertMerchantRule(db, 'Hulu', streaming, '2026-07-01T00:00:00.000Z', { source: 'human' });

  const result = runAdvisorTool(db, 'get_merchant_rules', { merchant: 'Hulu', limit: 10 }) as {
    total_rules: number;
    winning_rule: { pattern: string; category: string } | null;
    rules: Array<{ pattern: string; wins: boolean }>;
  };

  assert.equal(result.total_rules, 121);
  assert.ok(result.winning_rule, 'a rule that exists must be found regardless of the page size');
  assert.equal(result.winning_rule.pattern, 'Hulu');
  assert.equal(result.winning_rule.category, 'Streaming');
  assert.ok(
    result.rules.some((rule) => rule.wins && rule.pattern === 'Hulu'),
    'the winner must be carried into the returned list even when it falls outside the limit'
  );
});


// ─── The two write tools ─────────────────────────────────────────────────────
//
// These apply up to 200 categorizations, plus a merchant rule that sweeps the whole ledger, from
// one tool call. They used to do it outside every check the background pass runs under: no
// conservation guard, no ai_runs row, no autonomy check, and an audit row indistinguishable from
// the pass's own. A chat write is not unattended (the owner asked, in a conversation) and it is not
// confirmed either (the owner approved no row), so the trail has to be able to tell them apart
// afterwards and the guard has to measure it the same way.

interface WriteFixture {
  db: Database.Database;
  accountId: string;
}

function writeFixture(): WriteFixture {
  const db = migratedTestDb();
  const accountId = insertAccount(db, { current_balance: 500_000, type: 'checking' });
  return { db, accountId };
}

function chatTxn(fx: WriteFixture, id: string, merchant: string, categoryId: string | null = null): string {
  return insertTransaction(fx.db, {
    id,
    account_id: fx.accountId,
    date: '2026-07-10',
    amount: -1_200,
    merchant_name: merchant,
    original_name: merchant,
    category_id: categoryId,
  });
}

function actionRows(db: Database.Database): Array<{ kind: string; label: string; source: string }> {
  return db.prepare('SELECT kind, label, source FROM advisor_actions ORDER BY created_at')
    .all() as Array<{ kind: string; label: string; source: string }>;
}

test('HEALTHY: an ordinary categorize_transactions call applies every row and reports only that', (t) => {
  const fx = writeFixture();
  t.after(() => fx.db.close());
  chatTxn(fx, 'c1', 'Trupanion');
  chatTxn(fx, 'c2', 'Trupanion');

  const result = runAdvisorTool(fx.db, 'categorize_transactions', {
    transaction_ids: ['c1', 'c2'],
    category_id: 'cat_health',
  }) as { requested: number; applied: number; failed: number; guard?: unknown };

  // Exactly the shape the model saw before the guard was added. A healthy call says nothing about
  // the guard, because there is nothing to say and a model told about a guard reports it.
  assert.deepEqual(Object.keys(result).sort(), ['applied', 'failed', 'outcomes', 'requested']);
  assert.equal(result.requested, 2);
  assert.equal(result.applied, 2);
  assert.equal(result.failed, 0);

  const rows = fx.db.prepare("SELECT category_id, category_source FROM transactions ORDER BY id")
    .all() as Array<{ category_id: string; category_source: string }>;
  assert.deepEqual(rows, [
    { category_id: 'cat_health', category_source: 'ai' },
    { category_id: 'cat_health', category_source: 'ai' },
  ]);
  assert.equal(listAiIncidents(fx.db).length, 0, 'the guard is silent on an ordinary call');
});

test('HEALTHY: an ordinary create_merchant_rule call applies and reports only that', (t) => {
  const fx = writeFixture();
  t.after(() => fx.db.close());
  chatTxn(fx, 'c1', 'Trupanion Pet Insurance');

  const result = runAdvisorTool(fx.db, 'create_merchant_rule', {
    pattern: 'Trupanion',
    category_id: 'cat_health',
  }) as { applied: boolean; changed: number; guard?: unknown };

  assert.equal(result.applied, true);
  assert.equal(result.changed, 2, 'the rule itself, plus the one existing row it swept in');
  assert.equal(result.guard, undefined);
  assert.equal(listAiIncidents(fx.db).length, 0);
  assert.equal(
    (fx.db.prepare('SELECT COUNT(*) AS n FROM merchant_rules').get() as { n: number }).n,
    1
  );
});

test('the audit trail can tell a chat write from a background pass write', (t) => {
  const fx = writeFixture();
  t.after(() => fx.db.close());
  chatTxn(fx, 'c1', 'Trupanion');
  chatTxn(fx, 'c2', 'Sightglass Coffee');

  runAdvisorTool(fx.db, 'categorize_transactions', { transaction_ids: ['c1'], category_id: 'cat_health' });

  // The same write, made by the background pass, through the same function.
  confirmAdvisorDraft(
    fx.db,
    {
      id: 'draft_worker',
      kind: 'categorize_transaction',
      label: 'Categorize Sightglass Coffee',
      summary: 'Coffee.',
      route: '/transactions',
      payload: { kind: 'categorize_transaction', transaction_id: 'c2', category_id: 'cat_food_coffee' },
      changes: [],
      citations: [],
      confirmation_required: true,
    } as AdvisorDraftAction,
    true,
    'worker_auto'
  );

  const rows = actionRows(fx.db);
  assert.equal(rows.length, 2);
  const fromChat = rows.filter((r) => r.label.startsWith(CHAT_TOOL_ACTION_PREFIX));
  assert.equal(fromChat.length, 1, 'exactly one of the two came from a conversation, and the row says so');

  // `source` cannot carry it: the column has a CHECK constraint listing two values, neither of
  // which is true of a chat write, and 'user_confirm' would put a confirmation in the trail that
  // never happened. Both rows therefore still read 'worker_auto', which is what the label is for.
  assert.deepEqual([...new Set(rows.map((r) => r.source))], ['worker_auto']);
});

test('every kind the chat write tools may emit is inside the autonomy declaration', () => {
  // This is the premise that makes the check in applyWriteDraft inert today: it cannot fire on
  // anything shipped, and it is there so a third write tool cannot land a proposal-only kind from a
  // conversation. If this fails, the check has started firing on real traffic and the tool, not the
  // check, is what is wrong.
  for (const kind of CHAT_WRITE_KINDS) {
    assert.equal(isAutonomousDraftKind(kind), true, `${kind} is applied from chat and is not declared autonomous`);
  }
});

test('the chat write path really does run inside the conservation guard', (t) => {
  const fx = writeFixture();
  t.after(() => fx.db.close());
  chatTxn(fx, 'c1', 'Trupanion');

  // An indirect proof, and the only cheap one: a clean guard leaves no trace by design, so there is
  // nothing to assert on a healthy call. `runGuardedCategoryBatch` refuses to run inside an open
  // transaction, because a rolled-back revert would take the incident row with it. If the write
  // path were outside the guard this would quietly succeed. routes/ai.ts calls the tools outside
  // any transaction, so this refusal is unreachable in production.
  assert.throws(
    () => fx.db.transaction(() => {
      runAdvisorTool(fx.db, 'categorize_transactions', { transaction_ids: ['c1'], category_id: 'cat_health' });
    })(),
    /must not be called inside an open transaction/
  );

  const row = fx.db.prepare('SELECT category_id FROM transactions WHERE id = ?').get('c1') as
    { category_id: string | null };
  assert.equal(row.category_id, null, 'nothing was written');
});

test('HEALTHY: a chat categorization that pairs a transfer moves the month and is still silent', (t) => {
  const fx = writeFixture();
  t.after(() => fx.db.close());
  const savings = insertAccount(fx.db, { current_balance: 100_000, type: 'savings' });

  // `confirmCategorizeTransaction` re-runs refreshTransactionIntegrity, so an ordinary chat
  // categorization can pair a transfer as a side effect and legitimately move the month's income:
  // excludedFromTotalsSql drops a transfer candidate from every total. The guard has to stay silent
  // on that, or it fires on the owner asking the advisor to file one unrelated coffee.
  insertTransaction(fx.db, {
    id: 'leg_out', account_id: fx.accountId, date: '2026-07-12', amount: -50_000,
    merchant_name: 'AUTOPAY 1234', original_name: 'AUTOMATIC PAYMENT 1234',
    category_id: 'cat_xfer_cc', category_source: 'heuristic',
  });
  insertTransaction(fx.db, {
    id: 'leg_in', account_id: savings, date: '2026-07-13', amount: 50_000,
    merchant_name: 'Transfer from checking', original_name: 'ONLINE TRANSFER FROM CHK',
  });
  chatTxn(fx, 'c1', 'Trupanion');

  const result = runAdvisorTool(fx.db, 'categorize_transactions', {
    transaction_ids: ['c1'],
    category_id: 'cat_health',
  }) as { applied: number; guard?: unknown };

  assert.equal(result.applied, 1);
  assert.equal(result.guard, undefined);
  assert.equal(listAiIncidents(fx.db).length, 0);
  assert.equal(
    (fx.db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE transfer_status = 'candidate'").get() as { n: number }).n,
    2,
    'the pair really was made, so the silence is about a real movement'
  );
});

test('a chat write that names a row the owner categorized by hand changes nothing and says so', (t) => {
  const fx = writeFixture();
  t.after(() => fx.db.close());
  insertTransaction(fx.db, {
    id: 'c1', account_id: fx.accountId, date: '2026-07-10', amount: -1_200,
    merchant_name: 'Trupanion', original_name: 'Trupanion',
    category_id: 'cat_shop', category_source: 'human', manually_categorized: 1,
  });

  const result = runAdvisorTool(fx.db, 'categorize_transactions', {
    transaction_ids: ['c1'],
    category_id: 'cat_health',
  }) as { requested: number; applied: number; failed: number };

  const row = fx.db.prepare('SELECT category_id, category_source FROM transactions WHERE id = ?').get('c1') as
    { category_id: string; category_source: string };
  assert.equal(row.category_id, 'cat_shop', 'the hand-made choice stands');
  assert.equal(row.category_source, 'human');
  assert.equal(result.requested, 1);
  assert.equal(result.applied + result.failed, 1, 'the call reports one outcome for the one row asked about');
});
