import { test } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { netWorthTimeline } from '../server/src/services/netWorthTimeline';
import { getNetWorthAttribution } from '../server/src/services/reporting';
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

test('a confirmed duplicate is walked back through once, not twice', () => {
  const { db, checking } = cashAndCard();
  const copy = insertTransaction(db, { account_id: checking, date: '2026-02-01', amount: -30000 });
  db.prepare("UPDATE transactions SET duplicate_status = 'confirmed' WHERE id = ?").run(copy);
  const { points, accounts } = netWorthTimeline(db, { accountIds: [checking], today: TODAY });
  assert.equal(points.find((p) => p.date === '2026-01-31')!.by_account[checking], 100000);
  assert.equal(accounts[0].opening_balance, 0, 'the walk still opens at zero, as it does without the copy');
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

test('a day names only the accounts that are estimated on it, so a cash account is never marked estimated', () => {
  const { db, checking } = cashAndCard();
  const broker = insertAccount(db, { account_name: 'Broker', type: 'brokerage', current_balance: 50000 });
  insertTransaction(db, { account_id: broker, date: '2026-02-01', amount: 50000, category_id: 'cat_inv_transfer' });
  const { points } = netWorthTimeline(db, { today: TODAY });
  const day = points.find((p) => p.date === '2026-02-20')!;
  assert.deepEqual(day.estimated_accounts, [broker]);
  assert.ok(!day.estimated_accounts.includes(checking));
  assert.deepEqual(points.find((p) => p.date === '2026-01-20')!.estimated_accounts, []);
});

test('today is every account\'s current balance, even where an earlier observation exists today', () => {
  const db = migratedTestDb();
  const broker = insertAccount(db, { account_name: 'Broker', type: 'brokerage', current_balance: 130000 });
  insertTransaction(db, { account_id: broker, date: '2026-01-05', amount: 100000, category_id: 'cat_inv_transfer' });
  valuation(db, broker, TODAY, 129000);
  const last = netWorthTimeline(db, { today: TODAY }).points.at(-1)!;
  assert.deepEqual([last.date, last.net_worth, last.estimated], [TODAY, 130000, false]);
});

function sheet(db: Database.Database, date: string, breakdown: Record<string, number>) {
  const netWorth = Object.values(breakdown).reduce((sum, value) => sum + value, 0);
  db.prepare(`INSERT INTO net_worth_snapshots (id, date, total_assets, total_liabilities, net_worth, breakdown, is_estimated, created_at)
    VALUES (?, ?, ?, 0, ?, ?, 0, ?)`).run(`sheet_${date}`, date, netWorth, netWorth, JSON.stringify(breakdown), `${date}T20:00:00Z`);
}

test('an account that holds a balance only carries each recorded value until the next, and is unknown before the first', () => {
  const { db } = cashAndCard();
  const wallet = insertAccount(db, { account_name: 'Wallet', type: 'cash', current_balance: 0 });
  db.prepare('UPDATE accounts SET balance_only = 1 WHERE id = ?').run(wallet);
  sheet(db, '2026-02-10', { [wallet]: 38000 });
  sheet(db, '2026-03-05', { [wallet]: 30000 });

  const { points } = netWorthTimeline(db, { today: TODAY });
  const on = (date: string) => points.find((p) => p.date === date)!;
  assert.equal(on('2026-02-09').by_account[wallet], undefined);
  assert.equal(on('2026-02-10').by_account[wallet], 38000);
  assert.equal(on('2026-03-04').by_account[wallet], 38000);
  assert.equal(on('2026-03-30').by_account[wallet], 30000);
  assert.equal(on(TODAY).by_account[wallet], 0);
  assert.ok(points.every((p) => !p.estimated_accounts.includes(wallet)));
});

test('naming a hidden account draws it, while the whole-book series leaves it out', () => {
  const { db } = cashAndCard();
  const hidden = insertAccount(db, { account_name: 'Old savings', type: 'savings', current_balance: 1200, is_hidden: 1 });
  insertTransaction(db, { account_id: hidden, date: '2026-02-01', amount: 1200 });
  assert.equal(netWorthTimeline(db, { today: TODAY }).points.at(-1)!.by_account[hidden], undefined);
  assert.equal(netWorthTimeline(db, { today: TODAY, accountIds: [hidden] }).points.at(-1)!.by_account[hidden], 1200);
});

test('HEALTHY: with nothing arriving after a sheet was read, the timeline lands on that sheet to the cent', () => {
  const { db, checking, card } = cashAndCard();
  sheet(db, '2026-02-03', { [checking]: 70000, [card]: 0 });
  sheet(db, '2026-02-20', { [checking]: 70000, [card]: 2500 });
  const { points } = netWorthTimeline(db, { today: TODAY });
  assert.equal(points.find((p) => p.date === '2026-02-03')!.net_worth, 70000);
  assert.equal(points.find((p) => p.date === '2026-02-20')!.net_worth, 70000 - 2500);
});

test('the Balance window, the Accounts chart and what moved it read one value for a day, even where a row arrived after that day\'s sheet', () => {
  const { db, checking, card } = cashAndCard();
  const wallet = insertAccount(db, { account_name: 'Wallet', type: 'cash', current_balance: 3000 });
  db.prepare('UPDATE accounts SET balance_only = 1 WHERE id = ?').run(wallet);
  // The sheet for 02-01 was read before the -30000 dated 02-01 arrived, so it recorded 100000.
  sheet(db, '2026-02-01', { [checking]: 100000, [card]: 0, [wallet]: 3000 });
  db.prepare("UPDATE transactions SET created_at = '2026-02-02T15:00:00Z' WHERE account_id = ? AND date = '2026-02-01'").run(checking);

  const window = netWorthTimeline(db, { from: '2026-01-15', to: '2026-02-01', today: TODAY }).points.at(-1)!;
  const accountsChart = netWorthTimeline(db, { from: '2026-01-15', to: '2026-02-01', today: TODAY, accountIds: [checking, card, wallet] }).points.at(-1)!;
  assert.equal(window.net_worth, 70000 + 3000);
  assert.equal(accountsChart.net_worth, window.net_worth);
  assert.deepEqual(accountsChart.by_account, window.by_account);
  const attribution = getNetWorthAttribution(db, { startDate: '2026-01-15', endDate: '2026-02-01' });
  assert.equal(attribution?.end_net_worth, window.net_worth);
});
