import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import type Database from 'better-sqlite3';
import { insertAccount, insertTransaction, migratedTestDb } from './helpers/schema';
import { _setDbForTesting } from '../server/src/db/index';
import transactionsRouter from '../server/src/routes/transactions';
import { classifyCounterparty, findCounterparties, zelleName } from '../server/src/services/counterparties';
import { runAdvisorTool } from '../server/src/services/advisorChatTools';
import type { CounterpartiesResponse } from '../shared/types';

const TODAY = new Date('2026-10-22T12:00:00');

function ledger(): { db: Database.Database; checking: string; savings: string } {
  const db = migratedTestDb();
  const checking = insertAccount(db, { account_name: 'Checking' });
  const savings = insertAccount(db, { account_name: 'Savings' });
  return { db, checking, savings };
}

function move(db: Database.Database, account: string, date: string, amount: number, descriptor: string): string {
  return insertTransaction(db, {
    account_id: account,
    date,
    amount,
    original_name: descriptor,
    category_id: amount < 0 ? 'cat_xfer_out' : 'cat_xfer_in',
  });
}

test('Zelle names are read from both banks\' descriptors', () => {
  assert.equal(zelleName('Zelle payment to Robin Park for "dinner"; Conf# a1b2c3 myx'), 'Robin Park');
  assert.equal(zelleName('Zelle payment from MORGAN HALE Conf# x1 abcdef'), 'MORGAN HALE');
  assert.equal(zelleName('Zelle payment from CASEY NOOR BACabcdefgh'), 'CASEY NOOR');
  assert.equal(zelleName('Zelle payment to Jordan Lee 10000000001'), 'Jordan Lee');
  assert.equal(classifyCounterparty('Zelle payment from Dana M Brooks Conf# 1')?.key, classifyCounterparty('Zelle payment to DANA BROOKS Conf# 2')?.key);
  assert.equal(classifyCounterparty('VENMO DES:CASHOUT ID:1 INDN:X CO ID:5 PPD')?.kind, 'wallet');
  assert.equal(classifyCounterparty('PMNT SENT 0719 VENMO Vi Tri Visa Direct NY')?.channel, 'venmo');
  assert.equal(classifyCounterparty('BKOFAMERICA BC 06/04 4000000001 WITHDRWL')?.kind, 'cash');
  assert.equal(classifyCounterparty('NON-CHASE ATM WITHDRAW 386274 04/25*NEWTONVI')?.kind, 'cash');
  assert.equal(classifyCounterparty('REMOTE ONLINE DEPOSIT # 1'), null);
});

test('an ordinary split that nets to zero within 60 days is settled and raises nothing', () => {
  const { db, checking } = ledger();
  move(db, checking, '2026-09-01', -4600, 'Zelle payment to Sam Ortiz for "tickets"; Conf# a1');
  move(db, checking, '2026-09-20', 4600, 'Zelle payment from SAM ORTIZ Conf# b2');
  const [sam] = findCounterparties(db, TODAY).people;
  assert.equal(sam.state, 'settled');
  assert.equal(sam.net, 0);
  assert.equal(sam.older_than_window, false);
});

test('a friend who received $46 and never paid back shows an open balance of $46', () => {
  const { db, checking } = ledger();
  move(db, checking, '2026-09-15', -4600, 'Zelle payment to Jordan Lee 10000000001');
  const [jordan] = findCounterparties(db, TODAY).people;
  assert.equal(jordan.name, 'Jordan Lee');
  assert.equal(jordan.state, 'sent_more');
  assert.equal(jordan.sent, 4600);
  assert.equal(jordan.net, -4600);
  assert.equal(jordan.older_than_window, false);
  const later = findCounterparties(db, new Date('2026-11-16T12:00:00')).people[0];
  assert.equal(later.older_than_window, true);
});

