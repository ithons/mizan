import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import type Database from 'better-sqlite3';
import { _setDbForTesting } from '../server/src/db/index';
import accountsRouter from '../server/src/routes/accounts';
import { getLedgerBalanceHistory, getSnapshotBalanceHistory } from '../server/src/services/balanceHistory';
import { seriesMeasurements, seriesOrigin } from '../client/src/views/accounts/AccountDetail';
import { trendGeometry } from '../client/src/components/balance/TrendChart';
import type { AccountBalanceHistory } from '../shared/types';
import { insertAccount, insertTransaction, migratedTestDb } from './helpers/schema';

/**
 * An account's balance chart, derived from its own ledger.
 *
 * It used to be read out of `net_worth_snapshots`, so it said more about whether the app was
 * running than about the money: 19 points over 179 days for every account, spaced 1 to 31 days
 * apart. Wealthfront Cash was drawn at $1,517.30, $0.00, $1.70 on consecutive points, on an account
 * whose 12 transactions say it held $1.70 continuously across all three.
 *
 * The line is one reconstruction end to end and the recorded balances are dots on it. Four earlier
 * rounds instead compared the two and printed the difference, and each fired on an account where
 * nothing was wrong, so most of this file is healthy accounts proving the screen stays quiet.
 */

const TODAY = '2026-07-30';

/** Words that would turn a chart caption into a finding the owner cannot act on. */
const ALARM = /differ|discrepan|missing|unaccounted|mismatch|off by|unexplain|error|gap|gone astray/i;

/** Every field the payload has. A comparison quantity cannot reappear without failing here. */
const PAYLOAD_KEYS = ['basis', 'drawn_transaction_count', 'measurements', 'points', 'start_date', 'start_reason'];

function captions(history: AccountBalanceHistory): string[] {
  return [seriesOrigin(history), seriesMeasurements(history)].filter((s): s is string => s !== null);
}

/** The screen says nothing about this account beyond where the line comes from and what the dots are. */
function assertSilent(history: AccountBalanceHistory, label: string): void {
  assert.deepEqual(Object.keys(history).sort(), PAYLOAD_KEYS, `${label}: payload shape`);
  for (const caption of captions(history)) {
    assert.doesNotMatch(caption, ALARM, `${label}: ${caption}`);
  }
}

/**
 * Snapshot dates and their per-account value, exactly as the live database holds them. One row per
 * date (the real schema's UNIQUE), so a second account seeded on the same dates merges into it.
 */
function insertSnapshot(
  db: Database.Database,
  date: string,
  breakdown: Record<string, number>,
  isEstimated: boolean
): void {
  const existing = db.prepare('SELECT breakdown FROM net_worth_snapshots WHERE date = ?').get(date) as
    | { breakdown: string }
    | undefined;
  const merged = { ...(existing ? (JSON.parse(existing.breakdown) as Record<string, number>) : {}), ...breakdown };
  const total = Object.values(merged).reduce((sum, v) => sum + v, 0);

  if (existing) {
    db.prepare('UPDATE net_worth_snapshots SET breakdown = ?, total_assets = ?, net_worth = ? WHERE date = ?')
      .run(JSON.stringify(merged), total, total, date);
    return;
  }
  db.prepare(`
    INSERT INTO net_worth_snapshots
      (id, date, total_assets, total_liabilities, net_worth, breakdown, is_estimated, created_at)
    VALUES (?, ?, ?, 0, ?, ?, ?, ?)
  `).run(`snap_${date}`, date, total, total, JSON.stringify(merged), isEstimated ? 1 : 0, `${date}T12:00:00.000Z`);
}

function pointOn(history: AccountBalanceHistory, date: string): number | undefined {
  return history.points.find((p) => p.date === date)?.balance;
}

function markOn(history: AccountBalanceHistory, date: string): number | undefined {
  return history.measurements.find((m) => m.date === date)?.balance;
}

