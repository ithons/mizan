import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { format } from 'date-fns';
import { migratedTestDb, insertAccount } from './helpers/schema';
import { runAdvisorTool } from '../server/src/services/advisorChatTools';
import { getCashflowReport, getSpendingReport } from '../server/src/services/reporting';
import { formatMoney } from '../server/src/services/aiContext';

// The advisor's aggregate tools used to run their own SQL, and drifted from the Reports page:
// they counted transfer candidates, confirmed duplicates, and pending rows that Reports
// excludes, and skipped the investment/crypto root exclusion entirely. Asking the advisor and
// reading the Reports page produced different numbers for the same window. These tests pin the
// two together, so the next person who adds an aggregate has to add it to the shared service.

const RANGE = { start_date: '2026-06-01', end_date: '2026-06-30' };

function setupDb(): Database.Database {
  const db = migratedTestDb();
  insertAccount(db, { id: 'acct', account_name: 'Checking' });

  // Amounts are integer cents. Only the two rows marked "counts" are real June spending.
  const txn = db.prepare(`
    INSERT INTO transactions
      (id, account_id, date, amount, merchant_name, original_name, category_id, pending, transfer_status, duplicate_status,
       created_at, updated_at)
    VALUES (?, 'acct', ?, ?, ?, ?, ?, ?, ?, ?, '2026-06-30T00:00:00.000Z', '2026-06-30T00:00:00.000Z')
  `);
  txn.run('t1', '2026-06-04', -5000, 'Cafe', 'CAFE', 'cat_food_restaurants', 0, 'none', 'none');       // counts
  txn.run('t2', '2026-06-05', -2500, 'Target', 'TARGET', 'cat_shop_household', 0, 'none', 'none');     // counts
  txn.run('t3', '2026-06-06', -20000, 'Move', 'MOVE', 'cat_xfer_out', 0, 'confirmed', 'none');         // transfer
  txn.run('t4', '2026-06-07', -1500, 'Cafe', 'CAFE', 'cat_food_restaurants', 0, 'candidate', 'none');  // transfer candidate
  txn.run('t5', '2026-06-08', -3000, 'Cafe', 'CAFE', 'cat_food_restaurants', 0, 'none', 'confirmed');  // resolved duplicate
  txn.run('t6', '2026-06-09', -7500, 'Cafe', 'CAFE', 'cat_food_restaurants', 1, 'none', 'none');       // pending
  txn.run('t7', '2026-06-10', -100000, 'Coinbase', 'COINBASE', 'cat_crypto_buy', 0, 'none', 'none');   // crypto
  txn.run('t8', '2026-06-11', -50000, 'Fidelity', 'FIDELITY', 'cat_inv_buy', 0, 'none', 'none');       // investment
  txn.run('t9', '2026-06-15', 400000, 'Payroll', 'PAYROLL', 'cat_income_paycheck', 0, 'none', 'none'); // income

  return db;
}

test('spending_by_category agrees with the Reports spending report to the cent', () => {
  const db = setupDb();
  const tool = runAdvisorTool(db, 'spending_by_category', RANGE) as {
    total: number;
    categories: Array<{ category: string; spent: number }>;
  };
  const report = getSpendingReport(db, {
    startDate: RANGE.start_date,
    endDate: RANGE.end_date,
    parentOnly: true,
  });

  assert.equal(tool.total, report.total / 100);
  assert.deepEqual(
    tool.categories.map((c) => [c.category, c.spent]),
    report.categories.map((c) => [c.category_name, c.amount / 100])
  );
});

test('spending_by_category excludes transfers, duplicates, pending, crypto, and investments', () => {
  const db = setupDb();
  const tool = runAdvisorTool(db, 'spending_by_category', RANGE) as {
    total: number;
    categories: Array<{ category: string; spent: number }>;
  };

  // Only t1 ($50.00) and t2 ($25.00) are real spending; $1,820.00 of the fixture must not count.
  // Measured against the pre-delegation SQL on this exact fixture, the tool reported $1,695.00
  // where Reports reported $75.00: it caught the transfer by category but leaked the remaining
  // $1,620.00, and invented "Crypto" and "Investments" as spending categories.
  assert.equal(tool.total, 75);
  assert.deepEqual(tool.categories.map((c) => c.category).sort(), ['Food & Drink', 'Shopping']);
  assert.equal(tool.categories.find((c) => c.category === 'Food & Drink')?.spent, 50);
});

