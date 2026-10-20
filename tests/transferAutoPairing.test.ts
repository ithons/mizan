import test from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import {
  businessDaysBetween,
  confirmTransferPair,
  dismissTransferPair,
  getTransferCandidatePairs,
  refreshTransferCandidates,
} from '../server/src/services/transactionIntegrity';
import { insertAccount, insertTransaction, migratedTestDb } from './helpers/schema';
import { writeTransactionCategory } from '../server/src/services/categoryWrites';

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

test('a fresh card refund equal to a checking debit is not a card payment', () => {
  const db = migratedTestDb();
  const checking = insertAccount(db, { account_name: 'Chase Checking', type: 'checking' });
  const sapphire = insertAccount(db, { account_name: 'Chase Sapphire', type: 'credit', is_liability: 1 });
  const debit = insertTransaction(db, { account_id: checking, date: '2026-09-29', amount: -249581, original_name: 'REMOTE ONLINE DEPOSIT RETURN' });
  const refund = insertTransaction(db, { account_id: sapphire, date: '2026-10-01', amount: 249581, original_name: 'APPLE STORE  #R149' });
  refreshTransferCandidates(db);
  for (const id of [debit, refund]) assert.equal(leg(db, id).transfer_status === 'confirmed', false);
});

/** An owner edit made after the pairing, as it always is in the app. */
const later = () => new Date(Date.now() + 60_000).toISOString();

test('the owner re-filing a leg of an automatic pair keeps their category and settles the pair', () => {
  const db = migratedTestDb();
  const checking = insertAccount(db, { type: 'checking' });
  const card = insertAccount(db, { type: 'credit', is_liability: 1 });
  const out = insertTransaction(db, { account_id: checking, date: '2026-09-11', amount: -30000, original_name: 'CHASE CREDIT CRD AUTOPAY PPD ID: XXXXXX9224' });
  const into = insertTransaction(db, { account_id: card, date: '2026-09-10', amount: 30000, original_name: 'AUTOMATIC PAYMENT - THANK YOU' });
  refreshTransferCandidates(db);

  writeTransactionCategory(db, { transactionId: out, categoryId: 'cat_xfer_out', source: 'human', markManual: true }, later());
  refreshTransferCandidates(db);
  assert.deepEqual([leg(db, out).category_id, leg(db, out).transfer_source], ['cat_xfer_out', 'owner']);
  assert.equal(leg(db, into).transfer_source, 'owner', 'both legs of a settled pair stay paired');

  const other = insertTransaction(db, { account_id: checking, date: '2026-10-11', amount: -20000, original_name: 'CHASE CREDIT CRD AUTOPAY PPD ID: XXXXXX9224' });
  const otherIn = insertTransaction(db, { account_id: card, date: '2026-10-10', amount: 20000, original_name: 'AUTOMATIC PAYMENT - THANK YOU' });
  refreshTransferCandidates(db);
  writeTransactionCategory(db, { transactionId: other, categoryId: 'cat_shop', source: 'human', markManual: true }, later());
  refreshTransferCandidates(db);
  assert.deepEqual([leg(db, other).category_id, leg(db, other).transfer_status], ['cat_shop', 'dismissed']);
  assert.deepEqual([leg(db, otherIn).category_id, leg(db, otherIn).transfer_status], [null, 'none']);
});

test('undoing a pair leaves a category the importer or the model chose', () => {
  const db = migratedTestDb();
  const checking = insertAccount(db, { type: 'checking' });
  const coinbase = insertAccount(db, { type: 'crypto_wallet' });
  const out = insertTransaction(db, { account_id: checking, date: '2026-09-02', amount: -10000, original_name: 'COINBASE.COM TRANSFER' });
  const deposit = insertTransaction(db, { account_id: coinbase, date: '2026-09-02', amount: 10000, original_name: 'Coinbase deposit', category_id: 'cat_xfer_in' });
  refreshTransferCandidates(db);
  dismissTransferPair(db, leg(db, deposit).transfer_pair_id as string);
  assert.equal(leg(db, deposit).category_id, 'cat_xfer_in');
  assert.ok(out);
});

