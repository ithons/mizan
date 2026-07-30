import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getCashflowReport,
  getReportSummary,
  getSpendingReport,
} from '../server/src/services/reporting';
import { getMonthlyBudgetsWithProjection } from '../server/src/services/budgetProjection';
import { insertAccount, insertCategory, insertTransaction, migratedTestDb } from './helpers/schema';

/**
 * The defect these pin: reports classified a row by SIGN and by CATEGORY CLASS at once, so a
 * refund (a positive amount in an expense category) satisfied neither the income arm nor the
 * expense arm and disappeared from both totals. On the real ledger that turned a +$1,389.00 July
 * into a reported -$665.24, and a +64% savings rate into -31%.
 */

function setup() {
  const db = migratedTestDb();
  const shopping = insertCategory(db, { name: 'Test Shopping' });
  const paycheck = insertCategory(db, { name: 'Test Paycheck', is_income: 1 });
  const account = insertAccount(db, { type: 'checking' });
  return { db, shopping, paycheck, account };
}

test('a refund nets its category down instead of vanishing from every total', () => {
  const { db, shopping, paycheck, account } = setup();
  insertTransaction(db, { account_id: account, date: '2026-07-05', amount: -10000, category_id: shopping, merchant_name: 'Amazon' });
  insertTransaction(db, { account_id: account, date: '2026-07-09', amount: 4000, category_id: shopping, merchant_name: 'Amazon' });
  insertTransaction(db, { account_id: account, date: '2026-07-01', amount: 50000, category_id: paycheck, merchant_name: 'Payroll' });

  const range = { startDate: '2026-07-01', endDate: '2026-07-31' };
  const month = getCashflowReport(db, range).months[0];

  assert.equal(month.income, 50000);
  // 100.00 spent minus 40.00 returned. The old form reported the full 100.00 and silently
  // discarded the 40.00 from both arms.
  assert.equal(month.expenses, 6000);
  assert.equal(month.net, 44000);

  const spending = getSpendingReport(db, { ...range, parentOnly: true });
  const shoppingRow = spending.categories.find((c) => c.category_id === shopping);
  assert.equal(shoppingRow?.amount, 6000, 'the category total must agree with the cashflow expense total');
  db.close();
});

test('a category whose credits exceed its purchases reports a negative total, not zero', () => {
  const { db, shopping, account } = setup();
  insertTransaction(db, { account_id: account, date: '2026-07-05', amount: -2000, category_id: shopping });
  insertTransaction(db, { account_id: account, date: '2026-07-09', amount: 12000, category_id: shopping });

  const spending = getSpendingReport(db, {
    startDate: '2026-07-01',
    endDate: '2026-07-31',
    parentOnly: true,
  });
  const row = spending.categories.find((c) => c.category_id === shopping);
  // This happens on the real ledger: July 2026 Shopping is -$1,203.63 because the month's Amazon
  // and REI credits land against few purchases. Flooring it at zero would be a lie, so the UI has
  // to render a credit as a credit.
  assert.equal(row?.amount, -10000);
  db.close();
});

test('a correction against income reduces income rather than being dropped', () => {
  const { db, paycheck, account } = setup();
  insertTransaction(db, { account_id: account, date: '2026-07-01', amount: 50000, category_id: paycheck });
  insertTransaction(db, { account_id: account, date: '2026-07-02', amount: -5000, category_id: paycheck });

  const month = getCashflowReport(db, { startDate: '2026-07-01', endDate: '2026-07-31' }).months[0];
  assert.equal(month.income, 45000, 'the defect was bidirectional');
  assert.equal(month.expenses, 0);
  db.close();
});

test('savings rate reflects the netted figures', () => {
  const { db, shopping, paycheck, account } = setup();
  insertTransaction(db, { account_id: account, date: '2026-07-01', amount: 100000, category_id: paycheck });
  insertTransaction(db, { account_id: account, date: '2026-07-05', amount: -80000, category_id: shopping });
  insertTransaction(db, { account_id: account, date: '2026-07-09', amount: 60000, category_id: shopping });

  const summary = getReportSummary(db, { startDate: '2026-07-01', endDate: '2026-07-31' });
  // 100000 in, 20000 net out => 80% saved. Dropping the refund gave 20%.
  assert.equal(summary.savings_rate.current, 80);
  db.close();
});

test('a returned purchase releases the budget it consumed', () => {
  const { db, shopping, account } = setup();
  db.prepare(`
    INSERT INTO budgets (id, category_id, amount, period, rollover, created_at, updated_at)
    VALUES ('b1', ?, 50000, 'monthly', 0, '2026-07-01', '2026-07-01')
  `).run(shopping);

  insertTransaction(db, { account_id: account, date: '2026-07-05', amount: -40000, category_id: shopping });
  insertTransaction(db, { account_id: account, date: '2026-07-09', amount: 30000, category_id: shopping });

  const budgets = getMonthlyBudgetsWithProjection(db, 2026, 7);
  const row = budgets.find((b: { category_id: string }) => b.category_id === shopping);
  // The old form counted the 400.00 purchase and ignored the 300.00 return, so a refunded
  // purchase ate the budget permanently with no way to give it back.
  assert.equal(row?.spent, 10000);
  db.close();
});
