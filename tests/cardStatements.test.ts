import test from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { addDays, format, subDays } from 'date-fns';
import { _setDbForTesting } from '../server/src/db/index';
import { detectRecurring } from '../server/src/services/recurring';
import { buildRecurringForecast } from '../server/src/services/recurringForecast';
import { updateAccount } from '../server/src/services/accounts';
import { refreshTransferCandidates } from '../server/src/services/transactionIntegrity';
import { insertAccount, insertTransaction, migratedTestDb } from './helpers/schema';

const day = (date: Date) => format(date, 'yyyy-MM-dd');

function withAutopay(run: (db: Database.Database, card: string) => void): void {
  const db = migratedTestDb();
  _setDbForTesting(db);
  try {
    const checking = insertAccount(db, { account_name: 'Chase Checking', type: 'checking' });
    const card = insertAccount(db, { account_name: 'Chase Sapphire', type: 'credit', is_liability: 1, current_balance: 308443 });
    const amounts = [206295, 99834, 237314, 320013, 481314];
    amounts.forEach((amount, index) => {
      const date = day(subDays(new Date(), 30 * (amounts.length - index) + 10));
      insertTransaction(db, { account_id: checking, date, amount: -amount, original_name: 'CHASE CREDIT CRD AUTOPAY PPD ID: XXXXXX9224' });
      insertTransaction(db, { account_id: card, date, amount, original_name: 'AUTOMATIC PAYMENT - THANK' });
    });
    refreshTransferCandidates(db);
    detectRecurring();
    run(db, card);
  } finally {
    _setDbForTesting(undefined as unknown as Database.Database);
    db.close();
  }
}

function autopays(db: Database.Database) {
  return buildRecurringForecast(db, 60).occurrences.filter((o) => o.kind === 'transfer');
}

test('without a statement the autopay is estimated from past payments', () => {
  withAutopay((db) => {
    const forecast = autopays(db);
    assert.ok(forecast.length > 0);
    for (const occurrence of forecast) {
      assert.equal(occurrence.amount_basis, 'history');
      assert.equal(occurrence.amount, -237314, 'the median of the recent payments');
      assert.equal(occurrence.account_name, 'Chase Checking');
    }
  });
});

test('an unpaid statement sets the next autopay\'s amount and date', () => {
  withAutopay((db, card) => {
    const due = day(addDays(new Date(), 9));
    assert.equal(updateAccount(db, card, { statement_balance: 3084.43, statement_due_date: due }).ok, true);

    const [next, ...rest] = autopays(db);
    assert.deepEqual([next.expected_date, next.amount, next.amount_basis], [due, -308443, 'statement']);
    for (const occurrence of rest) {
      assert.ok(Math.abs(Date.parse(occurrence.expected_date) - Date.parse(due)) > 12 * 86_400_000,
        'the cadence occurrence the statement stands in for is not forecast twice');
    }
  });
});

test('once a payment lands the statement stops speaking for the next autopay', () => {
  withAutopay((db, card) => {
    const due = day(addDays(new Date(), 9));
    updateAccount(db, card, { statement_balance: 3084.43, statement_due_date: due });
    const checking = (db.prepare("SELECT id FROM accounts WHERE type = 'checking'").get() as { id: string }).id;
    insertTransaction(db, { account_id: checking, date: day(new Date()), amount: -308443, original_name: 'CHASE CREDIT CRD AUTOPAY PPD ID: XXXXXX9224' });
    insertTransaction(db, { account_id: card, date: day(new Date()), amount: 308443, original_name: 'AUTOMATIC PAYMENT - THANK' });
    refreshTransferCandidates(db);

    assert.equal(autopays(db).some((o) => o.amount_basis === 'statement'), false);
  });
});

test('a statement that has passed its due date is ignored', () => {
  withAutopay((db, card) => {
    updateAccount(db, card, { statement_balance: 3084.43, statement_due_date: day(subDays(new Date(), 1)) });
    assert.equal(autopays(db).some((o) => o.amount_basis === 'statement'), false);
  });
});

test('statement fields are stored in cents and can be cleared', () => {
  const db = migratedTestDb();
  const card = insertAccount(db, { type: 'credit', is_liability: 1 });
  updateAccount(db, card, { statement_balance: 331.43, statement_due_date: '2026-10-28' });
  assert.deepEqual(
    db.prepare('SELECT statement_balance, statement_due_date FROM accounts WHERE id = ?').get(card),
    { statement_balance: 33143, statement_due_date: '2026-10-28' }
  );
  updateAccount(db, card, { statement_balance: null, statement_due_date: null });
  assert.deepEqual(
    db.prepare('SELECT statement_balance, statement_due_date FROM accounts WHERE id = ?').get(card),
    { statement_balance: null, statement_due_date: null }
  );
});