test('re-filing the wrong card leg frees the payment to pair with the card it really paid', () => {
  const db = migratedTestDb();
  const checking = insertAccount(db, { type: 'checking' });
  const card1 = insertAccount(db, { type: 'credit', is_liability: 1 });
  const card2 = insertAccount(db, { type: 'credit', is_liability: 1 });
  const out = insertTransaction(db, { account_id: checking, date: '2026-09-11', amount: -30000, original_name: 'CHASE CREDIT CRD AUTOPAY PPD ID: XXXXXX9224' });
  const wrong = insertTransaction(db, { account_id: card1, date: '2026-09-11', amount: 30000, original_name: 'AUTOMATIC PAYMENT - THANK YOU' });
  const right = insertTransaction(db, { account_id: card2, date: '2026-09-14', amount: 30000, original_name: 'AUTOMATIC PAYMENT - THANK YOU' });
  refreshTransferCandidates(db);
  assert.equal(leg(db, out).transfer_pair_id, leg(db, wrong).transfer_pair_id);

  writeTransactionCategory(db, { transactionId: wrong, categoryId: 'cat_shop', source: 'human', markManual: true }, later());
  refreshTransferCandidates(db);
  assert.ok(leg(db, out).transfer_pair_id);
  assert.equal(leg(db, out).transfer_pair_id, leg(db, right).transfer_pair_id);
});

test('two card payments of one amount on one day are both left alone, not paired by row order', () => {
  const db = migratedTestDb();
  const checking = insertAccount(db, { type: 'checking', account_name: 'Checking' });
  const chase = insertAccount(db, { type: 'credit', is_liability: 1, account_name: 'Chase' });
  const discover = insertAccount(db, { type: 'credit', is_liability: 1, account_name: 'Discover' });
  const legs = [
    insertTransaction(db, { id: 'o1', account_id: checking, date: '2026-10-05', amount: -50000, original_name: 'DISCOVER E-PAYMENT' }),
    insertTransaction(db, { id: 'o2', account_id: checking, date: '2026-10-05', amount: -50000, original_name: 'CHASE CREDIT CRD AUTOPAY' }),
    insertTransaction(db, { id: 'ia', account_id: chase, date: '2026-10-06', amount: 50000, original_name: 'AUTOMATIC PAYMENT - THANK' }),
    insertTransaction(db, { id: 'ib', account_id: discover, date: '2026-10-06', amount: 50000, original_name: 'INTERNET PAYMENT - THANK YOU' }),
  ];
  refreshTransferCandidates(db);
  for (const id of legs) assert.equal(leg(db, id).transfer_pair_id, null, id);
});

test('two identical moves between the same two accounts on one day both pair', () => {
  const db = migratedTestDb();
  const checking = insertAccount(db, { type: 'checking', account_name: 'Checking' });
  const savings = insertAccount(db, { type: 'savings', account_name: 'Savings' });
  for (const id of ['o1', 'o2']) insertTransaction(db, { id, account_id: checking, date: '2026-10-05', amount: -20000, original_name: 'ONLINE TRANSFER TO SAVINGS' });
  for (const id of ['i1', 'i2']) insertTransaction(db, { id, account_id: savings, date: '2026-10-05', amount: 20000, original_name: 'ONLINE TRANSFER FROM CHECKING' });
  refreshTransferCandidates(db);
  for (const id of ['o1', 'o2', 'i1', 'i2']) assert.notEqual(leg(db, id).transfer_pair_id, null, id);
  assert.notEqual(partnerOf(db, 'o1'), partnerOf(db, 'o2'));
});

test('a tie is not settled by taking the one leg a third transfer could reach', () => {
  for (const [early, late] of [['i2', 'i1'], ['i1', 'i2']]) {
    const db = migratedTestDb();
    const checking = insertAccount(db, { type: 'checking', account_name: 'Checking' });
    const joint = insertAccount(db, { type: 'checking', account_name: 'Joint' });
    const savings = insertAccount(db, { type: 'savings', account_name: 'Savings' });
    insertTransaction(db, { id: 'o1', account_id: checking, date: '2026-10-06', amount: -20000, original_name: 'ONLINE TRANSFER TO SAVINGS' });
    insertTransaction(db, { id: 'oJ', account_id: joint, date: '2026-10-13', amount: -20000, original_name: 'ONLINE TRANSFER TO SAVINGS' });
    insertTransaction(db, { id: early, account_id: savings, date: '2026-10-05', amount: 20000, original_name: 'ONLINE TRANSFER FROM CHECKING' });
    insertTransaction(db, { id: late, account_id: savings, date: '2026-10-07', amount: 20000, original_name: 'ONLINE TRANSFER FROM CHECKING' });
    refreshTransferCandidates(db);
    assert.equal(partnerOf(db, 'o1'), early, `ids ${early}/${late}`);
    assert.equal(partnerOf(db, 'oJ'), late, `ids ${early}/${late}`);
  }
});