/** Wealthfront Cash: 12 transactions, stored balance $1,001.70. */
function seedWealthfront(db: Database.Database): string {
  const id = insertAccount(db, { account_name: 'Wealthfront Cash', type: 'savings', current_balance: 100170 });
  const rows: Array<[string, number]> = [
    ['2025-12-17', 50000],
    ['2026-01-01', 79],
    ['2026-02-01', 163],
    ['2026-02-23', 100000],
    ['2026-03-01', 213],
    ['2026-04-01', 454],
    ['2026-05-01', 403],
    ['2026-06-01', 418],
    ['2026-06-02', 100000],
    ['2026-06-09', -251730],
    ['2026-07-01', 170],
    ['2026-07-16', 100000],
  ];
  for (const [date, amount] of rows) insertTransaction(db, { account_id: id, date, amount });

  // The five estimated snapshots are the invented history: $502.42 rising to $1,517.30 for months
  // the account was not connected, then $0.00 on the first two measured days.
  for (const [date, value] of [
    ['2026-02-01', 50242],
    ['2026-03-01', 150455],
    ['2026-04-01', 150909],
    ['2026-05-01', 151312],
    ['2026-06-01', 151730],
  ] as Array<[string, number]>) {
    insertSnapshot(db, date, { [id]: value }, true);
  }
  for (const [date, value] of [
    ['2026-06-30', 0],
    ['2026-07-01', 0],
    ['2026-07-03', 170],
    ['2026-07-05', 170],
    ['2026-07-09', 170],
    ['2026-07-13', 170],
    ['2026-07-14', 170],
    ['2026-07-15', 170],
    ['2026-07-16', 170],
    ['2026-07-23', 100170],
    ['2026-07-24', 100170],
    ['2026-07-27', 100170],
    ['2026-07-28', 100170],
    ['2026-07-29', 100170],
  ] as Array<[string, number]>) {
    insertSnapshot(db, date, { [id]: value }, false);
  }
  return id;
}

test('the line is one point per day from the first transaction, and every point is the ledger’s', () => {
  const db = migratedTestDb();
  const id = seedWealthfront(db);

  const history = getLedgerBalanceHistory(db, id, { today: TODAY });

  assert.equal(history.basis, 'ledger');
  assert.equal(history.points.length, 226);
  assert.equal(history.points.every((p) => p.source === 'ledger'), true, 'no point changes style mid-series');
  assert.equal(history.start_date, '2025-12-17');
  assert.equal(history.start_reason, 'first_transaction');
  assert.equal(history.drawn_transaction_count, 12);
  // The five estimated snapshots are reconstructions, not balances anyone observed.
  assert.equal(history.measurements.length, 14);
  assertSilent(history, 'Wealthfront');

  db.close();
});

test('the invented cliff is gone: the account held $1.70 for six weeks, not $0.00', () => {
  const db = migratedTestDb();
  const id = seedWealthfront(db);

  const history = getLedgerBalanceHistory(db, id, { today: TODAY });

  // The old chart read $1,517.30 -> $0.00 -> $1.70 -> $1,001.70 across four points and drew the
  // last three as measured history. The ledger says the account held $1.70 continuously from the
  // June withdrawal until the July deposit: 45 days the snapshot series compressed into one drop.
  for (const date of ['2026-07-02', '2026-07-08', '2026-07-15']) {
    assert.equal(pointOn(history, date), 170, date);
  }
  assert.equal(pointOn(history, '2026-06-08'), 251730);
  assert.equal(pointOn(history, '2026-06-09'), 0);
  assert.equal(pointOn(history, TODAY), 100170, 'the series ends on the balance the account holds');

  db.close();
});

