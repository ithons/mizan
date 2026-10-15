import test from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { format, subDays } from 'date-fns';
import { _setDbForTesting } from '../server/src/db/index';
import { detectRecurring, payerKey, samePayer } from '../server/src/services/recurring';
import { insertAccount, insertTransaction, migratedTestDb } from './helpers/schema';

test('the three spellings of MIT payroll reduce to one payer', () => {
  const keys = [
    'mass inst payroll',
    'MASS INST PAYROLL PPD ID: 9111111101',
    'MASS. INST. OF T ECHECKPAY 00000000 CCD ID: 1042103594',
  ].map(payerKey);
  assert.deepEqual(keys, ['mass inst', 'mass inst', 'mass inst of t']);
  assert.equal(samePayer(keys[0], keys[2]), true);
});

test('different payers stay apart', () => {
  assert.equal(samePayer('mit', 'mitre'), false, 'one word is not enough to call two payers one');
  assert.equal(samePayer('harvard univ', 'harvard pilgrim'), false);
  assert.equal(samePayer('acme widgets', 'acme widgets east'), true);
});

test('a confirmed payroll pattern absorbs its other spellings instead of gaining a twin', () => {
  const db = migratedTestDb();
  _setDbForTesting(db);
  try {
    const checking = insertAccount(db, { type: 'checking' });
    const day = (daysAgo: number) => format(subDays(new Date(), daysAgo), 'yyyy-MM-dd');
    const add = (daysAgo: number, original: string, merchant: string) =>
      insertTransaction(db, { account_id: checking, date: day(daysAgo), amount: 54418, merchant_name: merchant, original_name: original, category_id: 'cat_income_paycheck' });

    for (const daysAgo of [63, 56, 49, 42]) add(daysAgo, 'MASS INST PAYROLL PPD ID: 9111111101', 'MASS INST PAYROLL PPD ID: 9111111101');
    detectRecurring();
    const original = db.prepare('SELECT id, merchant_name FROM recurring_patterns').get() as { id: string; merchant_name: string };
    db.prepare('UPDATE recurring_patterns SET is_confirmed = 1 WHERE id = ?').run(original.id);

    add(70, 'MASS. INST. OF T ECHECKPAY 00000000 CCD ID: 1042103594', 'MASS. INST. OF T ECHECKPAY 00000000 CCD ID: 1042103594');
    for (const daysAgo of [35, 28, 21, 14, 7]) add(daysAgo, 'MASS INST PAYROLL PPD ID: 9111111101', 'Mass Inst Payroll');
    detectRecurring();

    const patterns = db.prepare('SELECT id, is_confirmed, transaction_count FROM recurring_patterns').all();
    assert.deepEqual(patterns, [{ id: original.id, is_confirmed: 1, transaction_count: 10 }]);
  } finally {
    _setDbForTesting(undefined as unknown as Database.Database);
    db.close();
  }
});
