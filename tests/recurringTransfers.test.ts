import test from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { addDays, format, previousMonday, subDays } from 'date-fns';
import { _setDbForTesting } from '../server/src/db/index';
import { detectRecurring, usualWeekday } from '../server/src/services/recurring';
import { buildRecurringForecast } from '../server/src/services/recurringForecast';
import { buildSubscriptionInsights } from '../server/src/services/subscriptionInsights';
import { refreshTransferCandidates } from '../server/src/services/transactionIntegrity';
import { insertAccount, insertTransaction, migratedTestDb } from './helpers/schema';

function withDb(run: (db: Database.Database) => void): void {
  const db = migratedTestDb();
  _setDbForTesting(db);
  try {
    run(db);
  } finally {
    _setDbForTesting(undefined as unknown as Database.Database);
    db.close();
  }
}

const day = (date: Date) => format(date, 'yyyy-MM-dd');

/** The weekly contribution as the ledger holds it: $50 into July, $100 since, one holiday Tuesday. */
function seedWeeklyContribution(db: Database.Database): { chase: string; lastMonday: Date } {
  const chase = insertAccount(db, { account_name: 'Chase Checking', type: 'checking' });
  const fid = insertAccount(db, { account_name: 'Fidelity Individual', type: 'brokerage' });
  const lastMonday = previousMonday(subDays(new Date(), 2));
  for (let week = 11; week >= 0; week--) {
    const monday = subDays(lastMonday, 7 * week);
    const posted = day(week === 0 ? addDays(monday, 1) : monday);
    const amount = week >= 8 ? 5000 : 10000;
    insertTransaction(db, { account_id: chase, date: posted, amount: -amount, original_name: 'FID BKG SVC LLC MONEYLINE PPD ID: XXXXXX4600', category_id: 'cat_inv_transfer', category_source: 'rule' });
    insertTransaction(db, { account_id: fid, date: posted, amount, original_name: 'Electronic Funds Transfer Received (Cash)' });
  }
  refreshTransferCandidates(db);
  return { chase, lastMonday };
}

test('the weekly contribution is a schedule out of checking at its current size', () => {
  withDb((db) => {
    const { chase, lastMonday } = seedWeeklyContribution(db);
    detectRecurring();

    const pattern = db.prepare(
      "SELECT merchant_name, frequency, average_amount, next_expected, account_id, category_id FROM recurring_patterns WHERE kind = 'transfer'"
    ).get() as Record<string, unknown>;
    assert.deepEqual(pattern, {
      merchant_name: 'Chase Checking to Fidelity Individual',
      frequency: 'weekly',
      average_amount: 10000,
      next_expected: day(addDays(lastMonday, 7)),
      account_id: chase,
      category_id: 'cat_inv_transfer',
    });
  });
});

test('a scheduled transfer is an outflow from its account and neither income nor a bill', () => {
  withDb((db) => {
    seedWeeklyContribution(db);
    detectRecurring();
    const forecast = buildRecurringForecast(db, 30);

    const transfers = forecast.occurrences.filter((o) => o.kind === 'transfer');
    assert.ok(transfers.length >= 4);
    for (const occurrence of transfers) {
      assert.equal(occurrence.amount, -10000);
      assert.equal(occurrence.account_name, 'Chase Checking');
      assert.equal(occurrence.counterparty_account_name, 'Fidelity Individual');
      assert.equal(occurrence.is_income, false);
    }
    assert.equal(forecast.bills, 0);
    assert.equal(forecast.income, 0);
    assert.equal(forecast.transfers, transfers.reduce((sum, o) => sum + Math.abs(o.amount), 0));
    assert.equal(buildSubscriptionInsights(db, 30).subscriptions.length, 0, 'a transfer is not a subscription');
  });
});

test('a card autopay schedule is filed as a card payment', () => {
  withDb((db) => {
    const checking = insertAccount(db, { account_name: 'Chase Checking', type: 'checking' });
    const card = insertAccount(db, { account_name: 'Chase Sapphire', type: 'credit', is_liability: 1 });
    const amounts = [154387, 354762, 206295, 99834, 237314, 320013, 481314];
    amounts.forEach((amount, index) => {
      const date = day(subDays(new Date(), 30 * (amounts.length - index) - 5));
      insertTransaction(db, { account_id: checking, date, amount: -amount, original_name: 'CHASE CREDIT CRD AUTOPAY PPD ID: XXXXXX9224' });
      insertTransaction(db, { account_id: card, date, amount, original_name: 'AUTOMATIC PAYMENT - THANK' });
    });
    refreshTransferCandidates(db);
    detectRecurring();

    const pattern = db.prepare(
      "SELECT frequency, category_id, account_id FROM recurring_patterns WHERE kind = 'transfer'"
    ).get();
    assert.deepEqual(pattern, { frequency: 'monthly', category_id: 'cat_xfer_cc', account_id: checking });
  });
});

test('an unpaired weekly movement stays out of the transfer schedules', () => {
  withDb((db) => {
    const checking = insertAccount(db, { type: 'checking' });
    for (let week = 6; week >= 1; week--) {
      insertTransaction(db, { account_id: checking, date: day(subDays(new Date(), 7 * week)), amount: -2500, original_name: 'VENMO PAYMENT' });
    }
    detectRecurring();
    const transfers = db.prepare("SELECT COUNT(*) AS n FROM recurring_patterns WHERE kind = 'transfer'").get() as { n: number };
    assert.equal(transfers.n, 0);
  });
});

test('the usual weekday needs a strict majority', () => {
  assert.equal(usualWeekday(['2026-09-21', '2026-09-28', '2026-10-05', '2026-10-13']), 1);
  assert.equal(usualWeekday(['2026-09-21', '2026-09-29']), null);
});
