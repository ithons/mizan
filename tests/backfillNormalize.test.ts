import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGenericCsv, applyFloor } from '../scripts/backfill/normalize';

// Discover-shaped input: purchases are POSITIVE and carry wallet junk on the description.
const DISCOVER_OPTS = {
  dateColumn: 'Post Date',
  dateFormat: 'MM/dd/yyyy',
  amountColumn: 'Amount',
  flipSign: true,
  merchantColumn: 'Description',
  merchantStrip: ['APPLE PAY ENDING IN.*$'],
};

test('flipSign turns a positive purchase into an outflow; merchantStrip removes wallet junk', () => {
  const { rows, issues } = normalizeGenericCsv(
    [{ 'Post Date': '04/16/2025', Amount: '4.98', Description: 'CHIPOTLE 1615 CAMBRIDGE MAAPPLE PAY ENDING IN 8537' }],
    'Discover Card',
    DISCOVER_OPTS
  );
  assert.equal(issues.length, 0);
  assert.deepEqual(rows[0], {
    account_name: 'Discover Card',
    date: '2025-04-16',
    amount: '-4.98',            // positive purchase flipped to outflow
    merchant: 'CHIPOTLE 1615 CAMBRIDGE MA',
    category: '',
    notes: '',
  });
});

test('a negative Discover payment flips to a positive inflow', () => {
  const { rows } = normalizeGenericCsv(
    [{ 'Post Date': '05/12/2025', Amount: '-705.81', Description: 'INTERNET PAYMENT - THANK YOU' }],
    'Discover Card',
    DISCOVER_OPTS
  );
  assert.equal(rows[0].amount, '705.81');
  assert.equal(rows[0].merchant, 'INTERNET PAYMENT - THANK YOU');
});

test('applyFloor keeps only rows strictly below the floor', () => {
  const rows = [
    { account_name: 'x', date: '2026-06-15', amount: '-1.00', merchant: 'a', category: '', notes: '' },
    { account_name: 'x', date: '2026-06-16', amount: '-2.00', merchant: 'b', category: '', notes: '' },
    { account_name: 'x', date: '2026-07-01', amount: '-3.00', merchant: 'c', category: '', notes: '' },
  ];
  const { kept, dropped } = applyFloor(rows, '2026-06-16');
  assert.equal(dropped, 2);
  assert.deepEqual(kept.map((r) => r.date), ['2026-06-15']);
});
