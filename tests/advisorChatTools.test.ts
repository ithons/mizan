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
