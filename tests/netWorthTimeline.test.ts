import { test } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { netWorthTimeline } from '../server/src/services/netWorthTimeline';
import { insertAccount, insertTransaction, migratedTestDb } from './helpers/schema';

const TODAY = '2026-03-31';

function valuation(db: Database.Database, accountId: string, date: string, cents: number) {
  db.prepare(`INSERT INTO account_valuations (id, account_id, date, value_cents, source, created_at)
    VALUES (?, ?, ?, ?, 'statement', '2026-01-01T00:00:00Z')`).run(`v_${date}`, accountId, date, cents);
}

function cashAndCard() {
  const db = migratedTestDb();
  const checking = insertAccount(db, { account_name: 'Checking', type: 'checking', current_balance: 70000 });
  const card = insertAccount(db, { account_name: 'Card', type: 'credit', is_liability: 1, current_balance: 2500 });
  insertTransaction(db, { account_id: checking, date: '2026-01-10', amount: 100000 });
  insertTransaction(db, { account_id: checking, date: '2026-02-01', amount: -30000 });
  insertTransaction(db, { account_id: card, date: '2026-02-05', amount: -2500 });
  return { db, checking, card };
}

test('HEALTHY: one point for every day, ending on today\'s balances, with every account known throughout', () => {
  const { db, checking, card } = cashAndCard();
  const { points } = netWorthTimeline(db, { today: TODAY });
  assert.equal(points[0].date, '2026-01-10');
  assert.equal(points.length, 81);
  assert.equal(points.at(-1)!.net_worth, 70000 - 2500);
  assert.deepEqual(points.at(-1)!.by_account, { [checking]: 70000, [card]: -2500 });
  assert.ok(points.every((p) => p.coverage === 2 && !p.estimated));
  assert.equal(points.find((p) => p.date === '2026-01-31')!.net_worth, 100000);
});

test('an account that opened at zero counts as zero before its first row', () => {
  const { db, card } = cashAndCard();
  const { points, accounts } = netWorthTimeline(db, { today: TODAY });
  assert.equal(accounts.find((a) => a.id === card)!.opening_balance, 0);
  assert.equal(points.find((p) => p.date === '2026-01-20')!.by_account[card], 0);
});

test('an account whose ledger opens away from zero is unknown before its first row, not zero', () => {
  const { db } = cashAndCard();
  const savings = insertAccount(db, { account_name: 'Savings', type: 'savings', current_balance: 90000 });
  insertTransaction(db, { account_id: savings, date: '2026-02-15', amount: 10000 });
  const { points, accounts } = netWorthTimeline(db, { today: TODAY });
  assert.equal(accounts.find((a) => a.id === savings)!.opening_balance, 80000);
  const before = points.find((p) => p.date === '2026-02-14')!;
  assert.equal(before.coverage, 2);
  assert.equal(before.by_account[savings], undefined);
  assert.equal(points.find((p) => p.date === '2026-02-15')!.coverage, 3);
});

test('a market-driven account meets each valuation exactly and is estimated between them', () => {
  const db = migratedTestDb();
  const broker = insertAccount(db, { account_name: 'Broker', type: 'brokerage', current_balance: 130000 });
  insertTransaction(db, { account_id: broker, date: '2026-01-05', amount: 100000, category_id: 'cat_inv_transfer' });
  insertTransaction(db, { account_id: broker, date: '2026-02-10', amount: 20000, category_id: 'cat_inv_transfer' });
  valuation(db, broker, '2026-01-31', 103000);
  valuation(db, broker, '2026-02-28', 125000);
  const { points } = netWorthTimeline(db, { today: TODAY });
  const on = (d: string) => points.find((p) => p.date === d)!;
  assert.deepEqual([on('2026-01-31').net_worth, on('2026-01-31').estimated], [103000, false]);
  assert.deepEqual([on('2026-02-28').net_worth, on('2026-02-28').estimated], [125000, false]);
  assert.deepEqual([on('2026-02-09').net_worth, on('2026-02-09').estimated], [125000 - 20000, true]);
  assert.equal(on('2026-03-15').net_worth, 130000);
  assert.equal(points[0].date, '2026-01-05');
});

test('a month step keeps the last day of each month and the final day', () => {
  const { db } = cashAndCard();
  const { points } = netWorthTimeline(db, { today: '2026-03-15', step: 'month' });
  assert.deepEqual(points.map((p) => p.date), ['2026-01-31', '2026-02-28', '2026-03-15']);
});

test('choosing accounts limits both the totals and the coverage to them', () => {
  const { db, checking } = cashAndCard();
  const { points, accounts } = netWorthTimeline(db, { today: TODAY, accountIds: [checking] });
  assert.deepEqual(accounts.map((a) => a.id), [checking]);
  assert.equal(points.at(-1)!.net_worth, 70000);
  assert.equal(points.at(-1)!.coverage, 1);
});