test('a day with an inflow and then two outflows, observed in between, reports nothing', () => {
  const db = migratedTestDb();
  // The healthy case every previous round fired on. An hourly sync caught the balance after payroll
  // landed and before the two debits cleared, so the recorded balance sits $715.00 above the day's
  // close and above its open. No comparison built from day boundaries can contain that, which is
  // why there is no comparison: the dot is drawn where it was recorded.
  const id = insertAccount(db, { account_name: 'Chase Checking', type: 'checking', current_balance: 300000 });
  insertTransaction(db, { account_id: id, date: '2026-07-01', amount: 100000 });
  insertTransaction(db, { account_id: id, date: '2026-07-15', amount: 271500, merchant_name: 'Payroll' });
  insertTransaction(db, { account_id: id, date: '2026-07-15', amount: -50000 });
  insertTransaction(db, { account_id: id, date: '2026-07-15', amount: -21500 });
  insertSnapshot(db, '2026-07-15', { [id]: 371500 }, false);

  const history = getLedgerBalanceHistory(db, id, { today: TODAY });

  assert.equal(pointOn(history, '2026-07-14'), 100000);
  assert.equal(pointOn(history, '2026-07-15'), 300000, 'the day closes on its net movement');
  assert.equal(markOn(history, '2026-07-15'), 371500, 'the dot is the balance that was recorded');
  assertSilent(history, 'intraday observation');
  assert.match(seriesMeasurements(history) ?? '', /The dot is the one balance recorded/);

  db.close();
});

test('a snapshot taken before the day’s own deposit posted reports nothing', () => {
  const db = migratedTestDb();
  const id = seedWealthfront(db);

  const history = getLedgerBalanceHistory(db, id, { today: TODAY });

  // Wealthfront's 2026-07-16 snapshot reads $1.70 against a $1,000.00 deposit dated the same day.
  assert.equal(pointOn(history, '2026-07-16'), 100170);
  assert.equal(markOn(history, '2026-07-16'), 170);
  assertSilent(history, 'posting lag');

  db.close();
});

test('a payroll the provider had not posted by the next day’s sync reports nothing', () => {
  const db = migratedTestDb();
  // Chase Checking's shape: reconciliation.ts isolates exactly this as `boundary_amount`, and the
  // ledger holds 20 payroll rows with no gap. The snapshot on 07-01 predates the 06-30 payroll
  // reaching the balance.
  const id = insertAccount(db, { account_name: 'Chase Checking', type: 'checking', current_balance: 652205 });
  insertTransaction(db, { account_id: id, date: '2026-06-15', amount: 100000 });
  insertTransaction(db, { account_id: id, date: '2026-06-30', amount: 54418 });
  insertSnapshot(db, '2026-06-30', { [id]: 597787 }, false);
  insertSnapshot(db, '2026-07-01', { [id]: 597787 }, false);

  const history = getLedgerBalanceHistory(db, id, { today: TODAY });

  assert.deepEqual(history.measurements.map((m) => m.balance), [597787, 597787]);
  assertSilent(history, 'boundary payroll');

  db.close();
});

test('an ordinary card month, with purchases and a payment, reports nothing', () => {
  const db = migratedTestDb();
  const id = insertAccount(db, {
    account_name: 'Capital One Savor',
    type: 'credit',
    current_balance: 888,
    is_liability: 1,
  });
  insertTransaction(db, { account_id: id, date: '2026-06-02', amount: -4200 });
  insertTransaction(db, { account_id: id, date: '2026-06-19', amount: -1888 });
  insertTransaction(db, { account_id: id, date: '2026-07-05', amount: 6088 });
  insertTransaction(db, { account_id: id, date: '2026-07-25', amount: -888 });
  insertSnapshot(db, '2026-06-30', { [id]: 6088 }, false);
  insertSnapshot(db, '2026-07-09', { [id]: 0 }, false);
  insertSnapshot(db, '2026-07-29', { [id]: 888 }, false);

  const history = getLedgerBalanceHistory(db, id, { today: TODAY });

  // Net-worth signed on both the line and the dots: a card that owes $8.88 subtracts from net worth.
  assert.equal(pointOn(history, TODAY), -888);
  assert.equal(pointOn(history, '2026-07-04'), -6088);
  assert.equal(pointOn(history, '2026-07-06'), 0);
  assert.deepEqual(history.measurements.map((m) => m.balance), [-6088, 0, -888]);
  assertSilent(history, 'ordinary card month');

  db.close();
});

