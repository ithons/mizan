import test from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { refreshRefundLinks, refundMerchantKey, setRefundLink } from '../server/src/services/refundLinks';
import { getReportSummary, getSpendingReport, getTopMerchantsReport } from '../server/src/services/reporting';
import { getMonthlyBudgetsWithProjection } from '../server/src/services/budgetProjection';
import { updateTransaction } from '../server/src/services/transactions';
import { insertAccount, insertTransaction, migratedTestDb } from './helpers/schema';

interface Link { refund_of_id: string | null; refund_link_source: string | null; category_id: string | null }

function link(db: Database.Database, id: string): Link {
  return db.prepare('SELECT refund_of_id, refund_link_source, category_id FROM transactions WHERE id = ?').get(id) as Link;
}

/** The real case: a $2,495.81 Apple Store purchase on 2026-09-28, returned in full on 2026-10-01. */
function appleReturn(db: Database.Database) {
  const sapphire = insertAccount(db, { account_name: 'Chase Sapphire', type: 'credit', is_liability: 1 });
  const checking = insertAccount(db, { account_name: 'Chase Checking', type: 'checking' });
  const purchase = insertTransaction(db, { account_id: sapphire, date: '2026-09-28', amount: -249581, merchant_name: 'Apple Store', original_name: 'APPLE STORE  #R149', category_id: 'cat_shop_electronics', category_source: 'ai' });
  const refund = insertTransaction(db, { account_id: sapphire, date: '2026-10-01', amount: 249581, merchant_name: 'Apple Store', original_name: 'APPLE STORE  #R149' });
  insertTransaction(db, { account_id: sapphire, date: '2026-10-04', amount: -29377, merchant_name: 'REI', original_name: 'REI #80 BOSTON', category_id: 'cat_shop_outdoors' });
  insertTransaction(db, { account_id: checking, date: '2026-10-07', amount: 22878, merchant_name: 'Mass Inst Payroll', original_name: 'MASS INST PAYROLL PPD ID: 9111111101', category_id: 'cat_income_paycheck' });
  insertTransaction(db, { account_id: checking, date: '2026-10-02', amount: -4200, merchant_name: 'Cava', original_name: 'CAVA', category_id: 'cat_food_restaurants' });
  return { purchase, refund, sapphire };
}

function shoppingIn(db: Database.Database, startDate: string, endDate: string, basis?: 'cash'): number {
  const report = getSpendingReport(db, { startDate, endDate, parentOnly: true, basis });
  return report.categories.find((c) => c.category_id === 'cat_shop')?.amount ?? 0;
}

test('the Apple Store return links to its purchase and takes its category', () => {
  const db = migratedTestDb();
  const { purchase, refund } = appleReturn(db);
  assert.deepEqual(refreshRefundLinks(db), { linked: 1, newlyLinked: 1 });
  assert.deepEqual(link(db, refund), { refund_of_id: purchase, refund_link_source: 'auto', category_id: 'cat_shop_electronics' });
});

test('a linked return nets in the purchase month, and only the cash view shows it in the refund month', () => {
  const db = migratedTestDb();
  appleReturn(db);
  refreshRefundLinks(db);

  assert.equal(shoppingIn(db, '2026-09-01', '2026-09-30'), 0, 'bought and returned: September spent nothing');
  assert.equal(shoppingIn(db, '2026-10-01', '2026-10-31'), 29377, 'October reads what October spent');
  assert.equal(shoppingIn(db, '2026-10-01', '2026-10-31', 'cash'), 29377 - 249581, 'the raw view keeps the money where it moved');

  const october = getReportSummary(db, { startDate: '2026-10-01', endDate: '2026-10-31' });
  assert.equal(october.expenses.current, 29377 + 4200);
  assert.ok((october.savings_rate.current ?? 0) < 100, 'a return is not savings');
});

test('budgets net the return against the month it was bought in', () => {
  const db = migratedTestDb();
  appleReturn(db);
  db.prepare(`INSERT INTO budgets (id, category_id, amount, created_at, updated_at)
    VALUES ('b_shop', 'cat_shop', 50000, '2026-06-01', '2026-06-01')`).run();
  refreshRefundLinks(db);

  const spent = (year: number, month: number) =>
    getMonthlyBudgetsWithProjection(db, year, month, new Date(year, month - 1, 28))
      .find((b) => b.category_id === 'cat_shop')?.spent;
  assert.equal(spent(2026, 9), 0);
  assert.equal(spent(2026, 10), 29377);
});

test('a merchant\'s total nets its refunds instead of adding them', () => {
  const db = migratedTestDb();
  appleReturn(db);
  refreshRefundLinks(db);
  const report = getTopMerchantsReport(db, { startDate: '2026-09-01', endDate: '2026-10-31' });
  const apple = report.merchants.find((m) => m.merchant === 'Apple Store');
  assert.equal(apple?.total ?? 0, 0);
  assert.equal(report.total, report.merchants.reduce((sum, m) => sum + m.total, 0));
});