test('a same-day exact pair is not broken up to stretch two farther matches', () => {
  const db = migratedTestDb();
  const checking = insertAccount(db, { type: 'checking', account_name: 'Checking' });
  const savings = insertAccount(db, { type: 'savings', account_name: 'Savings' });
  insertTransaction(db, { id: 'o1', account_id: checking, date: '2026-10-05', amount: -20000, original_name: 'ONLINE TRANSFER TO SAVINGS' });
  insertTransaction(db, { id: 'i1', account_id: savings, date: '2026-10-05', amount: 20000, original_name: 'ONLINE TRANSFER FROM CHECKING' });
  insertTransaction(db, { id: 'o2', account_id: checking, date: '2026-09-28', amount: -20000, original_name: 'ONLINE TRANSFER TO SAVINGS' });
  insertTransaction(db, { id: 'i2', account_id: savings, date: '2026-10-12', amount: 20000, original_name: 'ONLINE TRANSFER FROM CHECKING' });
  refreshTransferCandidates(db);
  assert.equal(partnerOf(db, 'o1'), 'i1');
});

test('two identical moves on one day still pair inside a long weekly history', () => {
  const db = migratedTestDb();
  const checking = insertAccount(db, { type: 'checking', account_name: 'Checking' });
  const savings = insertAccount(db, { type: 'savings', account_name: 'Savings' });
  const mondays = ['2026-08-03', '2026-08-10', '2026-08-17', '2026-08-24', '2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21'];
  mondays.forEach((date, week) => {
    insertTransaction(db, { id: `o${week}`, account_id: checking, date, amount: -20000, original_name: 'ONLINE TRANSFER TO SAVINGS' });
    insertTransaction(db, { id: `i${week}`, account_id: savings, date, amount: 20000, original_name: 'ONLINE TRANSFER FROM CHECKING' });
  });
  insertTransaction(db, { id: 'oX', account_id: checking, date: '2026-09-07', amount: -20000, original_name: 'ONLINE TRANSFER TO SAVINGS' });
  insertTransaction(db, { id: 'iX', account_id: savings, date: '2026-09-07', amount: 20000, original_name: 'ONLINE TRANSFER FROM CHECKING' });
  refreshTransferCandidates(db);
  for (const id of [...mondays.flatMap((_, week) => [`o${week}`, `i${week}`]), 'oX', 'iX']) {
    assert.notEqual(leg(db, id).transfer_pair_id, null, id);
  }
});

test('any number of identical moves on one day are paired, and past the searched size only offered for review', () => {
  for (const count of [4, 5]) {
    const db = migratedTestDb();
    const checking = insertAccount(db, { type: 'checking', account_name: 'Checking' });
    const savings = insertAccount(db, { type: 'savings', account_name: 'Savings' });
    const ids = Array.from({ length: count }, (_, n) => n);
    for (const n of ids) {
      insertTransaction(db, { id: `o${n}`, account_id: checking, date: '2026-10-05', amount: -20000, original_name: 'ONLINE TRANSFER TO SAVINGS' });
      insertTransaction(db, { id: `i${n}`, account_id: savings, date: '2026-10-05', amount: 20000, original_name: 'ONLINE TRANSFER FROM CHECKING' });
    }
    refreshTransferCandidates(db);
    for (const n of ids) assert.notEqual(leg(db, `o${n}`).transfer_pair_id, null, `${count}: o${n}`);
    for (const n of ids) assert.equal(leg(db, `o${n}`).transfer_status, 'candidate', `${count}: o${n}`);
  }
});

