import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findFlowConservationViolations } from '../server/src/services/flowConservation';
import { insertAccount, insertTransaction, migratedTestDb } from './helpers/schema';

/**
 * A transfer between two owned accounts is equal and OPPOSITE. Everything here is about the
 * same-signed near-pair the existing transfer pairing cannot see, and about the far larger set of
 * ordinary months that merely resemble one.
 */

test('two unpaired outbound legs of the same amount days apart are one grouped finding', () => {
  const db = migratedTestDb();
  const checking = insertAccount(db, { account_name: 'Chase Checking', type: 'checking' });
  const brokerage = insertAccount(db, { account_name: 'Fidelity Individual', type: 'brokerage' });
  // The real shape: the Fidelity leg posts a day before the Chase leg, both are negative, and
  // neither has a landing anywhere in the ledger. $50 left the household twice and arrived nowhere.
  insertTransaction(db, { account_id: brokerage, date: '2026-05-21', amount: -5000, category_id: 'cat_inv_transfer' });
  insertTransaction(db, { account_id: checking, date: '2026-05-22', amount: -5000, category_id: 'cat_inv_transfer' });
  insertTransaction(db, { account_id: brokerage, date: '2026-06-04', amount: -5000, category_id: 'cat_inv_transfer' });
  insertTransaction(db, { account_id: checking, date: '2026-06-05', amount: -5000, category_id: 'cat_inv_transfer' });

  const findings = findFlowConservationViolations(db);
  assert.equal(findings.length, 1, 'one systematic defect reads as one finding, not four');
  assert.deepEqual(
    [findings[0].account_a_name, findings[0].account_b_name].sort(),
    ['Chase Checking', 'Fidelity Individual']
  );
  assert.equal(findings[0].leg_count, 4);
  // Four legs of $50 are two movements of $50, recorded twice each. Summing every leg would report
  // $200.00 of money at issue where $100.00 moved.
  assert.equal(findings[0].movement_cents, 10000);
  assert.equal(findings[0].first_date, '2026-05-21');
  assert.equal(findings[0].last_date, '2026-06-05');
  db.close();
});

test('a single unpaired outbound coincidence between two accounts is silent', () => {
  const db = migratedTestDb();
  const checking = insertAccount(db, { account_name: 'Chase Checking', type: 'checking' });
  const savings = insertAccount(db, { account_name: 'Wealthfront Cash', type: 'savings' });
  // Two $500 transfers out of the household in one week, to institutions this ledger is not
  // connected to. Neither has a landing here because neither landing exists here. That is an
  // ordinary week: one coincidence between two accounts is a coincidence, and only a repeated
  // pattern between the same two accounts is a systematic sign defect.
  insertTransaction(db, { account_id: checking, date: '2026-07-01', amount: -50000, category_id: 'cat_xfer_out' });
  insertTransaction(db, { account_id: savings, date: '2026-07-04', amount: -50000, category_id: 'cat_xfer_out' });

  assert.deepEqual(findFlowConservationViolations(db), []);
  db.close();
});

test('a payday split into two accounts on one day is silent', () => {
  const db = migratedTestDb();
  const checking = insertAccount(db, { account_name: 'Chase Checking', type: 'checking' });
  const brokerage = insertAccount(db, { account_name: 'Fidelity Individual', type: 'brokerage' });
  const savings = insertAccount(db, { account_name: 'Wealthfront Cash', type: 'savings' });
  // $1,000 to the brokerage and $1,000 to savings, all four legs present. Nothing is missing: the
  // two equal INBOUND legs are two landings, not one movement recorded twice.
  insertTransaction(db, { account_id: checking, date: '2026-07-01', amount: -100000, category_id: 'cat_inv_transfer' });
  insertTransaction(db, { account_id: brokerage, date: '2026-07-01', amount: 100000, category_id: 'cat_inv_transfer' });
  insertTransaction(db, { account_id: checking, date: '2026-07-01', amount: -100000, category_id: 'cat_xfer_out' });
  insertTransaction(db, { account_id: savings, date: '2026-07-01', amount: 100000, category_id: 'cat_xfer_in' });

  assert.deepEqual(findFlowConservationViolations(db), []);
  db.close();
});

