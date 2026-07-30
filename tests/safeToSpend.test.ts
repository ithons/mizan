import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSafeToSpend } from '../server/src/services/safeToSpend';
import { insertAccount, migratedTestDb } from './helpers/schema';

test('credit card balances are a claim on the liquid pool', () => {
  const db = migratedTestDb();
  insertAccount(db, { type: 'checking', current_balance: 529149 });
  insertAccount(db, { type: 'credit', current_balance: 565371, is_liability: 1 });

  const result = computeSafeToSpend(db);
  assert.equal(result.liquid, 529149);
  assert.equal(result.cardBalances, 565371);
  // The old client-side version never looked at liabilities and rendered "Free to spend $4,226"
  // directly beneath "Owed $5,653.71" on this exact balance sheet.
  assert.equal(result.free, 529149 - 565371);
  db.close();
});

test('a card in credit frees money up instead of claiming it', () => {
  const db = migratedTestDb();
  insertAccount(db, { type: 'checking', current_balance: 500000 });
  insertAccount(db, { type: 'credit', current_balance: -56326, is_liability: 1 });

  const result = computeSafeToSpend(db);
  // Math.abs() booked this $563.26 credit as $563.26 of debt, so the figure was $1,126.52 low.
  assert.equal(result.cardBalances, -56326);
  assert.equal(result.free, 500000 + 56326);
  db.close();
});

test('a shortfall is reported as a shortfall, not as zero', () => {
  const db = migratedTestDb();
  insertAccount(db, { type: 'checking', current_balance: 10000 });
  insertAccount(db, { type: 'credit', current_balance: 50000, is_liability: 1 });

  const result = computeSafeToSpend(db);
  // Math.max(0, ...) used to collapse "you are $400 short" and "you have nothing spare" into the
  // same rendered $0, hiding the one thing this number exists to tell you.
  assert.ok(result.free < 0);
  assert.equal(result.free, -40000);
  db.close();
});

test('investments and crypto are not liquid', () => {
  const db = migratedTestDb();
  insertAccount(db, { type: 'checking', current_balance: 10000 });
  insertAccount(db, { type: 'brokerage', current_balance: 500000 });
  insertAccount(db, { type: 'crypto_wallet', current_balance: 400000 });

  assert.equal(computeSafeToSpend(db).liquid, 10000);
  db.close();
});

test('a budget allocation is capped at what was actually budgeted', () => {
  const db = migratedTestDb();
  insertAccount(db, { type: 'checking', current_balance: 100000 });

  // Refund netting can push projected_remaining above the budget: on the live ledger July's
  // Shopping budget is $500 with -$1,203.63 of spend, giving $1,703.63 "remaining". That is a true
  // statement about headroom and a false one about intent.
  const result = computeSafeToSpend(db, {
    budgets: [{ amount: 50000, rollover_balance: 0, projected_remaining: 170363 }],
  });
  assert.equal(result.allocatedBudgets, 50000);
  assert.equal(result.free, 100000 - 50000);
  db.close();
});

test('an overspent budget allocates nothing rather than a negative', () => {
  const db = migratedTestDb();
  insertAccount(db, { type: 'checking', current_balance: 100000 });

  const result = computeSafeToSpend(db, {
    budgets: [{ amount: 50000, rollover_balance: 0, projected_remaining: -20000 }],
  });
  assert.equal(result.allocatedBudgets, 0);
  db.close();
});

test('hidden and closed accounts are not counted', () => {
  const db = migratedTestDb();
  insertAccount(db, { type: 'checking', current_balance: 10000 });
  insertAccount(db, { type: 'checking', current_balance: 999999, is_hidden: 1 });
  insertAccount(db, { type: 'closed', current_balance: 888888 });

  assert.equal(computeSafeToSpend(db).liquid, 10000);
  db.close();
});