test('a group too large to search never auto-confirms the pairs it guesses', () => {
  const db = migratedTestDb();
  const a = insertAccount(db, { type: 'checking', account_name: 'A' });
  const b = insertAccount(db, { type: 'checking', account_name: 'B' });
  const c = insertAccount(db, { type: 'savings', account_name: 'C' });
  const rows: Array<[string, string, string, number]> = [
    ['r0', b, '2026-10-08', 1], ['r1', a, '2026-10-06', 1], ['r2', b, '2026-10-07', -1], ['r3', b, '2026-10-06', -1],
    ['r4', c, '2026-10-05', -1], ['r5', a, '2026-10-09', 1], ['r6', b, '2026-10-05', -1], ['r7', b, '2026-10-07', 1],
    ['r8', a, '2026-10-08', 1], ['r9', c, '2026-10-06', -1],
  ];
  for (const [id, account, date, sign] of rows) {
    insertTransaction(db, { id, account_id: account, date, amount: sign * 20000, original_name: sign < 0 ? 'ONLINE TRANSFER TO ACCOUNT' : 'ONLINE TRANSFER FROM ACCOUNT' });
  }
  refreshTransferCandidates(db);
  const confirmed = db.prepare("SELECT id FROM transactions WHERE transfer_status = 'confirmed' ORDER BY id").all();
  assert.deepEqual(confirmed, []);
});

test('identical moves split across two destination accounts still pair past the searched size', () => {
  const db = migratedTestDb();
  const checking = insertAccount(db, { type: 'checking', account_name: 'Checking' });
  const savings = insertAccount(db, { type: 'savings', account_name: 'Savings' });
  const joint = insertAccount(db, { type: 'checking', account_name: 'Joint' });
  for (let n = 0; n < 4; n++) insertTransaction(db, { id: `o${n}`, account_id: checking, date: '2026-10-05', amount: -20000, original_name: 'ONLINE TRANSFER' });
  for (let n = 0; n < 3; n++) insertTransaction(db, { id: `i${n}`, account_id: savings, date: '2026-10-05', amount: 20000, original_name: 'ONLINE TRANSFER' });
  insertTransaction(db, { id: 'iJ', account_id: joint, date: '2026-10-05', amount: 20000, original_name: 'ONLINE TRANSFER' });
  refreshTransferCandidates(db);
  for (const id of ['o0', 'o1', 'o2', 'o3', 'i0', 'i1', 'i2', 'iJ']) assert.notEqual(leg(db, id).transfer_pair_id, null, id);
});

function sharedConfirmationLedger(withReference: boolean) {
  const db = migratedTestDb();
  const savings = insertAccount(db, { account_name: 'Savings', type: 'savings' });
  const checking = insertAccount(db, { account_name: 'Checking', type: 'checking' });
  const brokerage = insertAccount(db, { account_name: 'Brokerage', type: 'brokerage' });
  const conf = withReference ? ' Confirmation# 1234509876' : '';
  const out = insertTransaction(db, { account_id: savings, date: '2026-02-04', amount: -90000, original_name: `Online Banking transfer to CHK 1111${conf}` });
  const into = insertTransaction(db, { account_id: checking, date: '2026-02-04', amount: 90000, original_name: `Online Banking transfer from SAV 2222${conf}` });
  const brokerIn = insertTransaction(db, { account_id: brokerage, date: '2026-02-02', amount: 90000, original_name: 'Fidelity contribution' });
  const brokerOut = insertTransaction(db, { account_id: brokerage, date: '2026-02-04', amount: -90000, original_name: 'Fidelity contribution' });
  refreshTransferCandidates(db);
  return { db, out, into, brokerIn, brokerOut };
}

test('two legs quoting the same confirmation number pair with each other, not with nearer-looking legs elsewhere', () => {
  const { db, out, into, brokerIn, brokerOut } = sharedConfirmationLedger(true);
  assert.equal(partnerOf(db, out), into);
  assert.equal(partnerOf(db, brokerIn), null);
  assert.equal(partnerOf(db, brokerOut), null);
});

test('HEALTHY: without a confirmation number the same ledger is matched exactly as before', () => {
  const { db, out, into, brokerIn, brokerOut } = sharedConfirmationLedger(false);
  assert.equal(partnerOf(db, out), brokerIn);
  assert.equal(partnerOf(db, brokerOut), into);
});