test('monthly_cashflow agrees with the Cash flow report', () => {
  const db = setupDb();
  const tool = runAdvisorTool(db, 'monthly_cashflow', { months: 36 }) as {
    months: Array<{ month: string; income: number; expenses: number; net: number }>;
  };
  const june = tool.months.find((m) => m.month === '2026-06');
  assert.ok(june, 'June must be present in a 36-month window');

  const report = getCashflowReport(db, { startDate: RANGE.start_date, endDate: RANGE.end_date });
  const reportJune = report.months.find((m) => m.month === '2026-06');
  assert.ok(reportJune);

  assert.equal(june.income, reportJune.income / 100);
  assert.equal(june.expenses, reportJune.expenses / 100);
  assert.equal(june.income, 4000);
  assert.equal(june.expenses, 75);
});

test('monthly_cashflow returns newest month first', () => {
  const db = setupDb();
  const tool = runAdvisorTool(db, 'monthly_cashflow', { months: 36 }) as {
    months: Array<{ month: string }>;
  };
  const months = tool.months.map((m) => m.month);
  assert.deepEqual(months, [...months].sort().reverse());
});

test('get_budgets resolves the current month in local time, not UTC', () => {
  const db = setupDb();
  db.prepare(`INSERT INTO budgets (id, category_id, amount, created_at, updated_at)\n    VALUES (?, ?, ?, '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z')`).run('b1', 'cat_food', 40000);

  const tool = runAdvisorTool(db, 'get_budgets', {}) as { month: string };

  // strftime('%Y-%m','now') is UTC. In a negative-offset zone that is the wrong month for the
  // last hours of every month, which is exactly when a "how am I doing this month" question
  // gets asked.
  assert.equal(tool.month, format(new Date(), 'yyyy-MM'));
});

test('formatMoney gives the model the exact figure, not an abbreviation', () => {
  assert.equal(formatMoney(2749.39), '$2,749.39');
  assert.equal(formatMoney(-4350.62), '-$4,350.62');
  assert.equal(formatMoney(1234567.89), '$1,234,567.89');
  assert.equal(formatMoney(0), '$0.00');
  assert.equal(formatMoney(null), 'N/A');
});

/**
 * A share of a signed total is not a share of anything.
 *
 * `SpendingReport.percentage` divides a category by the SIGNED total, and a category whose refunds
 * exceeded its purchases subtracts from that denominator. Measured 2026-07-31 against a copy of
 * `.mizan/mizan.db` at migration 054, for 2026-07-01 onward: the total is 111299 cents while
 * Shopping alone is -102863, so the eight positive categories published 192.3% between them and the
 * model was handed a set of shares that could not add to 100.
 */

function refundedDb(): Database.Database {
  const db = setupDb();
  const txn = db.prepare(`
    INSERT INTO transactions
      (id, account_id, date, amount, merchant_name, original_name, category_id, pending,
       transfer_status, duplicate_status, created_at, updated_at)
    VALUES (?, 'acct', ?, ?, ?, ?, ?, 0, 'none', 'none',
            '2026-06-30T00:00:00.000Z', '2026-06-30T00:00:00.000Z')
  `);
  // The live July shape: one category net negative under a total that is still comfortably
  // positive, which is the case where a share LOOKS computable and is not.
  txn.run('t10', '2026-06-20', 20000, 'Target', 'REFUND', 'cat_shop_household');
  txn.run('t11', '2026-06-21', -30000, 'Cafe', 'CAFE', 'cat_food_restaurants');
  return db;
}

test('HEALTHY: an all-positive month publishes shares, and they add up', () => {
  const db = setupDb();
  const tool = runAdvisorTool(db, 'spending_by_category', RANGE) as {
    total: number;
    share_note: string | null;
    negative_categories: unknown[];
    categories: Array<{ category: string; spent: number; percent_of_total: number | null }>;
  };

  assert.equal(tool.share_note, null, 'nothing to qualify on an ordinary month');
  assert.deepEqual(tool.negative_categories, []);
  const shares = tool.categories.map((c) => c.percent_of_total ?? 0);
  assert.ok(shares.every((share) => share !== null));
  assert.equal(Math.round(shares.reduce((sum, share) => sum + share, 0)), 100);
  db.close();
});

