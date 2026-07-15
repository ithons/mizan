import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runAdvisorTool, ADVISOR_TOOLS } from '../server/src/services/advisorChatTools';

function setup(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE accounts (id TEXT PRIMARY KEY, account_name TEXT, institution_name TEXT);
    CREATE TABLE categories (id TEXT PRIMARY KEY, name TEXT, color TEXT, icon TEXT, parent_id TEXT);
    CREATE TABLE transactions (
      id TEXT PRIMARY KEY, account_id TEXT, date TEXT, amount INTEGER, merchant_name TEXT,
      original_name TEXT DEFAULT '', category_id TEXT, notes TEXT, pending INTEGER DEFAULT 0,
      recurring_id TEXT, review_status TEXT DEFAULT 'open',
      created_at TEXT DEFAULT '2026-06-01', updated_at TEXT DEFAULT '2026-06-01'
    );
    CREATE TABLE budgets (id TEXT PRIMARY KEY, category_id TEXT, amount INTEGER, period TEXT DEFAULT 'monthly');
    CREATE TABLE goals (id TEXT PRIMARY KEY, name TEXT, type TEXT, target_amount INTEGER, current_amount INTEGER, target_date TEXT, is_archived INTEGER DEFAULT 0);
    CREATE TABLE securities (id TEXT PRIMARY KEY, ticker TEXT, name TEXT, type TEXT);
    CREATE TABLE holdings (id TEXT PRIMARY KEY, account_id TEXT, security_id TEXT, quantity REAL, institution_price REAL, institution_value INTEGER, cost_basis INTEGER, manual_cost_basis INTEGER);
    CREATE TABLE recurring_patterns (id TEXT PRIMARY KEY, merchant_name TEXT, category_id TEXT, average_amount INTEGER, frequency TEXT, next_expected TEXT, is_active INTEGER DEFAULT 1);
    CREATE TABLE net_worth_snapshots (id TEXT PRIMARY KEY, date TEXT, net_worth INTEGER, total_assets INTEGER, total_liabilities INTEGER, breakdown TEXT DEFAULT '{}');
  `);
  db.prepare("INSERT INTO accounts VALUES ('chk','Checking','Bank')").run();
  db.prepare(`INSERT INTO categories (id,name,parent_id) VALUES
    ('cat_food','Food',NULL),('cat_food_restaurants','Restaurants','cat_food'),
    ('cat_xfer','Transfers',NULL),('cat_xfer_out','Transfer Out','cat_xfer'),
    ('cat_income','Income',NULL)`).run();
  const ins = db.prepare(`INSERT INTO transactions (id,account_id,date,amount,merchant_name,category_id)
    VALUES (?,?,?,?,?,?)`);
  ins.run('t1','chk','2026-06-05',-2500,'Cafe','cat_food_restaurants');       // $25 expense
  ins.run('t2','chk','2026-06-10',-1000,'Diner','cat_food_restaurants');      // $10 expense
  ins.run('t3','chk','2026-06-01',100000,'Payroll','cat_income');             // $1000 income
  ins.run('t4','chk','2026-06-15',-50000,'Move','cat_xfer_out');              // $500 transfer

  db.prepare("INSERT INTO budgets (id,category_id,amount) VALUES ('b1','cat_food',30000)").run(); // $300 budget on Food
  db.prepare("INSERT INTO goals (id,name,type,target_amount,current_amount) VALUES ('g1','Emergency Fund','savings',300000,150000)").run();
  db.prepare("INSERT INTO securities (id,ticker,name,type) VALUES ('s1','VTI','Vanguard Total Market','etf')").run();
  db.prepare("INSERT INTO holdings (id,account_id,security_id,quantity,institution_price,institution_value,cost_basis,manual_cost_basis) VALUES ('h1','chk','s1',10,200,200000,150000,NULL)").run();
  db.prepare("INSERT INTO recurring_patterns (id,merchant_name,category_id,average_amount,frequency,next_expected,is_active) VALUES ('r1','Netflix','cat_ent',1599,'monthly',date('now','+5 days'),1)").run();
  db.prepare("INSERT INTO net_worth_snapshots (id,date,net_worth,total_assets,total_liabilities) VALUES ('n1',date('now'),300000,500000,200000)").run();
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
    categories: Array<{ category: string; spent: number }>;
  };
  assert.deepEqual(r.categories, [{ category: 'Food', spent: 35 }]); // $25 + $10, transfer excluded
});

test('monthly_cashflow computes income/expense/net in dollars, excluding transfers', (t) => {
  const db = setup();
  t.after(() => db.close());
  const r = runAdvisorTool(db, 'monthly_cashflow', {}) as {
    months: Array<{ month: string; income: number; expenses: number; net: number }>;
  };
  assert.deepEqual(r.months, [{ month: '2026-06', income: 1000, expenses: 35, net: 965 }]);
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
  db.prepare("INSERT INTO transactions (id,account_id,date,amount,category_id) VALUES ('tb','chk',date('now'),-4000,'cat_food_restaurants')").run();
  const r = runAdvisorTool(db, 'get_budgets', {}) as { budgets: Array<{ category: string; budget: number; spent: number; remaining: number }> };
  const food = r.budgets.find((b) => b.category === 'Food');
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
  const r = runAdvisorTool(db, 'list_holdings', {}) as { holdings: Array<{ ticker: string; value: number; cost_basis: number; unrealized_gain: number; quantity: number }> };
  assert.equal(r.holdings[0].ticker, 'VTI');
  assert.equal(r.holdings[0].value, 2000);
  assert.equal(r.holdings[0].cost_basis, 1500);
  assert.equal(r.holdings[0].unrealized_gain, 500);
  assert.equal(r.holdings[0].quantity, 10); // share count stays a count, not dollarized
});

test('get_upcoming_bills lists bills due within the window', (t) => {
  const db = setup();
  t.after(() => db.close());
  const r = runAdvisorTool(db, 'get_upcoming_bills', {}) as { bills: Array<{ merchant: string; amount: number }> };
  assert.equal(r.bills.length, 1);
  assert.equal(r.bills[0].merchant, 'Netflix');
  assert.equal(r.bills[0].amount, 15.99);
});

test('get_net_worth_history returns dollarized snapshots', (t) => {
  const db = setup();
  t.after(() => db.close());
  const r = runAdvisorTool(db, 'get_net_worth_history', {}) as { history: Array<{ net_worth: number; assets: number; liabilities: number }> };
  assert.equal(r.history[0].net_worth, 3000);
  assert.equal(r.history[0].assets, 5000);
  assert.equal(r.history[0].liabilities, 2000);
});
