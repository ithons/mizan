import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readLatestSnapshot,
  readSnapshotBefore,
  readSnapshots,
} from '../server/src/services/netWorthHistory';
import { insertAccount, migratedTestDb } from './helpers/schema';

/** Rows marked `is_estimated` were written by the monthly reconstruction the timeline replaced. */

function seed(db: ReturnType<typeof migratedTestDb>, accountId: string) {
  const insert = db.prepare(`
    INSERT INTO net_worth_snapshots
      (id, date, total_assets, total_liabilities, net_worth, breakdown, is_estimated,
       liquid_assets, investment_assets, crypto_assets, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-07-30T00:00:00.000Z')
  `);
  const breakdown = (v: number) => JSON.stringify({ [accountId]: v });
  insert.run('s1', '2026-05-01', 150000, 0, 150000, breakdown(150000), 1, 150000, 0, 0);
  insert.run('s2', '2026-06-01', 151000, 0, 151000, breakdown(151000), 1, 151000, 0, 0);
  insert.run('s3', '2026-06-30', 100, 0, 100, breakdown(100), 0, 100, 0, 0);
  insert.run('s4', '2026-07-01', 200, 0, 200, breakdown(200), 0, 200, 0, 0);
}

test('a stored estimate never reaches a reader: every read is of measured sheets', () => {
  const db = migratedTestDb();
  const account = insertAccount(db);
  seed(db, account);

  assert.deepEqual(readSnapshots(db, { order: 'asc' }).map((row) => row.date), ['2026-06-30', '2026-07-01']);
  assert.equal(readLatestSnapshot(db)?.date, '2026-07-01');
  assert.equal(readSnapshotBefore(db, '2026-06-15'), null);
  assert.equal(readSnapshotBefore(db, '2026-07-01')?.date, '2026-06-30');
  db.close();
});
