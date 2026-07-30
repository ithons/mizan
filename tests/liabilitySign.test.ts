import { test } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { correctLiabilitySigns } from '../server/src/services/liabilitySign';
import { liabilityAdjustedCents } from '../server/src/services/simplefin';
import { insertAccount, insertTransaction, migratedTestDb } from './helpers/schema';

const NOW = '2026-07-30T12:00:00.000Z';

function snapshot(
  db: Database.Database,
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

function balanceOf(db: Database.Database, id: string): number {
  return (db.prepare('SELECT current_balance FROM accounts WHERE id = ?').get(id) as {
    current_balance: number;
  }).current_balance;
}

test('a card whose ledger says credit and whose provider says debt is corrected', () => {
  const db = migratedTestDb();
  // BofA Cash Rewards' exact shape: nothing owed at the anchor, one statement credit, and the
  // provider reporting that credit back as the amount owed.
  const card = insertAccount(db, {
    account_name: 'BofA Cash Rewards',
    type: 'credit',
    current_balance: 582,
    is_liability: 1,
  });
  snapshot(db, 's1', '2026-07-23', { [card]: 0 });
  insertTransaction(db, { account_id: card, date: '2026-07-24', amount: 582 });

  const report = correctLiabilitySigns(db, NOW);
  assert.equal(report.corrections.length, 1);
  assert.equal(report.corrections[0].stored_balance, 582);
  assert.equal(report.corrections[0].corrected_balance, -582);
  assert.equal(report.corrections[0].anchor_date, '2026-07-23');
  assert.equal(balanceOf(db, card), -582);
  db.close();
});

test('a card whose ledger agrees with the provider is left alone', () => {
  const db = migratedTestDb();
  // Capital One Savor's exact shape: a reward credit and a larger purchase net to $8.88 owed,
  // which is what the provider reports. Nothing to settle.
  const card = insertAccount(db, {
    account_name: 'Capital One Savor',
    type: 'credit',
    current_balance: 888,
    is_liability: 1,
  });
  snapshot(db, 's1', '2026-07-23', { [card]: 0 });
  insertTransaction(db, { account_id: card, date: '2026-07-24', amount: 1073 });
  insertTransaction(db, { account_id: card, date: '2026-07-25', amount: -1961 });

  const report = correctLiabilitySigns(db, NOW);
  assert.deepEqual(report.corrections, []);
  assert.equal(balanceOf(db, card), 888);
  db.close();
});

test('a magnitude that does not match to the cent is not adopted, and is not passed over in silence', () => {
  const db = migratedTestDb();
  const card = insertAccount(db, {
    account_name: 'BofA Cash Rewards',
    type: 'credit',
    current_balance: 582,
    is_liability: 1,
  });
  snapshot(db, 's1', '2026-07-23', { [card]: 0 });
  // Off by one cent. Exactness is the whole safety property: an incomplete feed lands on a
  // different magnitude, and a near miss is exactly what an incomplete feed looks like.
  insertTransaction(db, { account_id: card, date: '2026-07-24', amount: 583 });

  const report = correctLiabilitySigns(db, NOW);
  assert.deepEqual(report.corrections, []);
  assert.equal(balanceOf(db, card), 582);
  // The ledger says credit and the provider says debt. Adopting the figure is unsafe, but staying
  // quiet would report the direction as settled in exactly the case where it is most in doubt.
  assert.equal(report.unverifiable.length, 1);
  assert.equal(report.unverifiable[0].account_id, card);
  assert.match(report.unverifiable[0].reason, /\$5\.82 owed/);
  assert.match(report.unverifiable[0].reason, /credit balance of \$5\.83/);
  assert.match(report.unverifiable[0].reason, /2026-07-23/);
  db.close();
});

test('the doubt is anchored to the newest measured snapshot, not the oldest', () => {
  const db = migratedTestDb();
  const card = insertAccount(db, { type: 'credit', current_balance: 582, is_liability: 1 });
  snapshot(db, 's1', '2026-07-20', { [card]: 100 });
  snapshot(db, 's2', '2026-07-23', { [card]: 0 });
  insertTransaction(db, { account_id: card, date: '2026-07-24', amount: 583 });

  const report = correctLiabilitySigns(db, NOW);
  assert.equal(report.unverifiable.length, 1);
  assert.match(report.unverifiable[0].reason, /since 2026-07-23/, 'the shortest chain is trusted least far');
  db.close();
});

test('a liability the ledger agrees with raises no doubt at all', () => {
  const db = migratedTestDb();
  const card = insertAccount(db, { type: 'credit', current_balance: 888, is_liability: 1 });
  snapshot(db, 's1', '2026-07-23', { [card]: 0 });
  insertTransaction(db, { account_id: card, date: '2026-07-24', amount: -888 });

  const report = correctLiabilitySigns(db, NOW);
  assert.deepEqual(report.corrections, []);
  assert.deepEqual(report.unverifiable, []);
  db.close();
});

test('a card connected this sync carries whatever it carries and is not a doubt', () => {
  const db = migratedTestDb();
  const checking = insertAccount(db, { type: 'checking' });
  // This runs BEFORE takeSnapshot, so on the sync a card is added no measured snapshot has reached
  // it yet. Ordinary debt on a new card is not something the ledger failed to verify; it is
  // something the ledger has not got to. The first snapshot settles it.
  const card = insertAccount(db, {
    account_name: 'Discover',
    type: 'credit',
    current_balance: 56326,
    is_liability: 1,
  });
  snapshot(db, 's1', '2026-07-29', { [checking]: 100000 });
  insertTransaction(db, { account_id: card, date: '2026-07-29', amount: -12000 });

  const report = correctLiabilitySigns(db, NOW);
  assert.deepEqual(report.corrections, []);
  assert.deepEqual(report.unverifiable, []);
  assert.equal(balanceOf(db, card), 56326);
  db.close();
});

test('an estimated snapshot is not an anchor, and its absence raises nothing', () => {
  const db = migratedTestDb();
  const card = insertAccount(db, { type: 'credit', current_balance: 582, is_liability: 1 });
  // An estimate is reverse-replayed off today's balance, so chaining from one would compare the
  // ledger to a number derived from the ledger. This one would otherwise produce a correction.
  snapshot(db, 'e1', '2026-07-23', { [card]: 0 }, true);
  insertTransaction(db, { account_id: card, date: '2026-07-24', amount: 582 });

  const report = correctLiabilitySigns(db, NOW);
  assert.deepEqual(report.corrections, []);
  assert.deepEqual(report.unverifiable, []);
  assert.equal(balanceOf(db, card), 582);
  db.close();
});

test('a card that has sat in credit for its whole snapshot history is silent', () => {
  const db = migratedTestDb();
  // The steady state this feature creates: once a card is corrected into credit, every later
  // snapshot records a negative for it. Refusing a negative anchor left such a card unanchored, and
  // therefore alarming, forever.
  const card = insertAccount(db, {
    account_name: 'BofA Cash Rewards',
    type: 'credit',
    current_balance: -582,
    is_liability: 1,
  });
  snapshot(db, 's1', '2026-07-25', { [card]: -582 });
  snapshot(db, 's2', '2026-07-28', { [card]: -582 });

  const report = correctLiabilitySigns(db, NOW);
  assert.deepEqual(report.corrections, []);
  assert.deepEqual(report.unverifiable, []);
  assert.equal(balanceOf(db, card), -582);
  db.close();
});

test('a credit anchor still settles direction when the provider flips the sign again', () => {
  const db = migratedTestDb();
  // Same card, next sync: SimpleFIN sends the credit back as debt. The only anchors this account
  // has are negative, so a rule that refused them could not correct this at all.
  const card = insertAccount(db, {
    account_name: 'BofA Cash Rewards',
    type: 'credit',
    current_balance: 582,
    is_liability: 1,
  });
  snapshot(db, 's1', '2026-07-25', { [card]: -582 });

  const report = correctLiabilitySigns(db, NOW);
  assert.equal(report.corrections.length, 1);
  assert.equal(report.corrections[0].anchor_value, -582);
  assert.equal(report.corrections[0].corrected_balance, -582);
  assert.deepEqual(report.unverifiable, []);
  assert.equal(balanceOf(db, card), -582);
  db.close();
});

test('a pending charge against a credit balance is the feed working, not a doubt', () => {
  const db = migratedTestDb();
  // $5.82 in credit, then a $20 charge the provider has authorized and not yet posted. Its balance
  // counts that charge and the chain does not, so the two disagree by exactly $20.00. Nothing here
  // needs the owner's attention.
  const card = insertAccount(db, { type: 'credit', current_balance: 1418, is_liability: 1 });
  snapshot(db, 's1', '2026-07-23', { [card]: -582 });
  insertTransaction(db, { account_id: card, date: '2026-07-28', amount: -2000, pending: 1 });

  const report = correctLiabilitySigns(db, NOW);
  assert.deepEqual(report.corrections, []);
  assert.deepEqual(report.unverifiable, []);
  assert.equal(balanceOf(db, card), 1418);
  db.close();
});

test('with nothing pending, the same disagreement is still reported', () => {
  const db = migratedTestDb();
  const card = insertAccount(db, { type: 'credit', current_balance: 1418, is_liability: 1 });
  snapshot(db, 's1', '2026-07-23', { [card]: -582 });

  const report = correctLiabilitySigns(db, NOW);
  assert.equal(report.unverifiable.length, 1);
  assert.match(report.unverifiable[0].reason, /anchored at a \$5\.82 credit/);
  assert.match(report.unverifiable[0].reason, /Provider reports \$14\.18 owed/);
  db.close();
});

test('pending rows do not enter the chain', () => {
  const db = migratedTestDb();
  const card = insertAccount(db, { type: 'credit', current_balance: 582, is_liability: 1 });
  snapshot(db, 's1', '2026-07-23', { [card]: 0 });
  insertTransaction(db, { account_id: card, date: '2026-07-24', amount: 582 });
  insertTransaction(db, { account_id: card, date: '2026-07-25', amount: -900, pending: 1 });

  const report = correctLiabilitySigns(db, NOW);
  assert.equal(report.corrections.length, 1);
  assert.equal(balanceOf(db, card), -582);
  db.close();
});

test('a corrected balance is not re-corrected on the next pass', () => {
  const db = migratedTestDb();
  const card = insertAccount(db, { type: 'credit', current_balance: 582, is_liability: 1 });
  snapshot(db, 's1', '2026-07-23', { [card]: 0 });
  insertTransaction(db, { account_id: card, date: '2026-07-24', amount: 582 });

  correctLiabilitySigns(db, NOW);
  const second = correctLiabilitySigns(db, NOW);
  assert.deepEqual(second.corrections, []);
  assert.equal(balanceOf(db, card), -582);
  db.close();
});

test('the ingest guard stays on the one shape a single number can diagnose', () => {
  const positive: string[] = [];
  assert.equal(liabilityAdjustedCents(56.32, true, 'Discover', positive), -5632);
  assert.equal(positive.length, 1);

  // A negative provider balance is what ordinary debt looks like on every card the owner holds.
  // Advising on it would fire on the healthy case, and correctLiabilitySigns settles direction
  // against the ledger anyway: two mechanisms, one of them noisy, is not one correct path.
  const ordinary: string[] = [];
  assert.equal(liabilityAdjustedCents(-563.26, true, 'Discover', ordinary), 56326);
  assert.deepEqual(ordinary, []);
});
