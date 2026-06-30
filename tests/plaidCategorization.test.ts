import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  applyKnownPlaidCategorizationToExistingTransactions,
  categoryIdForPlaidTransaction,
  plaidSourceDetail,
  safePlaidCategoryId,
} from '../server/src/services/plaidCategorization';

function setupDb(): Database.Database {
  const db = new Database(':memory:');

  db.exec(`
    CREATE TABLE categories (
      id TEXT PRIMARY KEY
    );

    CREATE TABLE transactions (
      id TEXT PRIMARY KEY,
      amount REAL NOT NULL,
      merchant_name TEXT,
      original_name TEXT NOT NULL,
      category_id TEXT,
      source_type TEXT NOT NULL,
      source_detail TEXT,
      updated_at TEXT NOT NULL
    );

    INSERT INTO categories (id)
    VALUES
      ('cat_food_restaurants'),
      ('cat_food_groceries'),
      ('cat_food_coffee'),
      ('cat_transport_ride'),
      ('cat_travel_flights'),
      ('cat_xfer_in'),
      ('cat_xfer_out'),
      ('cat_income_paycheck'),
      ('cat_shop_amazon');
  `);

  return db;
}

test('plaid categorization maps personal finance categories', () => {
  assert.equal(
    categoryIdForPlaidTransaction({
      amount: -42,
      merchantName: 'Restaurant',
      originalName: 'Restaurant',
      personalFinanceCategory: {
        primary: 'FOOD_AND_DRINK',
        detailed: 'FOOD_AND_DRINK_RESTAURANT',
      },
    }),
    'cat_food_restaurants'
  );
});

test('plaid categorization falls back to legacy category strings', () => {
  assert.equal(
    categoryIdForPlaidTransaction({
      amount: -300,
      merchantName: 'United',
      originalName: 'UNITED AIRLINES',
      legacyCategories: ['Travel', 'Airlines and Aviation Services'],
    }),
    'cat_travel_flights'
  );

  assert.equal(
    categoryIdForPlaidTransaction({
      amount: 250,
      merchantName: 'External account',
      originalName: 'ONLINE TRANSFER FROM SAVINGS',
      legacyCategories: ['Transfer'],
    }),
    'cat_xfer_in'
  );
});

test('plaid categorization falls back to known merchant names', () => {
  assert.equal(
    categoryIdForPlaidTransaction({
      amount: -13,
      merchantName: 'Starbucks',
      originalName: 'STARBUCKS STORE',
    }),
    'cat_food_coffee'
  );

  assert.equal(
    categoryIdForPlaidTransaction({
      amount: 75,
      merchantName: 'Venmo',
      originalName: 'VENMO CASHOUT',
    }),
    'cat_xfer_in'
  );
});

test('safe plaid categorization returns null when local category is missing', (t) => {
  const db = setupDb();
  t.after(() => db.close());

  assert.equal(
    safePlaidCategoryId(db, {
      amount: -30,
      merchantName: 'CVS',
      originalName: 'CVS PHARMACY',
    }),
    null
  );
});

test('plaid source detail preserves Plaid category provenance', () => {
  const detail = plaidSourceDetail({
    amount: -22,
    merchantName: 'Grocer',
    originalName: 'GROCER',
    personalFinanceCategory: {
      primary: 'FOOD_AND_DRINK',
      detailed: 'FOOD_AND_DRINK_GROCERIES',
      confidence_level: 'HIGH',
    },
    legacyCategories: ['Shops', 'Supermarkets and Groceries'],
  });

  assert.match(detail ?? '', /FOOD_AND_DRINK_GROCERIES/);
  assert.match(detail ?? '', /Supermarkets and Groceries/);
});

test('known plaid categorization backfills existing uncategorized Plaid transactions', (t) => {
  const db = setupDb();
  t.after(() => db.close());

  const sourceDetail = plaidSourceDetail({
    amount: -80,
    merchantName: 'Grocer',
    originalName: 'GROCER',
    personalFinanceCategory: {
      primary: 'FOOD_AND_DRINK',
      detailed: 'FOOD_AND_DRINK_GROCERIES',
    },
  });

  db.prepare(`
    INSERT INTO transactions
      (id, amount, merchant_name, original_name, category_id, source_type, source_detail, updated_at)
    VALUES
      ('pfc', -80, 'Grocer', 'GROCER', NULL, 'plaid', ?, '2026-06-01'),
      ('merchant', -15, 'Uber', 'UBER TRIP', NULL, 'plaid', NULL, '2026-06-01'),
      ('manual', -20, 'Starbucks', 'STARBUCKS', NULL, 'manual', NULL, '2026-06-01'),
      ('user_set', -20, 'Starbucks', 'STARBUCKS', 'cat_income_paycheck', 'plaid', NULL, '2026-06-01')
  `).run(sourceDetail);

  const result = applyKnownPlaidCategorizationToExistingTransactions(db, '2026-06-30');

  assert.equal(result.updated, 2);
  const rows = db.prepare(`
    SELECT id, category_id
    FROM transactions
    ORDER BY id
  `).all() as Array<{ id: string; category_id: string | null }>;

  assert.deepEqual(rows, [
    { id: 'manual', category_id: null },
    { id: 'merchant', category_id: 'cat_transport_ride' },
    { id: 'pfc', category_id: 'cat_food_groceries' },
    { id: 'user_set', category_id: 'cat_income_paycheck' },
  ]);
});