/**
 * Discover: the card the live database disagrees with itself about. Day sums are the live ones, and
 * the reconstruction sits $1,126.52 below the balance recorded on 2026-06-30, which is exactly twice
 * the stored balance. Nothing on this screen can repair that, so nothing on this screen accuses it.
 */
function seedDiscover(db: Database.Database): string {
  const id = insertAccount(db, { account_name: 'Discover', type: 'credit', current_balance: 56326, is_liability: 1 });
  for (const [date, amount] of [
    ['2026-06-16', -769],
    ['2026-06-21', -510],
    ['2026-06-26', -8463],
    ['2026-07-12', 96590],
    ['2026-07-17', 75936],
    ['2026-07-19', -1800],
    ['2026-07-23', 23662],
    ['2026-07-24', -16999],
    ['2026-07-25', -15500],
  ] as Array<[string, number]>) {
    insertTransaction(db, { account_id: id, date, amount });
  }
  insertSnapshot(db, '2026-06-30', { [id]: 105563 }, false);
  insertSnapshot(db, '2026-07-13', { [id]: 8973 }, false);
  insertSnapshot(db, '2026-07-29', { [id]: 56326 }, false);
  return id;
}

test('an account carrying a reconciliation residual is drawn, not accused', () => {
  const db = migratedTestDb();
  const id = seedDiscover(db);

  const history = getLedgerBalanceHistory(db, id, { today: TODAY });

  // The residual is visible rather than stated: on 2026-06-30 the line is at -$2,182.15 and the dot
  // at -$1,055.63, and by 2026-07-29 the two coincide. Nothing subtracts them.
  assert.equal(pointOn(history, '2026-06-30'), -218215);
  assert.equal(markOn(history, '2026-06-30'), -105563);
  assert.equal(218215 - 105563, 2 * 56326, 'the residual is twice the stored balance');
  assert.equal(pointOn(history, '2026-07-29'), -56326);
  assert.equal(markOn(history, '2026-07-29'), -56326);
  assert.equal(pointOn(history, TODAY), -56326);
  assertSilent(history, 'Discover residual');

  db.close();
});

test('the series stops at the backfill floor when only the provider reaches below it', () => {
  const db = migratedTestDb();
  // A provider row below the account's own floor is the state migration 030 exists to prevent: the
  // feed served part of a period it does not cover, so the ledger cannot describe that stretch.
  const id = insertAccount(db, { account_name: 'Discover', type: 'credit', current_balance: 56326, is_liability: 1 });
  db.prepare('UPDATE accounts SET backfill_floor_date = ? WHERE id = ?').run('2026-06-16', id);
  insertTransaction(db, { account_id: id, date: '2026-05-30', amount: -400, source_type: 'simplefin' });
  insertTransaction(db, { account_id: id, date: '2026-06-16', amount: -769, source_type: 'simplefin' });
  insertTransaction(db, { account_id: id, date: '2026-07-19', amount: -1800, source_type: 'simplefin' });
  insertSnapshot(db, '2026-05-20', { [id]: 50000 }, false);
  insertSnapshot(db, '2026-07-19', { [id]: 56326 }, false);

  const history = getLedgerBalanceHistory(db, id, { today: TODAY });

  assert.equal(history.start_reason, 'backfill_floor');
  assert.equal(history.start_date, '2026-06-16');
  assert.equal(history.points[0].date, '2026-06-16');
  assert.equal(history.points.some((p) => p.date < '2026-06-16'), false);
  // The row below the floor is not part of the line, so it is not counted as building it either,
  // and the measurement from before the floor has no point to sit on.
  assert.equal(history.drawn_transaction_count, 2);
  assert.deepEqual(history.measurements.map((m) => m.date), ['2026-07-19']);
  assert.match(seriesOrigin(history) ?? '', /The ledger begins Jun 16, 2026/);
  assertSilent(history, 'backfill floor');

  db.close();
});