test('a month with a net-refund category publishes no shares, and says which category', () => {
  const db = refundedDb();
  const tool = runAdvisorTool(db, 'spending_by_category', RANGE) as {
    total: number;
    total_is_signed_sum: boolean;
    share_note: string | null;
    negative_categories: Array<{ category: string; net: number }>;
    categories: Array<{ category: string; spent: number; percent_of_total: number | null }>;
  };

  // Food $350.00, Shopping $25.00 of purchases against a $200.00 return: total stays positive.
  assert.equal(tool.total, 175);
  assert.equal(tool.total_is_signed_sum, true);
  assert.deepEqual(tool.negative_categories, [{ category: 'Shopping', net: -175 }]);
  for (const category of tool.categories) {
    assert.equal(category.percent_of_total, null, `${category.category} must not carry a share`);
  }
  assert.match(tool.share_note ?? '', /Shopping/);
  assert.match(tool.share_note ?? '', /refunds and credits exceeded purchases/);
  db.close();
});

test('the negative category is still returned, at its signed figure', () => {
  const db = refundedDb();
  const tool = runAdvisorTool(db, 'spending_by_category', RANGE) as {
    categories: Array<{ category: string; spent: number }>;
  };
  assert.equal(tool.categories.find((c) => c.category === 'Shopping')?.spent, -175);
  db.close();
});

/**
 * `list_goals` and the system prompt must not disagree about one goal inside one conversation.
 *
 * `aiContext.ts` builds the prompt through `calculateGoalProgress`, which overrides a linked
 * goal's stored `current_amount` with the account's balance. `list_goals` ran its own SQL with no
 * join and divided by hand, so on the live ledger the prompt said "$0.00 saved, $5,000.00 to go"
 * while the tool answered $1,001.70 at 20%.
 */
function goal(
  db: Database.Database,
  id: string,
  type: 'savings' | 'debt',
  fields: { current: number; target: number; starting?: number; accountId?: string | null }
): void {
  db.prepare(`
    INSERT INTO goals (id, name, type, target_amount, current_amount, starting_amount, account_id,
                       is_archived, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, '2026-01-01', '2026-01-01')
  `).run(id, id, type, fields.target, fields.current, fields.starting ?? null, fields.accountId ?? null);
}

test('list_goals reports what calculateGoalProgress reports, for both goal directions', () => {
  const db = migratedTestDb();
  const savingsAccount = insertAccount(db, { id: 'acc_sav', type: 'savings', current_balance: 0 });
  const cardAccount = insertAccount(db, { id: 'acc_card', type: 'credit', current_balance: 40000, is_liability: 1 });

  // The live shape: a linked savings goal whose account holds nothing while the column says $1,001.70.
  goal(db, 'emergency', 'savings', { current: 100170, target: 500000, accountId: savingsAccount });
  // The other direction, so a debt goal cannot silently invert.
  goal(db, 'card_payoff', 'debt', { current: 0, target: 100000, starting: 100000, accountId: cardAccount });
  // And one with no link at all, where the column is the only answer there is.
  goal(db, 'laptop', 'savings', { current: 30000, target: 120000, accountId: null });

  const result = runAdvisorTool(db, 'list_goals', {}) as {
    goals: Array<{ name: string; current: number; remaining: number; progress_pct: number }>;
  };
  const byName = new Map(result.goals.map((g) => [g.name, g]));

  // The linked savings goal holds what its account holds: nothing.
  assert.equal(byName.get('emergency')?.current, 0);
  assert.equal(byName.get('emergency')?.remaining, 5000);
  assert.equal(byName.get('emergency')?.progress_pct, 0);

  // The debt goal has paid down $600 of a $1,000 balance.
  assert.equal(byName.get('card_payoff')?.current, 600);
  assert.equal(byName.get('card_payoff')?.progress_pct, 60);

  // The unlinked goal still reports its stored amount.
  assert.equal(byName.get('laptop')?.current, 300);
  assert.equal(byName.get('laptop')?.progress_pct, 25);

  db.close();
});