test('a transfer between two of the owner\'s accounts never appears', () => {
  const { db, checking, savings } = ledger();
  const out = move(db, checking, '2026-09-01', -50000, 'Zelle payment to Alex Owner Conf# x');
  const back = move(db, savings, '2026-09-01', 50000, 'Zelle payment from ALEX OWNER Conf# y');
  db.prepare("UPDATE transactions SET transfer_pair_id = 'xfer_1', transfer_status = 'confirmed' WHERE id IN (?, ?)").run(out, back);
  const reading = findCounterparties(db, TODAY);
  assert.deepEqual(reading.people, []);
  assert.deepEqual(reading.channels, []);
  assert.equal(reading.unclassified.rows, 0);
});

test('a pair id with no counterpart on another account does not hide the row', () => {
  const { db, checking } = ledger();
  const lone = move(db, checking, '2026-09-01', -2000, 'Zelle payment to Rai Conf# z');
  db.prepare("UPDATE transactions SET transfer_pair_id = 'xfer_orphan' WHERE id = ?").run(lone);
  assert.equal(findCounterparties(db, TODAY).people[0]?.sent, 2000);
});

test('Venmo is a wallet with its pass-through, not money owed', () => {
  const { db, checking } = ledger();
  move(db, checking, '2026-08-01', -30000, 'VENMO DES:PAYMENT ID:1 INDN:OWNER CO ID:1000000006 WEB');
  move(db, checking, '2026-08-20', 12000, 'VENMO CASHOUT PPD ID: 1000000007');
  const reading = findCounterparties(db, TODAY);
  assert.deepEqual(reading.people, []);
  const [venmo] = reading.channels;
  assert.equal(venmo.kind, 'wallet');
  assert.equal(venmo.state, null);
  assert.equal(venmo.older_than_window, false);
  assert.equal(venmo.sent, 30000);
  assert.equal(venmo.received, 12000);
});

test('ATM cash is withdrawn money, unjudged, and rows no family claims are counted, not dropped', () => {
  const { db, checking } = ledger();
  move(db, checking, '2026-03-03', -30000, 'BKOFAMERICA ATM 03/03 4000000002 WITHDRWL MAIN ST CAMBRIDGE MA');
  move(db, checking, '2026-03-04', 16500, 'REMOTE ONLINE DEPOSIT # 1');
  const reading = findCounterparties(db, TODAY);
  assert.equal(reading.channels[0].kind, 'cash');
  assert.equal(reading.channels[0].sent, 30000);
  assert.equal(reading.channels[0].state, null);
  assert.deepEqual(reading.unclassified, { rows: 1, sent: 0, received: 16500 });
});

test('pending rows, resolved duplicates and spending categories stay out', () => {
  const { db, checking } = ledger();
  insertTransaction(db, { account_id: checking, date: '2026-09-01', amount: -1000, original_name: 'Zelle payment to Kyle Conf# p', category_id: 'cat_xfer_out', pending: 1 });
  insertTransaction(db, { account_id: checking, date: '2026-09-01', amount: -1000, original_name: 'Zelle payment to Kyle Conf# q', category_id: 'cat_food_restaurants' });
  const dup = move(db, checking, '2026-09-02', -1000, 'Zelle payment to Kyle Conf# r');
  db.prepare("UPDATE transactions SET duplicate_status = 'confirmed' WHERE id = ?").run(dup);
  insertTransaction(db, { account_id: checking, date: '2026-09-03', amount: -1000, original_name: 'CHASE CARD PAYMENT', category_id: 'cat_xfer_cc' });
  const reading = findCounterparties(db, TODAY);
  assert.deepEqual(reading.people, []);
  assert.equal(reading.unclassified.rows, 0);
});

test('the route and the advisor tool both answer in dollars', async () => {
  const { db, checking } = ledger();
  move(db, checking, '2026-09-15', -4600, 'Zelle payment to Jordan Lee 10000000001');
  const tool = runAdvisorTool(db, 'get_counterparties', {}) as CounterpartiesResponse;
  assert.equal(tool.people[0].net, -46);
  _setDbForTesting(db);
  const app = express();
  app.use('/api/transactions', transactionsRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no server address');
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/transactions/counterparties`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: CounterpartiesResponse };
    assert.equal(body.data.people[0].sent, 46);
    assert.equal(body.data.people[0].net, -46);
    assert.equal(body.data.settle_tolerance, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
});