test('an account with a single transaction draws from it and says so', () => {
  const db = migratedTestDb();
  const id = insertAccount(db, { account_name: 'Wallet', type: 'cash', current_balance: 25000 });
  insertTransaction(db, { account_id: id, date: '2026-07-10', amount: 25000 });
  insertSnapshot(db, '2026-07-20', { [id]: 25000 }, false);

  const history = getLedgerBalanceHistory(db, id, { today: TODAY });

  assert.equal(history.drawn_transaction_count, 1);
  assert.equal(history.points.length, 21);
  assert.equal(pointOn(history, '2026-07-10'), 25000);
  assert.match(seriesOrigin(history) ?? '', /1 transaction drawn here, back to Jul 10, 2026/);
  assert.match(seriesMeasurements(history) ?? '', /^The dot is the one balance recorded/);
  assertSilent(history, 'single transaction');

  db.close();
});

test('a requested window clamps both ends, and keeps only the dots inside it', () => {
  const db = migratedTestDb();
  const id = insertAccount(db, { type: 'checking', current_balance: 100000 });
  insertTransaction(db, { account_id: id, date: '2026-06-10', amount: 20000 });
  insertTransaction(db, { account_id: id, date: '2026-07-20', amount: 30000 });
  insertSnapshot(db, '2026-06-12', { [id]: 20000 }, false);
  insertSnapshot(db, '2026-07-19', { [id]: 70000 }, false);
  insertSnapshot(db, '2026-07-28', { [id]: 100000 }, false);

  const history = getLedgerBalanceHistory(db, id, { from: '2026-07-01', to: '2026-07-21', today: TODAY });

  assert.equal(history.start_reason, 'requested_window');
  assert.equal(history.points[0].date, '2026-07-01');
  assert.equal(history.points[history.points.length - 1].date, '2026-07-21');
  // The window's last day is a balance, not today's: the 07-20 deposit is inside it.
  assert.equal(pointOn(history, '2026-07-19'), 70000);
  assert.equal(pointOn(history, '2026-07-20'), 100000);
  // A dot outside the drawn days has no point to sit on, so it is not served.
  assert.deepEqual(history.measurements.map((m) => m.date), ['2026-07-19']);

  db.close();
});

// ─── A window is chosen, not found, so it can hold nothing ───────────────────
//
// Every other start reason is derived from a row that exists, so its count is at least one. A
// requested window is placed by the caller and can sit over a stretch the account never moved in:
// the caption there used to read "Reconstructed from the 0 transactions drawn here", a
// reconstruction from nothing, describing a line that is in fact perfectly well defined.

test('a window with no transactions in it says so, and says what the flat line is', () => {
  const db = migratedTestDb();
  const id = insertAccount(db, { type: 'checking', current_balance: 100000 });
  insertTransaction(db, { account_id: id, date: '2026-06-10', amount: 20000 });
  insertTransaction(db, { account_id: id, date: '2026-07-20', amount: 30000 });

  const history = getLedgerBalanceHistory(db, id, { from: '2026-06-20', to: '2026-07-10', today: TODAY });

  assert.equal(history.start_reason, 'requested_window');
  assert.equal(history.drawn_transaction_count, 0);
  // The line is flat, and flat at the balance the account carried into the window: $700 after the
  // June deposit, with the July one rewound because it falls outside.
  assert.equal(new Set(history.points.map((p) => p.balance)).size, 1);
  assert.equal(history.points[0].balance, 70000);
  assert.equal(
    seriesOrigin(history),
    'No transactions fall in the window shown, from Jun 20, 2026. The line holds the balance carried into it.'
  );
  assertSilent(history, 'empty window');

  db.close();
});

