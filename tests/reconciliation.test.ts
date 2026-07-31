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

test('a row dated on the horizon\'s first date is a boundary artifact, not a ledger gap', () => {
  const db = migratedTestDb();
  const account = insertAccount(db, { type: 'checking' });
  snapshot(db, 's1', '2026-06-30', { [account]: 100000 });
  snapshot(db, 's2', '2026-07-15', { [account]: 154418 });
  // Chase Checking's exact shape: one payroll dated on the first snapshot's own date. The window
  // query is `date > first`, so it can never be explained, while its balance effect sits inside
  // the horizon. The ledger has 20 payroll rows with no gap over 8 days; nothing is missing.
  insertTransaction(db, { account_id: account, date: '2026-06-30', amount: 54418 });

  const report = reconcileAccounts(db);
  const row = report.accounts.find((a) => a.account_id === account);
  assert.equal(row?.residual, 54418, 'the raw residual stays visible');
  assert.equal(row?.boundary_amount, 54418);
  assert.equal(row?.adjusted_residual, 0);
  assert.equal(report.unreconciled.length, 0);
  db.close();
});

test('the same row one day inside the horizon is still an unexplained residual', () => {
  const db = migratedTestDb();
  const account = insertAccount(db, { type: 'checking' });
  snapshot(db, 's1', '2026-06-30', { [account]: 100000 });
  // The balance moved $1,088.36 and the ledger explains $544.18 of it. The boundary allowance is
  // one calendar day of activity at each end, so it must not absorb the other half.
  snapshot(db, 's2', '2026-07-15', { [account]: 208836 });
  insertTransaction(db, { account_id: account, date: '2026-07-01', amount: 54418 });

  const report = reconcileAccounts(db);
  const row = report.accounts.find((a) => a.account_id === account);
  assert.equal(row?.boundary_amount, 0);
  assert.equal(row?.adjusted_residual, 54418);
  assert.equal(report.unreconciled.length, 1);
  db.close();
});

test('a deposit during a down month does not make a brokerage look broken', () => {
  const db = migratedTestDb();
  const brokerage = insertAccount(db, { type: 'brokerage' });
  // $10,000 to $9,400 with one honest $600 deposit: observed -60000, explained +60000. The signs
  // disagree because observed_delta is transfers PLUS profit and loss, and this is the most
  // ordinary brokerage event there is. Alarming on it is exactly the alarm the exemption exists
  // to prevent.
  snapshot(db, 's1', '2026-07-01', { [brokerage]: 1000000 });
  snapshot(db, 's2', '2026-07-15', { [brokerage]: 940000 });
  insertTransaction(db, { account_id: brokerage, date: '2026-07-05', amount: 60000 });

  const report = reconcileAccounts(db);
  const row = report.accounts.find((a) => a.account_id === brokerage);
  assert.equal(row?.observed_delta, -60000);
  assert.equal(row?.explained_delta, 60000);
  assert.equal(row?.direction_conflict, false, 'the comparison is not sound on a market-driven balance');
  assert.equal(report.unreconciled.length, 0);
  db.close();
});

test('direction_conflict still holds where the balance only moves when a transaction moves it', () => {
  const db = migratedTestDb();
  const checking = insertAccount(db, { type: 'checking' });
  snapshot(db, 's1', '2026-07-01', { [checking]: 100000 });
  snapshot(db, 's2', '2026-07-15', { [checking]: 40000 });
  // The ledger says $600 came in and the balance fell $600. Nothing but a wrong sign does that on
  // an account with no market exposure.
  insertTransaction(db, { account_id: checking, date: '2026-07-05', amount: 60000 });

  const report = reconcileAccounts(db);
  assert.equal(report.accounts.find((a) => a.account_id === checking)?.direction_conflict, true);
  db.close();
});

