import test from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { computeSafeToSpend } from '../server/src/services/safeToSpend';
import { insertAccount, insertTransaction, localDaysFromToday, migratedTestDb } from './helpers/schema';

function steadyGroceries(): { db: Database.Database; card: string } {
  const db = migratedTestDb();
  const card = insertAccount(db, { type: 'credit', is_liability: 1 });
  for (let back = 1; back <= 90; back++) {
    insertTransaction(db, { account_id: card, date: localDaysFromToday(-back), amount: -2000, category_id: 'cat_food_groceries' });
  }
  return { db, card };
}

const pace = (db: Database.Database) => computeSafeToSpend(db, { forecastDays: 30 });

test('HEALTHY: steady spending is paced in full and nothing is left out', () => {
  const result = pace(steadyGroceries().db);
  assert.equal(result.estimatedUnbudgeted, 60000);
  assert.deepEqual(result.unbudgetedLumps, []);
});

test('one payment that is most of the window is left out of the pace and named, with its refund', () => {
  const { db, card } = steadyGroceries();
  const rent = insertTransaction(db, { account_id: card, date: localDaysFromToday(-40), amount: -200000, merchant_name: 'Zeffy', category_id: 'cat_home_rent' });
  const refund = insertTransaction(db, { account_id: card, date: localDaysFromToday(-20), amount: 35000, merchant_name: 'Zeffy', category_id: 'cat_home_rent' });
  db.prepare('UPDATE transactions SET refund_of_id = ? WHERE id = ?').run(rent, refund);
  const result = pace(db);
  assert.equal(result.estimatedUnbudgeted, 60000);
  assert.deepEqual(result.unbudgetedLumps, [{ date: localDaysFromToday(-40), label: 'Zeffy', cents: 200000 }]);
});

test('a large row that is a small share of the window stays in the pace', () => {
  const { db, card } = steadyGroceries();
  for (let back = 1; back <= 90; back++) {
    insertTransaction(db, { account_id: card, date: localDaysFromToday(-back), amount: -2000, category_id: 'cat_food_coffee' });
  }
  insertTransaction(db, { account_id: card, date: localDaysFromToday(-10), amount: -60000, merchant_name: 'Laptop repair', category_id: 'cat_food_groceries' });
  const result = pace(db);
  assert.deepEqual(result.unbudgetedLumps, []);
  assert.equal(result.estimatedUnbudgeted, 140000);
});