test('a window that begins after its own last day admits there is no line', () => {
  const db = migratedTestDb();
  const id = insertAccount(db, { type: 'checking', current_balance: 100000 });
  insertTransaction(db, { account_id: id, date: '2026-06-10', amount: 100000 });

  const history = getLedgerBalanceHistory(db, id, { from: '2026-07-29', to: '2026-07-01', today: TODAY });

  assert.equal(history.start_reason, 'requested_window');
  assert.equal(history.start_date, null);
  assert.deepEqual(history.points, []);
  // With no start date there is no date to name, and the old sentence would have ended "from .".
  assert.equal(seriesOrigin(history), 'The window shown starts after its last day, so there is no line to draw.');
  assertSilent(history, 'inverted window');

  db.close();
});

test('imported history below the floor is history, and the series uses it', () => {
  const db = migratedTestDb();
  // BofA Cash Rewards carries 1,663 imported rows under a 2026-04-27 floor and its ledger really
  // does reach 2023-09-16. The floor marks where the PROVIDER's feed starts, not where the ledger
  // does, so it must not truncate an import.
  const id = insertAccount(db, { account_name: 'BofA Cash Rewards', type: 'credit', current_balance: 582, is_liability: 1 });
  db.prepare('UPDATE accounts SET backfill_floor_date = ? WHERE id = ?').run('2026-04-27', id);
  insertTransaction(db, { account_id: id, date: '2023-09-16', amount: -2500, source_type: 'import' });
  insertTransaction(db, { account_id: id, date: '2026-05-02', amount: -582, source_type: 'simplefin' });

  const history = getLedgerBalanceHistory(db, id, { today: TODAY });

  assert.equal(history.start_reason, 'first_transaction');
  assert.equal(history.start_date, '2023-09-16');
  // 1,049 points where the snapshot series drew 19, which is the whole value of this change.
  assert.equal(history.points.length, 1049);
  assertSilent(history, 'imported history');

  db.close();
});

test('an account with no ledger draws nothing and says why', () => {
  const db = migratedTestDb();
  const id = insertAccount(db, { account_name: 'Wallet', type: 'cash', current_balance: 38000 });

  const history = getLedgerBalanceHistory(db, id, { today: TODAY });

  // A flat line back to zero would be the app inventing the history it does not have.
  assert.deepEqual(history.points, []);
  assert.deepEqual(history.measurements, []);
  assert.equal(history.start_reason, 'no_ledger');
  assert.equal(history.start_date, null);
  assert.equal(seriesMeasurements(history), null);
  assertSilent(history, 'no ledger');

  db.close();
});

test('an unknown account id says so instead of returning an empty series', () => {
  const db = migratedTestDb();
  assert.equal(getLedgerBalanceHistory(db, 'nope', { today: TODAY }).start_reason, 'account_not_found');
  db.close();
});

test('a market-driven account keeps the snapshot series, estimates marked as estimates', () => {
  const db = migratedTestDb();
  const id = insertAccount(db, { account_name: 'Fidelity Individual', type: 'brokerage', current_balance: 193948 });
  // A brokerage's balance moves when prices move and no transaction records it, so a reverse
  // replay of its buys and sells cannot reconstruct what it was worth.
  insertTransaction(db, { account_id: id, date: '2026-05-21', amount: -40000 });
  insertSnapshot(db, '2026-02-01', { [id]: 173698 }, true);
  insertSnapshot(db, '2026-06-30', { [id]: 180000 }, false);
  insertSnapshot(db, '2026-07-29', { [id]: 193948 }, false);

  const history = getSnapshotBalanceHistory(db, id);

  assert.equal(history.basis, 'snapshot');
  assert.deepEqual(history.points.map((p) => p.source), ['estimated', 'measured', 'measured']);
  assert.equal(history.start_reason, 'snapshot_series');
  // The measurements are already the line, so marking them again would dot every point.
  assert.deepEqual(history.measurements, []);
  assert.equal(seriesMeasurements(history), null);
  assert.match(seriesOrigin(history) ?? '', /cannot reconstruct a price move/);
  assertSilent(history, 'brokerage');

  db.close();
});

