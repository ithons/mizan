import test from 'node:test';
import assert from 'node:assert/strict';
import { migratedTestDb, insertAccount } from './helpers/schema';
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

// End-to-end proof against a real schema: a served transaction below an account's
// floor must not survive, exactly as the sync loop applies the guard.
test('guard drops sub-floor provider rows in a real insert loop', () => {
  const db = migratedTestDb();
  insertAccount(db, { id: 'a1' });
  db.prepare("UPDATE accounts SET backfill_floor_date = '2026-01-01' WHERE id = 'a1'").run();

  const floor = (db.prepare('SELECT backfill_floor_date FROM accounts WHERE id = ?')
    .get('a1') as { backfill_floor_date: string | null }).backfill_floor_date;

  const served = [
    { id: 's1', date: '2025-06-01', amount: -1000 }, // below floor: imported history owns it
    { id: 's2', date: '2026-01-01', amount: -2000 }, // at floor: provider keeps it
    { id: 's3', date: '2026-03-01', amount: -3000 }, // above floor
  ];

  let skipped = 0;
  for (const txn of served) {
    if (isBelowBackfillFloor(txn.date, floor)) { skipped++; continue; }
    db.prepare(
      `INSERT INTO transactions (id, account_id, date, amount, source_type, created_at, updated_at)
       VALUES (?, 'a1', ?, ?, 'simplefin', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
    ).run(txn.id, txn.date, txn.amount);
  }

  assert.equal(skipped, 1);
  const kept = db.prepare('SELECT id FROM transactions ORDER BY date').all() as { id: string }[];
  assert.deepEqual(kept.map((r) => r.id), ['s2', 's3']);
});
