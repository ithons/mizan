import test from 'node:test';
import assert from 'node:assert/strict';
import { migratedTestDb, TEST_NOW } from './helpers/schema';
import { applySimplefinResponse } from '../server/src/services/simplefin';
import { isBelowBackfillFloor } from '../server/src/services/backfillFloor';

test('no floor set never skips', () => {
  assert.equal(isBelowBackfillFloor('2020-01-01', null), false);
  assert.equal(isBelowBackfillFloor('2020-01-01', undefined), false);
});

test('dates strictly below the floor are skipped', () => {
  assert.equal(isBelowBackfillFloor('2025-12-31', '2026-01-01'), true);
});

test('the floor date itself and everything above it is kept', () => {
  // Adjacency: the floor is the provider oldest, so date == floor stays with the provider.
  assert.equal(isBelowBackfillFloor('2026-01-01', '2026-01-01'), false);
  assert.equal(isBelowBackfillFloor('2026-06-15', '2026-01-01'), false);
});

const noonUtc = (day: number): number => Date.UTC(2026, 6, day, 16) / 1000;

function servedWindow(): unknown {
  return {
    accounts: [{
      id: 'ACT-chk', name: 'Checking', currency: 'USD', balance: '100.00',
      org: { name: 'Bank' },
      transactions: [
        { id: 'TRN-below', posted: noonUtc(10), amount: '-10.00', description: 'BELOW', pending: false },
        { id: 'TRN-at', posted: noonUtc(20), amount: '-20.00', description: 'AT', pending: false },
        { id: 'TRN-above', posted: noonUtc(25), amount: '-30.00', description: 'ABOVE', pending: false },
      ],
    }],
  };
}

// A lookback reaching below the floor is routine, so it must not read as dropped data.
test('rows below the floor are dropped without counting as skipped', () => {
  const db = migratedTestDb();
  applySimplefinResponse(db, { accounts: [{ id: 'ACT-chk', name: 'Checking', currency: 'USD', balance: '100.00', org: { name: 'Bank' }, transactions: [] }] }, TEST_NOW);
  db.prepare("UPDATE accounts SET backfill_floor_date = '2026-07-20' WHERE simplefin_account_id = 'ACT-chk'").run();

  const result = applySimplefinResponse(db, servedWindow(), TEST_NOW);

  assert.equal(result.skipped, 0);
  assert.deepEqual(result.errors, []);
  const kept = db.prepare('SELECT simplefin_transaction_id AS id FROM transactions ORDER BY date').all() as { id: string }[];
  assert.deepEqual(kept.map((r) => r.id), ['TRN-at', 'TRN-above']);
});

test('an unparseable amount is still counted as skipped and explained', () => {
  const db = migratedTestDb();
  const payload = servedWindow() as { accounts: { transactions: { amount: string }[] }[] };
  payload.accounts[0].transactions[2].amount = 'not money';

  const result = applySimplefinResponse(db, payload, TEST_NOW);

  assert.equal(result.skipped, 1);
  assert.equal(result.errors.length, 1);
});