test('GET /:id/history routes by account type and answers in dollars', async () => {
  const db = migratedTestDb();
  const ledgerId = seedWealthfront(db);
  const marketId = insertAccount(db, { account_name: 'Coinbase', type: 'crypto_wallet', current_balance: 39905 });
  insertSnapshot(db, '2026-06-30', { [marketId]: 40492 }, false);
  insertSnapshot(db, '2026-07-29', { [marketId]: 39905 }, false);

  await withRouter(db, async (baseUrl) => {
    const ledger = await fetchHistory(`${baseUrl}/api/accounts/${ledgerId}/history`);
    assert.equal(ledger.basis, 'ledger');
    // Cents in the DB, dollars at the edge: $1,001.70, not 100170.
    assert.equal(ledger.points[ledger.points.length - 1].balance, 1001.7);
    assert.equal(ledger.points[0].balance, 500);
    assert.equal(markOn(ledger, '2026-07-16'), 1.7);
    assert.equal(markOn(ledger, '2026-07-29'), 1001.7);
    assert.ok(ledger.points.length > 19, 'the snapshot series was 19 points for every account');
    assertSilent(ledger, 'route: ledger');

    const market = await fetchHistory(`${baseUrl}/api/accounts/${marketId}/history`);
    assert.equal(market.basis, 'snapshot');
    assert.deepEqual(market.points.map((p) => p.balance), [404.92, 399.05]);
    assertSilent(market, 'route: market');
  });

  db.close();
});

/**
 * What the chart draws for each of those series.
 *
 * Every segment is classified by its own two ends. An earlier version split the series at a single
 * estimated/measured boundary, which the snapshot series only satisfies by luck: `backfillSnapshots`
 * writes an estimated row for any past month holding no measured snapshot, so a fortnight with the
 * app switched off puts an estimate after a measurement. The last case here is that series.
 */
test('a ledger series is one unbroken line, with the recorded balances dotted on it', () => {
  const days = ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04'];
  const history = days.map((date, i) => ({ date, value: 100 + i * 10, estimated: false }));

  const geometry = trendGeometry(history, [{ date: '2026-07-02', value: 110 }, { date: '2026-07-04', value: 130 }]);

  assert.deepEqual(geometry.segments.map((s) => s.kind), ['measured'], 'no segment is drawn in a second style');
  assert.deepEqual([geometry.segments[0].from, geometry.segments[0].to], [0, 3]);
  assert.deepEqual(geometry.marks.map((m) => m.date), ['2026-07-02', '2026-07-04']);
  // A dot sitting on the line sits exactly on it.
  assert.equal(geometry.marks[0].yPct.toFixed(3), ((geometry.ys[1] / 140) * 100).toFixed(3));
});

test('a snapshot series splits where the estimates end, and the joining segment stays estimated', () => {
  const history = [
    { date: '2026-04-01', value: 10, estimated: true },
    { date: '2026-05-01', value: 20, estimated: true },
    { date: '2026-06-01', value: 30, estimated: false },
    { date: '2026-07-01', value: 40, estimated: false },
  ];

  const geometry = trendGeometry(history, []);

  // The joining segment has a reconstructed end, so it cannot claim to be an observation.
  assert.deepEqual(geometry.segments.map((s) => [s.kind, s.from, s.to]), [
    ['estimated', 0, 2],
    ['measured', 2, 3],
  ]);
});

test('a series that is estimated end to end is not drawn as though it were measured', () => {
  const history = [
    { date: '2026-04-01', value: 10, estimated: true },
    { date: '2026-05-01', value: 20, estimated: true },
  ];

  const geometry = trendGeometry(history, []);

  assert.deepEqual(geometry.segments.map((s) => s.kind), ['estimated']);
});

