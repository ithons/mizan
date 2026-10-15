import test from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import {
  businessDaysBetween,
  confirmTransferPair,
  getTransferCandidatePairs,
  refreshTransferCandidates,
} from '../server/src/services/transactionIntegrity';
import { insertAccount, insertTransaction, migratedTestDb } from './helpers/schema';

interface Leg {
  id: string;
  transfer_pair_id: string | null;
  transfer_status: string;
  transfer_source: string | null;
  category_id: string | null;
}

function leg(db: Database.Database, id: string): Leg {
  return db.prepare(
    'SELECT id, transfer_pair_id, transfer_status, transfer_source, category_id FROM transactions WHERE id = ?'
  ).get(id) as Leg;
}

function partnerOf(db: Database.Database, id: string): string | null {
  const row = db.prepare(`
    SELECT other.id FROM transactions t
    JOIN transactions other ON other.transfer_pair_id = t.transfer_pair_id AND other.id <> t.id
    WHERE t.id = ?
  `).get(id) as { id: string } | undefined;
  return row?.id ?? null;
}

test('the window is five business days, so a weekend does not use up the week', () => {
  assert.equal(businessDaysBetween('2026-10-09', '2026-10-12'), 1, 'Friday to Monday');
  assert.equal(businessDaysBetween('2026-10-09', '2026-10-16'), 5);
  assert.equal(businessDaysBetween('2026-10-16', '2026-10-09'), 5, 'order does not matter');
  assert.equal(businessDaysBetween('2026-10-09', '2026-10-19'), 6);
  assert.equal(businessDaysBetween('2026-10-05', '2026-10-05'), 0);
});

test('a card payment pairs and settles without waiting in possible transfers', () => {
  const db = migratedTestDb();
  const checking = insertAccount(db, { account_name: 'Chase Checking', type: 'checking' });
  const discover = insertAccount(db, { account_name: 'Discover', type: 'credit', is_liability: 1 });
  const out = insertTransaction(db, { account_id: checking, date: '2026-10-14', amount: -33143, original_name: 'DISCOVER E-PAYMENT 4630 WEB ID: XXXXXX0270' });
  const into = insertTransaction(db, { account_id: discover, date: '2026-10-12', amount: 33143, original_name: 'DIRECTPAY FULL BALANCE' });

  const result = refreshTransferCandidates(db);

  assert.deepEqual([result.pairCount, result.autoPairCount], [0, 1]);
  assert.equal(partnerOf(db, out), into);
  for (const id of [out, into]) {
    assert.deepEqual(
      [leg(db, id).transfer_status, leg(db, id).transfer_source, leg(db, id).category_id],
      ['confirmed', 'auto', 'cat_xfer_cc']
    );
  }
  assert.equal(getTransferCandidatePairs(db).length, 0);
});

test('each weekly $100 to Fidelity pairs with its own arrival, never the next week\'s', () => {
  const db = migratedTestDb();
  const chase = insertAccount(db, { account_name: 'Chase Checking', type: 'checking' });
  const fid = insertAccount(db, { account_name: 'Fidelity Individual', type: 'brokerage' });
  const weeks = ['2026-09-21', '2026-09-28', '2026-10-05'];
  const pairs = weeks.map((date) => {
    const out = insertTransaction(db, { account_id: chase, date, amount: -10000, original_name: 'FID BKG SVC LLC MONEYLINE PPD ID: XXXXXX4600', category_id: 'cat_inv_transfer', category_source: 'rule' });
    const into = insertTransaction(db, { account_id: fid, date, amount: 10000, original_name: 'Electronic Funds Transfer Received (Cash)' });
    const sweep = insertTransaction(db, { account_id: fid, date, amount: 10000, original_name: 'REDEMPTION FROM CORE ACCOUNT FIDELITY GOVERNMENT MONEY MARKET (SPAXX) MORNING TRADE (Cash)' });
    db.prepare('UPDATE transactions SET is_internal_trade = 1 WHERE id = ?').run(sweep);
    return { out, into, sweep };
  });

  refreshTransferCandidates(db);

  for (const { out, into, sweep } of pairs) {
    assert.equal(partnerOf(db, out), into);
    assert.equal(leg(db, out).transfer_source, 'auto');
    assert.equal(leg(db, sweep).transfer_pair_id, null, 'a core sweep is a trade, never a transfer leg');
    assert.equal(leg(db, out).category_id, 'cat_inv_transfer', 'a transfer category already on the leg is kept');
  }
});

