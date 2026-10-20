import { test } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { pricedMarketValues } from '../server/src/services/marketValuation';
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