test('a partial return links, and returns never add up to more than was paid', () => {
  const db = migratedTestDb();
  const card = insertAccount(db, { type: 'credit', is_liability: 1 });
  const purchase = insertTransaction(db, { account_id: card, date: '2026-07-23', amount: -33963, merchant_name: 'REI', category_id: 'cat_shop_outdoors' });
  const first = insertTransaction(db, { account_id: card, date: '2026-07-26', amount: 28129, merchant_name: 'REI' });
  const second = insertTransaction(db, { account_id: card, date: '2026-08-07', amount: 15500, merchant_name: 'REI' });
  refreshRefundLinks(db);
  assert.equal(link(db, first).refund_of_id, purchase);
  assert.equal(link(db, second).refund_of_id, null, '$281.29 + $155.00 would exceed the $339.63 paid');
});

test('credits that are not returns stay where they are', () => {
  const db = migratedTestDb();
  const card = insertAccount(db, { type: 'credit', is_liability: 1 });
  const checking = insertAccount(db, { type: 'checking' });
  insertTransaction(db, { account_id: card, date: '2026-05-01', amount: -2500, merchant_name: 'Cava' });
  const late = insertTransaction(db, { account_id: card, date: '2026-08-15', amount: 2500, merchant_name: 'Cava' });
  insertTransaction(db, { account_id: card, date: '2026-07-20', amount: -2500, merchant_name: 'Chipotle' });
  const otherMerchant = insertTransaction(db, { account_id: card, date: '2026-07-21', amount: 2500, merchant_name: 'Sweetgreen' });
  insertTransaction(db, { account_id: card, date: '2026-07-01', amount: -28381, merchant_name: 'Statement Credit' });
  const reward = insertTransaction(db, { account_id: card, date: '2026-07-27', amount: 28381, merchant_name: 'Statement Credit', category_id: 'cat_income_other' });
  insertTransaction(db, { account_id: checking, date: '2026-07-10', amount: -1500, merchant_name: 'Venmo' });
  const before = insertTransaction(db, { account_id: checking, date: '2026-07-09', amount: 1500, merchant_name: 'Venmo' });

  assert.deepEqual(refreshRefundLinks(db), { linked: 0, newlyLinked: 0 });
  for (const id of [late, otherMerchant, reward, before]) assert.equal(link(db, id).refund_of_id, null);
});

test('the owner can link by hand or refuse a link, and both stand', () => {
  const db = migratedTestDb();
  const { purchase, refund } = appleReturn(db);
  refreshRefundLinks(db);

  assert.deepEqual(setRefundLink(db, refund, null), { ok: true });
  refreshRefundLinks(db);
  assert.deepEqual(link(db, refund), { refund_of_id: null, refund_link_source: 'rejected', category_id: null });

  assert.deepEqual(setRefundLink(db, refund, purchase), { ok: true });
  refreshRefundLinks(db);
  assert.equal(link(db, refund).refund_link_source, 'owner');
  assert.deepEqual(setRefundLink(db, purchase, refund), { ok: false, reason: 'not_a_refund' });
});

test('a refund the owner categorized keeps the owner\'s category', () => {
  const db = migratedTestDb();
  const { refund } = appleReturn(db);
  assert.equal(updateTransaction(db, refund, { category_id: 'cat_gifts' }).ok, true);
  refreshRefundLinks(db);
  assert.equal(link(db, refund).category_id, 'cat_gifts');
});

test('an automatic link lets go when its purchase stops being one, and gives the category back', () => {
  const db = migratedTestDb();
  const { purchase, refund } = appleReturn(db);
  refreshRefundLinks(db);
  db.prepare("UPDATE transactions SET duplicate_status = 'confirmed' WHERE id = ?").run(purchase);
  refreshRefundLinks(db);
  assert.deepEqual(link(db, refund), { refund_of_id: null, refund_link_source: null, category_id: null });
});

test('the merchant key ignores store numbers and punctuation', () => {
  assert.equal(refundMerchantKey({ merchant_name: null, original_name: 'APPLE STORE  #R149' }), 'apple store');
  assert.equal(refundMerchantKey({ merchant_name: 'REI #80 BOSTON', original_name: '' }), 'rei boston');
});

test('a credit is never linked to a negative row filed as income, so linking settles', () => {
  const db = migratedTestDb();
  const checking = insertAccount(db, { type: 'checking' });
  insertTransaction(db, { account_id: checking, date: '2026-09-02', amount: -5000, merchant_name: 'Mass Inst Payroll', category_id: 'cat_income_paycheck' });
  const credit = insertTransaction(db, { account_id: checking, date: '2026-09-09', amount: 5000, merchant_name: 'Mass Inst Payroll' });
  refreshRefundLinks(db);
  assert.equal(link(db, credit).refund_of_id, null);
  assert.deepEqual(refreshRefundLinks(db), { linked: 0, newlyLinked: 0 });
});