test('two equally near counterparts are left alone rather than guessed between', () => {
  const db = migratedTestDb();
  const checking = insertAccount(db, { type: 'checking' });
  const savings = insertAccount(db, { type: 'savings' });
  const other = insertAccount(db, { type: 'savings' });
  const out = insertTransaction(db, { account_id: checking, date: '2026-10-05', amount: -25000, original_name: 'ONLINE TRANSFER TO SAV' });
  insertTransaction(db, { account_id: savings, date: '2026-10-06', amount: 25000, original_name: 'ONLINE TRANSFER FROM CHK' });
  insertTransaction(db, { account_id: other, date: '2026-10-06', amount: 25000, original_name: 'ONLINE TRANSFER FROM CHK' });

  refreshTransferCandidates(db);
  assert.equal(leg(db, out).transfer_pair_id, null);
});

test('one named leg waits for the owner until the owner has confirmed that account pair before', () => {
  const db = migratedTestDb();
  const chase = insertAccount(db, { account_name: 'Chase Checking', type: 'checking' });
  const wealthfront = insertAccount(db, { account_name: 'Wealthfront Cash', type: 'savings' });
  const first = insertTransaction(db, { account_id: chase, date: '2026-07-31', amount: -100000, original_name: 'Wealthfront EDI PYMNTS 1C2D WEB ID: XXXXXX7207' });
  insertTransaction(db, { account_id: wealthfront, date: '2026-07-31', amount: 100000, original_name: 'Chase (Account ****6391)' });

  const before = refreshTransferCandidates(db);
  assert.deepEqual([before.pairCount, before.autoPairCount], [1, 0]);
  confirmTransferPair(db, leg(db, first).transfer_pair_id as string);
  assert.equal(leg(db, first).transfer_source, 'owner');

  const later = insertTransaction(db, { account_id: chase, date: '2026-09-30', amount: -500000, original_name: 'Wealthfront EDI PYMNTS 44C0E2DF6EDC42 WEB ID: XXXXXX7207' });
  insertTransaction(db, { account_id: wealthfront, date: '2026-09-30', amount: 500000, original_name: 'Chase (Account ****6391)' });

  const after = refreshTransferCandidates(db);
  assert.deepEqual([after.pairCount, after.autoPairCount], [0, 1]);
  assert.equal(leg(db, later).transfer_source, 'auto');
  assert.equal(leg(db, first).transfer_source, 'owner', 'the owner\'s confirmation is not re-derived');
});

test('an automatic pair is re-derived when the provider amends a leg, and gives its category back', () => {
  const db = migratedTestDb();
  const checking = insertAccount(db, { type: 'checking' });
  const card = insertAccount(db, { type: 'credit', is_liability: 1 });
  const out = insertTransaction(db, { account_id: checking, date: '2026-09-11', amount: -481314, original_name: 'CHASE CREDIT CRD AUTOPAY PPD ID: XXXXXX9224' });
  const into = insertTransaction(db, { account_id: card, date: '2026-09-10', amount: 481314, original_name: 'AUTOMATIC PAYMENT - THANK' });
  refreshTransferCandidates(db);
  assert.equal(partnerOf(db, out), into);

  db.prepare('UPDATE transactions SET amount = 481300 WHERE id = ?').run(into);
  const result = refreshTransferCandidates(db);

  assert.equal(result.autoPairCount, 0);
  for (const id of [out, into]) {
    assert.deepEqual(
      [leg(db, id).transfer_pair_id, leg(db, id).transfer_status, leg(db, id).category_id],
      [null, 'none', null]
    );
  }
});

test('an unchanged ledger writes nothing on the next pass', () => {
  const db = migratedTestDb();
  const checking = insertAccount(db, { type: 'checking' });
  const card = insertAccount(db, { type: 'credit', is_liability: 1 });
  insertTransaction(db, { account_id: checking, date: '2026-09-08', amount: -8843, original_name: 'CAPITAL ONE CRCARDPMT CA0C8752C713DC5 WEB ID' });
  insertTransaction(db, { account_id: card, date: '2026-09-07', amount: 8843, original_name: 'CAPITAL ONE AUTOPAY PYMT' });
  refreshTransferCandidates(db);
  const snapshot = db.prepare('SELECT * FROM transactions ORDER BY id').all();
  const revisions = db.prepare('SELECT COUNT(*) AS n FROM transaction_category_revisions').get();

  const second = refreshTransferCandidates(db);

  assert.equal(second.newAutoPairCount, 0);
  assert.deepEqual(db.prepare('SELECT * FROM transactions ORDER BY id').all(), snapshot);
  assert.deepEqual(db.prepare('SELECT COUNT(*) AS n FROM transaction_category_revisions').get(), revisions);
});