test('an estimate landing after a measurement splits the series twice, not once', () => {
  // Two weeks with the app switched off: the backfill writes 2026-09-01 as an estimate because no
  // measured snapshot exists for that month, and it lands after two measured days in July.
  const history = [
    { date: '2026-06-01', value: 10, estimated: true },
    { date: '2026-07-01', value: 20, estimated: false },
    { date: '2026-07-02', value: 21, estimated: false },
    { date: '2026-09-01', value: 30, estimated: true },
    { date: '2026-09-05', value: 31, estimated: false },
  ];

  const geometry = trendGeometry(history, []);

  assert.deepEqual(geometry.segments.map((s) => [s.kind, s.from, s.to]), [
    ['estimated', 0, 1],
    ['measured', 1, 2],
    ['estimated', 2, 4],
  ]);
});

test('a recorded balance well off the line is drawn where it is, not clipped to the edge', () => {
  const history = [
    { date: '2026-07-01', value: 500, estimated: false },
    { date: '2026-07-02', value: 520, estimated: false },
    { date: '2026-07-03', value: 540, estimated: false },
  ];

  // Discover's shape: the recorded balance is the ledger's, negated.
  const geometry = trendGeometry(history, [{ date: '2026-07-02', value: -520 }]);

  const mark = geometry.marks[0];
  assert.ok(mark.yPct > 0 && mark.yPct < 100, `${mark.yPct} is inside the plot`);
  assert.ok(
    mark.yPct > Math.max(...geometry.ys.map((y) => (y / 140) * 100)),
    'a balance below the whole line is drawn below the whole line'
  );
});

test('a recorded balance with no day on the line is not drawn', () => {
  const history = [
    { date: '2026-07-01', value: 500, estimated: false },
    { date: '2026-07-02', value: 520, estimated: false },
  ];

  assert.deepEqual(trendGeometry(history, [{ date: '2026-06-01', value: 400 }]).marks, []);
});

async function withRouter(db: Database.Database, run: (baseUrl: string) => Promise<void>): Promise<void> {
  _setDbForTesting(db);
  const app = express();
  app.use('/api/accounts', accountsRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    _setDbForTesting(null);
  }
}

async function fetchHistory(url: string): Promise<AccountBalanceHistory> {
  const res = await fetch(url);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: AccountBalanceHistory };
  return body.data;
}

// ─── The count belongs to the window, and the caption has to say so ───────────
//
// `start_reason` does not move when a `to` clamps the window, so the caption for a clamped series
// is still the `first_transaction` one. Read against a lifetime count that sentence is fine; read
// against a windowed count it is a claim about the account that the payload never made. Only the
// field name stops the two being confused, which is why it carries `drawn_`.

test('a clamped window counts only what it draws, and the caption claims only that', () => {
  const db = migratedTestDb();
  const id = seedWealthfront(db);

  const whole = getLedgerBalanceHistory(db, id, { today: TODAY });
  const clamped = getLedgerBalanceHistory(db, id, { today: TODAY, to: '2026-07-05' });

  assert.equal(clamped.start_reason, whole.start_reason, 'the clamp does not move the start reason');
  assert.equal(whole.drawn_transaction_count, 12);
  assert.equal(clamped.drawn_transaction_count, 11, 'the row dated after the clamp is not drawn');

  // The whole-ledger caption and the clamped one are the same sentence with a different number, so
  // the number is the only thing carrying the scope. It says "drawn here", not "this account's".
  const caption = seriesOrigin(clamped) ?? '';
  assert.match(caption, /^Reconstructed from the 11 transactions drawn here, back to Dec 17, 2025/);
  assert.ok(!/this account's 11/.test(caption));
  assertSilent(clamped, 'clamped window');

  db.close();
});
