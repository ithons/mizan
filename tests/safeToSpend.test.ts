import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSafeToSpend } from '../server/src/services/safeToSpend';
import { insertAccount, migratedTestDb } from './helpers/schema';
import { calculateGoalProgress } from '../server/src/services/goalProgress';

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

/**
 * A goal's earmark is its linked account's balance, the same answer every other consumer gives.
 *
 * `goals.current_amount` is not the saved amount for a linked goal. `calculateGoalProgress` is the
 * shared definition and `routes/goals.ts`, `routes/insights.ts`, `aiContext.ts` and
 * `advisorTools.ts` all use it; this function read the column raw. On the owner's real ledger on
 * 2026-09-01 that put $1,001.70 of phantom earmark into the subject numeral of the home screen for
 * a goal the same app reported as $0.00 saved.
 */
function goalLinkedTo(
  db: ReturnType<typeof migratedTestDb>,
  accountId: string | null,
  { current, target }: { current: number; target: number }
): void {
  db.prepare(`
    INSERT INTO goals (id, name, type, target_amount, current_amount, account_id, is_archived, created_at, updated_at)
    VALUES ('goal_1', 'Emergency Fund', 'savings', ?, ?, ?, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  `).run(target, current, accountId);
}

test('a linked goal earmarks its account balance, not the stored current_amount', () => {
  const db = migratedTestDb();
  insertAccount(db, { id: 'acc_checking', type: 'checking', current_balance: 671202 });
  insertAccount(db, { id: 'acc_savings', type: 'savings', current_balance: 0 });
  // The live shape: the column says $1,001.70, the linked account holds nothing.
  goalLinkedTo(db, 'acc_savings', { current: 100170, target: 500000 });

  const result = computeSafeToSpend(db);
  assert.equal(result.allocatedGoals, 0, 'earmarked money the goal account does not hold');
  assert.equal(result.free, 671202, 'the shortfall carried a phantom earmark');
  db.close();
});

test('a linked goal that has grown past current_amount earmarks the larger, true balance', () => {
  const db = migratedTestDb();
  insertAccount(db, { id: 'acc_checking', type: 'checking', current_balance: 500000 });
  insertAccount(db, { id: 'acc_savings', type: 'savings', current_balance: 300000 });
  // The inverted case, which understated the earmark and made `free` read too high.
  goalLinkedTo(db, 'acc_savings', { current: 100000, target: 500000 });

  const result = computeSafeToSpend(db);
  assert.equal(result.allocatedGoals, 300000);
  assert.equal(result.free, 800000 - 300000);
  db.close();
});

test('an unlinked goal still earmarks its stored amount', () => {
  const db = migratedTestDb();
  insertAccount(db, { id: 'acc_checking', type: 'checking', current_balance: 500000 });
  // No account to ask, so the column is the only answer there is and must still be honoured.
  goalLinkedTo(db, null, { current: 100000, target: 500000 });

  const result = computeSafeToSpend(db);
  assert.equal(result.allocatedGoals, 100000);
  assert.equal(result.free, 400000);
  db.close();
});

test('HEALTHY: no goals means no earmark and no shortfall invented', () => {
  const db = migratedTestDb();
  insertAccount(db, { id: 'acc_checking', type: 'checking', current_balance: 500000 });

  const result = computeSafeToSpend(db);
  assert.equal(result.allocatedGoals, 0);
  assert.equal(result.free, 500000);
  db.close();
});

test('the earmark is the whole linked balance, which is exactly what /plan reports as saved', () => {
  const db = migratedTestDb();
  insertAccount(db, { id: 'acc_checking', type: 'checking', current_balance: 100000 });
  insertAccount(db, { id: 'acc_savings', type: 'savings', current_balance: 900000 });
  // `calculateGoalProgress` clamps `progress_amount` and `progress_percent` to the target but
  // leaves `current_amount` at the full balance, and `routes/goals.ts` renders `current_amount`.
  // So /plan reports $9,000 saved against a $5,000 goal at 100%, and this earmark has to be the
  // same $9,000 or the two surfaces disagree again in the other direction. Asserting the uncapped
  // figure is deliberate: agreement with /plan is the property, not a ceiling of my own choosing.
  goalLinkedTo(db, 'acc_savings', { current: 0, target: 500000 });

  const result = computeSafeToSpend(db);
  assert.equal(result.allocatedGoals, 900000, 'must equal the current_amount /plan renders');
  assert.equal(
    calculateGoalProgress({ type: 'savings', target_amount: 500000, current_amount: 0, account_balance: 900000 }).current_amount,
    result.allocatedGoals,
    'the earmark and the goal screen must be the same number, by construction'
  );
  db.close();
});