test('two card payments of the same size from two funding accounts in one week are silent', () => {
  const db = migratedTestDb();
  const checking = insertAccount(db, { account_name: 'Chase Checking', type: 'checking' });
  const savings = insertAccount(db, { account_name: 'Wealthfront Cash', type: 'savings' });
  const flex = insertAccount(db, { account_name: 'Chase Freedom Flex', type: 'credit', is_liability: 1 });
  const savor = insertAccount(db, { account_name: 'Capital One Savor', type: 'credit', is_liability: 1 });
  // Two outbound transfer legs of $250 on two accounts inside the window, which is the exact shape
  // the check looks for. Each one already has its landing, so neither is evidence of anything.
  insertTransaction(db, { account_id: checking, date: '2026-07-01', amount: -25000, category_id: 'cat_xfer_cc' });
  insertTransaction(db, { account_id: flex, date: '2026-07-01', amount: 25000, category_id: 'cat_xfer_cc' });
  insertTransaction(db, { account_id: savings, date: '2026-07-03', amount: -25000, category_id: 'cat_xfer_cc' });
  insertTransaction(db, { account_id: savor, date: '2026-07-03', amount: 25000, category_id: 'cat_xfer_cc' });

  assert.deepEqual(findFlowConservationViolations(db), []);
  db.close();
});

test('a transfer and its reversal are silent', () => {
  const db = migratedTestDb();
  const checking = insertAccount(db, { account_name: 'Chase Checking', type: 'checking' });
  const savings = insertAccount(db, { account_name: 'Wealthfront Cash', type: 'savings' });
  insertTransaction(db, { account_id: checking, date: '2026-07-01', amount: -50000, category_id: 'cat_xfer_out' });
  insertTransaction(db, { account_id: savings, date: '2026-07-01', amount: 50000, category_id: 'cat_xfer_in' });
  // Sent back the next day. The two outbound legs sit on different accounts one day apart and look
  // exactly like a doubled movement until you notice each already landed.
  insertTransaction(db, { account_id: savings, date: '2026-07-02', amount: -50000, category_id: 'cat_xfer_out' });
  insertTransaction(db, { account_id: checking, date: '2026-07-02', amount: 50000, category_id: 'cat_xfer_in' });

  assert.deepEqual(findFlowConservationViolations(db), []);
  db.close();
});

test('a transfer and an unrelated card charge of the same size are silent', () => {
  const db = migratedTestDb();
  const checking = insertAccount(db, { account_name: 'Chase Checking', type: 'checking' });
  const savings = insertAccount(db, { account_name: 'Wealthfront Cash', type: 'savings' });
  const flex = insertAccount(db, { account_name: 'Chase Freedom Flex', type: 'credit', is_liability: 1 });
  insertTransaction(db, { account_id: checking, date: '2026-07-01', amount: -20000, category_id: 'cat_xfer_out' });
  insertTransaction(db, { account_id: savings, date: '2026-07-01', amount: 20000, category_id: 'cat_xfer_in' });
  insertTransaction(db, { account_id: flex, date: '2026-07-03', amount: -20000, merchant_name: 'Apple' });

  assert.deepEqual(findFlowConservationViolations(db), []);
  db.close();
});

test('an unpaired transfer leg and an equal merchant charge are still not one movement', () => {
  const db = migratedTestDb();
  const checking = insertAccount(db, { account_name: 'Chase Checking', type: 'checking' });
  const flex = insertAccount(db, { account_name: 'Chase Freedom Flex', type: 'credit', is_liability: 1 });
  // The transfer leg has no landing in this ledger and the charge is the same size two days later.
  // Requiring BOTH legs to be transfer-class is what keeps a purchase out of a transfer's business.
  insertTransaction(db, { account_id: checking, date: '2026-07-01', amount: -20000, category_id: 'cat_xfer_out' });
  insertTransaction(db, { account_id: flex, date: '2026-07-03', amount: -20000, merchant_name: 'Apple' });

  assert.deepEqual(findFlowConservationViolations(db), []);
  db.close();
});

test('money arriving in two accounts at once is ordinary income, not a violation', () => {
  const db = migratedTestDb();
  const brokerage = insertAccount(db, { account_name: 'Fidelity Individual', type: 'brokerage' });
  const cash = insertAccount(db, { account_name: 'Wealthfront Cash', type: 'savings' });
  // Both $1,000 deposits on 2026-02-23 in the owner's real ledger. Their funding source predates
  // the feeds, so neither has a counterparty here by construction. Demanding one alarms on every
  // paycheck the app will ever see.
  insertTransaction(db, { account_id: brokerage, date: '2026-02-23', amount: 100000, category_id: 'cat_inv_transfer' });
  insertTransaction(db, { account_id: cash, date: '2026-02-23', amount: 100000, category_id: 'cat_xfer_in' });

  assert.deepEqual(findFlowConservationViolations(db), []);
  db.close();
});

test('a genuine equal-and-opposite transfer is not reported', () => {
  const db = migratedTestDb();
  const checking = insertAccount(db, { account_name: 'Chase Checking', type: 'checking' });
  const savings = insertAccount(db, { account_name: 'Ally Savings', type: 'savings' });
  insertTransaction(db, { account_id: checking, date: '2026-07-01', amount: -50000, category_id: 'cat_xfer_out' });
  insertTransaction(db, { account_id: savings, date: '2026-07-02', amount: 50000, category_id: 'cat_xfer_in' });

  assert.deepEqual(findFlowConservationViolations(db), [], 'conservation holds; this is what a transfer looks like');
  db.close();
});

