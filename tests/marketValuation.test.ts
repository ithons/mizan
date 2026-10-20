import { test } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { pricedMarketValues } from '../server/src/services/marketValuation';
import { netWorthTimeline } from '../server/src/services/netWorthTimeline';
import { insertAccount, insertTransaction, migratedTestDb } from './helpers/schema';

const TODAY = '2026-03-10';

function ledger() {
  const db = migratedTestDb();
  const broker = insertAccount(db, { account_name: 'Broker', type: 'brokerage', current_balance: 0 });
  db.prepare("INSERT INTO securities (id, ticker, name, type, currency) VALUES ('sec_vt', 'VT', 'VT', 'equity', 'USD')").run();
  for (const [date, close] of [['2026-03-01', 100], ['2026-03-02', 110], ['2026-03-05', 120], ['2026-03-08', 125]] as const) {
    db.prepare("INSERT INTO security_prices (security_id, date, close, source, fetched_at) VALUES ('sec_vt', ?, ?, 'yahoo', '2026-03-10T00:00:00Z')").run(date, close);
  }
  insertTransaction(db, { account_id: broker, date: '2026-03-01', amount: -20000, original_name: 'YOU BOUGHT VT' });
  db.prepare("UPDATE transactions SET quantity = 2, security_id = 'sec_vt', is_internal_trade = 1 WHERE account_id = ?").run(broker);
  return { db, broker };
}

function holdings(db: Database.Database, accountId: string, date: string, quantity: number) {
  db.prepare(`INSERT INTO holdings_history (id, account_id, security_id, date, quantity, institution_price, institution_value, created_at)
    VALUES (?, ?, 'sec_vt', ?, ?, 0, 0, '2026-03-10T00:00:00Z')`).run(`h_${date}`, accountId, date, quantity);
}

test('positions carried between two recorded holdings that confirm them are valued at each day\'s close', () => {
  const { db, broker } = ledger();
  insertTransaction(db, { account_id: broker, date: '2026-03-04', amount: -11000, original_name: 'YOU BOUGHT VT' });
  db.prepare("UPDATE transactions SET quantity = 1, security_id = 'sec_vt', is_internal_trade = 1 WHERE date = '2026-03-04'").run();
  holdings(db, broker, '2026-03-02', 2);
  holdings(db, broker, '2026-03-08', 3);
  const values = pricedMarketValues(db, [broker], TODAY).get(broker)!;
  assert.equal(values.get('2026-03-01'), 20000);
  assert.equal(values.get('2026-03-03'), 22000, 'a day with no close takes the latest one');
  assert.equal(values.get('2026-03-05'), 36000);
  assert.equal(values.get('2026-03-08'), 37500);
  assert.equal(values.has('2026-03-09'), false, 'nothing after the last recorded holdings has been confirmed');
});

test('HEALTHY: an account with no recorded holdings gets no computed values at all', () => {
  const { db, broker } = ledger();
  assert.equal(pricedMarketValues(db, [broker], TODAY).get(broker), undefined);
});

test('a stretch whose carried positions the next recorded holdings contradict is left out', () => {
  const { db, broker } = ledger();
  holdings(db, broker, '2026-03-02', 2);
  holdings(db, broker, '2026-03-08', 5);
  const values = pricedMarketValues(db, [broker], TODAY).get(broker)!;
  assert.equal(values.get('2026-03-02'), 22000);
  assert.equal(values.has('2026-03-05'), false);
  assert.equal(values.get('2026-03-08'), 62500);
});

function snapshot(db: Database.Database, date: string, breakdown: Record<string, number>) {
  const netWorth = Object.values(breakdown).reduce((sum, value) => sum + value, 0);
  db.prepare(`INSERT INTO net_worth_snapshots (id, date, total_assets, total_liabilities, net_worth, breakdown, is_estimated, created_at)
    VALUES (?, ?, ?, 0, ?, ?, 0, ?)`).run(`snap_${date}`, date, netWorth, netWorth, JSON.stringify(breakdown), `${date}T20:00:00Z`);
}

function sweep(db: Database.Database, accountId: string, date: string, quantity: number) {
  db.prepare(`INSERT INTO holdings_history (id, account_id, security_id, date, quantity, institution_price, institution_value, created_at)
    VALUES (?, ?, 'sec_spaxx', ?, ?, 1, 0, '2026-03-10T00:00:00Z')`).run(`s_${date}`, accountId, date, quantity);
}

test('holdings that count a spent deposit beside the buys it paid for are not priced, so the next day is estimated between the two balances', () => {
  const { db, broker } = ledger();
  db.prepare("INSERT INTO securities (id, ticker, name, type, currency) VALUES ('sec_spaxx', 'SPAXX', 'Core', 'cash', 'USD')").run();
  holdings(db, broker, '2026-03-05', 2);
  sweep(db, broker, '2026-03-05', 240);
  holdings(db, broker, '2026-03-07', 2);
  sweep(db, broker, '2026-03-07', 240);
  snapshot(db, '2026-03-05', { [broker]: 24000 });
  snapshot(db, '2026-03-07', { [broker]: 24100 });

  const reported = new Map([[broker, new Map([['2026-03-05', 24000], ['2026-03-07', 24100]])]]);
  const values = pricedMarketValues(db, [broker], '2026-03-07', reported).get(broker)!;
  assert.equal(values.has('2026-03-05'), false);
  assert.equal(values.has('2026-03-06'), false, 'positions seeded from the contradicted capture are not carried');

  const { points } = netWorthTimeline(db, { from: '2026-03-05', today: '2026-03-08' });
  const middle = points.find((p) => p.date === '2026-03-06')!;
  assert.equal(middle.estimated, true);
  assert.ok(middle.net_worth >= 24000 && middle.net_worth <= 24100, `between the two balances, not the holdings' $480: ${middle.net_worth}`);
});

test('HEALTHY: holdings within a day\'s market move of the same-day balance stay priced and observed', () => {
  const { db, broker } = ledger();
  holdings(db, broker, '2026-03-02', 2);
  holdings(db, broker, '2026-03-08', 2);
  snapshot(db, '2026-03-02', { [broker]: 21700 });
  snapshot(db, '2026-03-08', { [broker]: 25300 });

  const { points } = netWorthTimeline(db, { from: '2026-03-02', today: '2026-03-10' });
  const on = (date: string) => points.find((p) => p.date === date)!;
  assert.deepEqual([on('2026-03-05').net_worth, on('2026-03-05').estimated], [24000, false]);
  assert.deepEqual([on('2026-03-02').net_worth, on('2026-03-02').estimated], [21700, false], 'the measured balance still wins on its own day');
});
