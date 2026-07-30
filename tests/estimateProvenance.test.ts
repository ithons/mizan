import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateNote,
  readLatestSnapshot,
  readSnapshotBefore,
  readSnapshots,
} from '../server/src/services/netWorthHistory';
import { getAccountBalanceHistory } from '../server/src/services/accounts';
import { insertAccount, migratedTestDb } from './helpers/schema';

/**
 * `is_estimated` distinguishes a measured balance sheet from one reconstructed by reverse-replaying
 * transactions off today's balances. The app had no mechanism for carrying it: `routes/networth.ts`
 * happened to `SELECT *`, and every reader with an explicit column list dropped it, which was four
 * of the five consumers including both AI paths.
 */

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

test('every snapshot read carries is_estimated as a boolean', () => {
  const db = migratedTestDb();
  const account = insertAccount(db);
  seed(db, account);

  const rows = readSnapshots(db, { order: 'asc' });
  assert.equal(rows.length, 4);
  // A boolean, not the raw 0/1: a consumer that forgets to cast would render 0 as truthy.
  assert.deepEqual(rows.map((r) => r.is_estimated), [true, true, false, false]);
  for (const row of rows) assert.equal(typeof row.is_estimated, 'boolean');

  assert.equal(readLatestSnapshot(db)?.date, '2026-07-01');
  db.close();
});

test('measuredOnly excludes reconstructions from a comparison', () => {
  const db = migratedTestDb();
  const account = insertAccount(db);
  seed(db, account);

  assert.equal(readSnapshots(db, { measuredOnly: true }).length, 2);

  // "Net worth vs last month" against a reconstruction compares a fact to a guess and states the
  // result as a fact. On the real ledger the nearest prior snapshot to 2026-07-01 was measured,
  // but the two before it were not.
  assert.equal(readSnapshotBefore(db, '2026-06-15')?.date, '2026-06-01');
  assert.equal(readSnapshotBefore(db, '2026-06-15', { measuredOnly: true }), null);
  assert.equal(readSnapshotBefore(db, '2026-07-01', { measuredOnly: true })?.date, '2026-06-30');
  db.close();
});

test('a per-account balance series marks its reconstructed points', () => {
  const db = migratedTestDb();
  const account = insertAccount(db);
  seed(db, account);

  const series = getAccountBalanceHistory(db, account);
  // Without the flag this drew one solid measured line through $1,500 -> $1,510 -> $1.00, so an
  // account that was not yet connected appeared to hold $1,510 and then collapse to nothing.
  assert.deepEqual(series.map((p) => p.estimated), [true, true, false, false]);
  db.close();
});

test('an estimate is labelled as one wherever a snapshot becomes text for the model', () => {
  assert.equal(estimateNote({ is_estimated: false }), '');
  assert.match(estimateNote({ is_estimated: true }), /estimated/);
  assert.match(estimateNote({ is_estimated: true }), /not a measured balance/);
});
