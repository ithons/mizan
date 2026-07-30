import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileAccounts } from '../server/src/services/reconciliation';
import { insertAccount, insertTransaction, migratedTestDb } from './helpers/schema';

function snapshot(
  db: ReturnType<typeof migratedTestDb>,
  id: string,
  date: string,
  breakdown: Record<string, number>,
  isEstimated = false
): void {
  db.prepare(`
    INSERT INTO net_worth_snapshots
      (id, date, total_assets, total_liabilities, net_worth, breakdown, is_estimated,
       liquid_assets, investment_assets, crypto_assets, created_at)
    VALUES (?, ?, 0, 0, 0, ?, ?, 0, 0, 0, '2026-07-30')
  `).run(id, date, JSON.stringify(breakdown), isEstimated ? 1 : 0);
}

test('an account whose transactions explain its balance reconciles to zero', () => {
  const db = migratedTestDb();
  const account = insertAccount(db, { type: 'checking' });
  snapshot(db, 's1', '2026-07-01', { [account]: 100000 });
  snapshot(db, 's2', '2026-07-15', { [account]: 92000 });
  insertTransaction(db, { account_id: account, date: '2026-07-05', amount: -5000 });
  insertTransaction(db, { account_id: account, date: '2026-07-10', amount: -3000 });

  const report = reconcileAccounts(db);
  const row = report.accounts.find((a) => a.account_id === account);
  assert.equal(row?.observed_delta, -8000);
  assert.equal(row?.explained_delta, -8000);
  assert.equal(row?.residual, 0);
  assert.equal(report.unreconciled.length, 0);
  db.close();
});

test('a missing transaction shows up as an unexplained residual', () => {
  const db = migratedTestDb();
  const account = insertAccount(db, { type: 'checking' });
  snapshot(db, 's1', '2026-07-01', { [account]: 100000 });
  snapshot(db, 's2', '2026-07-15', { [account]: 40000 });
  // The balance fell by $600 but the ledger only accounts for $50 of it.
  insertTransaction(db, { account_id: account, date: '2026-07-05', amount: -5000 });

  const report = reconcileAccounts(db);
  const row = report.accounts.find((a) => a.account_id === account);
  assert.equal(row?.residual, -55000);
  assert.equal(report.unreconciled.length, 1);
  db.close();
});

test('a liability reconciles in net-worth terms, not raw balance terms', () => {
  const db = migratedTestDb();
  const card = insertAccount(db, { type: 'credit', is_liability: 1 });
  // Owed rises from $100 to $180 as $80 of purchases post. Net worth falls by $80.
  snapshot(db, 's1', '2026-07-01', { [card]: 10000 });
  snapshot(db, 's2', '2026-07-15', { [card]: 18000 });
  insertTransaction(db, { account_id: card, date: '2026-07-05', amount: -8000 });

  const report = reconcileAccounts(db);
  const row = report.accounts.find((a) => a.account_id === card);
  assert.equal(row?.observed_delta, -8000, 'a rising card balance is a fall in net worth');
  assert.equal(row?.residual, 0);
  db.close();
});

test('estimated snapshots are excluded, because reconciling against them is circular', () => {
  const db = migratedTestDb();
  const account = insertAccount(db, { type: 'checking' });
  snapshot(db, 'e1', '2026-06-01', { [account]: 999999 }, true);
  snapshot(db, 's1', '2026-07-01', { [account]: 100000 });
  snapshot(db, 's2', '2026-07-15', { [account]: 100000 });

  const report = reconcileAccounts(db);
  assert.equal(report.measured_snapshot_count, 2);
  // Including the estimate would have manufactured a huge residual out of a reconstruction that was
  // itself derived from the ledger this check is testing.
  assert.equal(report.accounts.find((a) => a.account_id === account)?.residual, 0);
  db.close();
});

test('a market-driven account is not reported as unexplained when prices move', () => {
  const db = migratedTestDb();
  const brokerage = insertAccount(db, { type: 'brokerage' });
  snapshot(db, 's1', '2026-07-01', { [brokerage]: 100000 });
  snapshot(db, 's2', '2026-07-15', { [brokerage]: 140000 });

  const report = reconcileAccounts(db);
  const row = report.accounts.find((a) => a.account_id === brokerage);
  assert.equal(row?.residual, 40000, 'the residual is still reported');
  assert.equal(row?.is_market_driven, true);
  // A brokerage that gained value with no transaction is a price move, not a gap in the ledger.
  // Alarming on it would teach the owner to dismiss the alarm.
  assert.equal(report.unreconciled.length, 0);
  db.close();
});

test('small drift is tolerated so posting lag does not raise a permanent alarm', () => {
  const db = migratedTestDb();
  const account = insertAccount(db, { type: 'checking' });
  snapshot(db, 's1', '2026-07-01', { [account]: 1000000 });
  snapshot(db, 's2', '2026-07-15', { [account]: 900100 });
  insertTransaction(db, { account_id: account, date: '2026-07-05', amount: -100000 });

  const report = reconcileAccounts(db);
  assert.equal(report.accounts.find((a) => a.account_id === account)?.residual, 100);
  assert.equal(report.unreconciled.length, 0);
  db.close();
});

test('an account absent from a snapshot is skipped, not reconciled to zero', () => {
  const db = migratedTestDb();
  const older = insertAccount(db, { type: 'checking' });
  const newer = insertAccount(db, { type: 'checking' });
  snapshot(db, 's1', '2026-07-01', { [older]: 100000 });
  snapshot(db, 's2', '2026-07-15', { [older]: 100000, [newer]: 50000 });
  snapshot(db, 's3', '2026-07-20', { [older]: 100000, [newer]: 50000 });

  const report = reconcileAccounts(db);
  // The newer account only has one window it appears in on both ends.
  assert.equal(report.accounts.find((a) => a.account_id === newer)?.window_count, 1);
  assert.equal(report.accounts.find((a) => a.account_id === older)?.window_count, 2);
  db.close();
});

test('fewer than two measured snapshots produces no report rather than a false clean bill', () => {
  const db = migratedTestDb();
  const account = insertAccount(db, { type: 'checking' });
  snapshot(db, 's1', '2026-07-01', { [account]: 100000 });

  const report = reconcileAccounts(db);
  assert.deepEqual(report.accounts, []);
  assert.equal(report.measured_snapshot_count, 1);
  db.close();
});
