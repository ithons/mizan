import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectCsvImportMapping,
  MIZAN_CSV_MAPPING,
  MONARCH_CSV_MAPPING,
} from '../client/src/lib/csvImportMapping';

test('csv import mapping exposes mizan and monarch presets', () => {
  assert.deepEqual(MIZAN_CSV_MAPPING, {
    date: 'date',
    amount: 'amount',
    merchant: 'merchant_name',
    category: 'category_name',
    account: 'account_name',
    notes: 'notes',
    dateFormat: 'yyyy-MM-dd',
    amountNegate: false,
  });
  assert.deepEqual(MONARCH_CSV_MAPPING, {
    date: 'Date',
    amount: 'Amount',
    merchant: 'Merchant',
    category: 'Category',
    account: 'Account',
    notes: 'Notes',
    dateFormat: 'yyyy-MM-dd',
    amountNegate: false,
  });
});

test('csv import mapping detects monarch transaction headers', () => {
  const mapping = detectCsvImportMapping(['Date', 'Merchant', 'Category', 'Account', 'Amount', 'Notes']);

  assert.equal(mapping.date, 'Date');
  assert.equal(mapping.merchant, 'Merchant');
  assert.equal(mapping.category, 'Category');
  assert.equal(mapping.account, 'Account');
  assert.equal(mapping.amount, 'Amount');
  assert.equal(mapping.notes, 'Notes');
});

test('csv import mapping tolerates mixed-case export headers', () => {
  const mapping = detectCsvImportMapping([
    'Transaction Date',
    'description',
    'CATEGORY',
    'account_name',
    'Transaction Amount',
    'Memo',
  ]);

  assert.equal(mapping.date, 'Transaction Date');
  assert.equal(mapping.merchant, 'description');
  assert.equal(mapping.category, 'CATEGORY');
  assert.equal(mapping.account, 'account_name');
  assert.equal(mapping.amount, 'Transaction Amount');
  assert.equal(mapping.notes, 'Memo');
});