test('a horizon opening on a payday is not a direction conflict', () => {
  const db = migratedTestDb();
  const checking = insertAccount(db, { type: 'checking' });
  snapshot(db, 's1', '2026-06-30', { [checking]: 100000 });
  snapshot(db, 's2', '2026-07-15', { [checking]: 130000 });
  // The payroll is dated on the horizon's own first date, so `date > first` excludes it from
  // explained while its $500 sits inside the balance movement. That alone points the two sides in
  // opposite directions on an ordinary month with nothing missing from the ledger.
  insertTransaction(db, { account_id: checking, date: '2026-06-30', amount: 50000 });
  insertTransaction(db, { account_id: checking, date: '2026-07-05', amount: -20000 });

  const report = reconcileAccounts(db);
  const row = report.accounts.find((a) => a.account_id === checking);
  assert.equal(row?.observed_delta, 30000);
  assert.equal(row?.explained_delta, -20000);
  assert.equal(row?.boundary_amount, 50000);
  assert.equal(row?.adjusted_residual, 0);
  assert.equal(row?.direction_conflict, false, 'the conflict is judged on the same adjusted figures');
  assert.equal(report.unreconciled.length, 0);
  db.close();
});

test('a flat balance is not a direction conflict, because Math.sign(0) is 0', () => {
  const db = migratedTestDb();
  const checking = insertAccount(db, { type: 'checking' });
  snapshot(db, 's1', '2026-07-01', { [checking]: 100000 });
  snapshot(db, 's2', '2026-07-15', { [checking]: 100000 });
  // Equal and opposite rows inside the window: the balance did not move and neither did net flow.
  insertTransaction(db, { account_id: checking, date: '2026-07-05', amount: -60000 });

  const report = reconcileAccounts(db);
  const row = report.accounts.find((a) => a.account_id === checking);
  assert.equal(row?.observed_delta, 0);
  assert.equal(row?.direction_conflict, false, 'a zero delta disagrees with nothing');
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

// ─── Skipped is not absent ────────────────────────────────────────────────────
//
// An account the check never judged used to fall out of the report entirely, which reads exactly
// like an account that reconciled. Every reader then had to re-derive the difference from
// `accounts`, and the one that forgot published a clean bill of health over a population it had
// never looked at.

test('an account absent from every window is reported as skipped, not omitted', () => {
  const db = migratedTestDb();
  const checking = insertAccount(db, { type: 'checking', account_name: 'Checking' });
  const newCard = insertAccount(db, { type: 'credit', is_liability: 1, account_name: 'New Card' });
  snapshot(db, 's1', '2026-07-01', { [checking]: 100000 });
  snapshot(db, 's2', '2026-07-15', { [checking]: 95000 });
  insertTransaction(db, { account_id: checking, date: '2026-07-05', amount: -5000 });
  // The card was connected after the last balance sheet, so it appears in neither breakdown.
  insertTransaction(db, { account_id: newCard, date: '2026-07-20', amount: -4000 });

  const report = reconcileAccounts(db);
  assert.deepEqual(report.accounts.map((a) => a.account_id), [checking]);
  assert.deepEqual(report.skipped, [
    { account_id: newCard, account_name: 'New Card', type: 'credit', reason: 'no_measured_window' },
  ]);
  db.close();
});

test('an account present in every window is not reported as skipped', () => {
  const db = migratedTestDb();
  const checking = insertAccount(db, { type: 'checking', account_name: 'Checking' });
  snapshot(db, 's1', '2026-07-01', { [checking]: 100000 });
  snapshot(db, 's2', '2026-07-15', { [checking]: 95000 });
  insertTransaction(db, { account_id: checking, date: '2026-07-05', amount: -5000 });

  const report = reconcileAccounts(db);
  assert.deepEqual(report.skipped, [], 'a judged account must not also read as skipped');
  db.close();
});

test('with too few snapshots every visible account is skipped for that reason', () => {
  const db = migratedTestDb();
  const account = insertAccount(db, { type: 'checking', account_name: 'Checking' });
  const hidden = insertAccount(db, { type: 'checking', account_name: 'Old', is_hidden: 1 });
  snapshot(db, 's1', '2026-07-01', { [account]: 100000, [hidden]: 100 });

  const report = reconcileAccounts(db);
  assert.deepEqual(report.skipped, [
    { account_id: account, account_name: 'Checking', type: 'checking', reason: 'check_did_not_run' },
  ]);
  db.close();
});