test('two equal merchant charges on two cards are a coincidence, not a broken transfer', () => {
  const db = migratedTestDb();
  const flex = insertAccount(db, { account_name: 'Chase Freedom Flex', type: 'credit', is_liability: 1 });
  const savor = insertAccount(db, { account_name: 'Capital One Savor', type: 'credit', is_liability: 1 });
  // The real ledger carries Chipotle, Uber Eats and Blue Bottle pairs exactly like this.
  insertTransaction(db, { account_id: flex, date: '2026-07-01', amount: -1450, merchant_name: 'Chipotle' });
  insertTransaction(db, { account_id: savor, date: '2026-07-03', amount: -1450, merchant_name: 'Chipotle' });

  assert.deepEqual(findFlowConservationViolations(db), []);
  db.close();
});

test('legs more than five days apart are not one movement', () => {
  const db = migratedTestDb();
  const checking = insertAccount(db, { account_name: 'Chase Checking', type: 'checking' });
  const brokerage = insertAccount(db, { account_name: 'Fidelity Individual', type: 'brokerage' });
  insertTransaction(db, { account_id: checking, date: '2026-07-01', amount: -5000, category_id: 'cat_inv_transfer' });
  insertTransaction(db, { account_id: brokerage, date: '2026-07-07', amount: -5000, category_id: 'cat_inv_transfer' });

  assert.deepEqual(findFlowConservationViolations(db), []);
  db.close();
});

test('two same-signed rows on ONE account are not a pair', () => {
  const db = migratedTestDb();
  const checking = insertAccount(db, { account_name: 'Chase Checking', type: 'checking' });
  insertTransaction(db, { account_id: checking, date: '2026-07-01', amount: -5000, category_id: 'cat_inv_transfer' });
  insertTransaction(db, { account_id: checking, date: '2026-07-02', amount: -5000, category_id: 'cat_inv_transfer' });

  assert.deepEqual(findFlowConservationViolations(db), []);
  db.close();
});

test('pending legs and hidden accounts are out of scope', () => {
  const db = migratedTestDb();
  const checking = insertAccount(db, { account_name: 'Chase Checking', type: 'checking' });
  const brokerage = insertAccount(db, { account_name: 'Fidelity Individual', type: 'brokerage' });
  const hidden = insertAccount(db, { account_name: 'Old Card', type: 'credit', is_hidden: 1 });
  insertTransaction(db, { account_id: checking, date: '2026-07-01', amount: -5000, category_id: 'cat_inv_transfer', pending: 1 });
  insertTransaction(db, { account_id: brokerage, date: '2026-07-02', amount: -5000, category_id: 'cat_inv_transfer' });
  insertTransaction(db, { account_id: hidden, date: '2026-07-02', amount: -5000, category_id: 'cat_inv_transfer' });

  assert.deepEqual(findFlowConservationViolations(db), []);
  db.close();
});

test('a landing on a hidden account still counts as a landing', () => {
  const db = migratedTestDb();
  const checking = insertAccount(db, { account_name: 'Chase Checking', type: 'checking' });
  const brokerage = insertAccount(db, { account_name: 'Fidelity Individual', type: 'brokerage' });
  const hidden = insertAccount(db, { account_name: 'Old Savings', type: 'savings', is_hidden: 1 });
  insertTransaction(db, { account_id: checking, date: '2026-07-01', amount: -5000, category_id: 'cat_xfer_out' });
  insertTransaction(db, { account_id: hidden, date: '2026-07-01', amount: 5000, category_id: 'cat_xfer_in' });
  // Unpaired, but the other leg is not, so there is no doubled movement to report.
  insertTransaction(db, { account_id: brokerage, date: '2026-07-02', amount: -5000, category_id: 'cat_inv_transfer' });

  assert.deepEqual(findFlowConservationViolations(db), []);
  db.close();
});

test('a same-signed pair under the floor is noise, not a finding', () => {
  const db = migratedTestDb();
  const checking = insertAccount(db, { account_name: 'Chase Checking', type: 'checking' });
  const brokerage = insertAccount(db, { account_name: 'Fidelity Individual', type: 'brokerage' });
  insertTransaction(db, { account_id: checking, date: '2026-07-01', amount: -999, category_id: 'cat_inv_transfer' });
  insertTransaction(db, { account_id: brokerage, date: '2026-07-02', amount: -999, category_id: 'cat_inv_transfer' });

  assert.deepEqual(findFlowConservationViolations(db), []);
  db.close();
});
