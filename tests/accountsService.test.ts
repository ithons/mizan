import test from 'node:test';
import assert from 'node:assert/strict';
import { migratedTestDb, insertAccount } from './helpers/schema';
import { createManualAccount, updateAccount } from '../server/src/services/accounts';
import { getSnapshotBalanceHistory } from '../server/src/services/balanceHistory';

// institution_name is NOT NULL DEFAULT '' in the real schema, so the test proves
// the bind-site fallback, not just the Zod default.
const setupDb = migratedTestDb;

test('createManualAccount succeeds when institution_name is omitted (no 500)', (t) => {
  const db = setupDb();
  t.after(() => db.close());

  const row = createManualAccount(db, {
    account_name: 'Rainy Day',
    type: 'savings',
    current_balance: 100,
    currency: 'USD',
  }) as Record<string, unknown>;

  assert.equal(row.account_name, 'Rainy Day');
  assert.equal(row.institution_name, ''); // fell back to '' rather than throwing on undefined
  assert.equal(row.current_balance, 10000); // dollars -> cents
});

test('createManualAccount derives liability for credit type', (t) => {
  const db = setupDb();
  t.after(() => db.close());

  const row = createManualAccount(db, {
    account_name: 'Card',
    type: 'credit',
    institution_name: 'SomeBank',
    current_balance: 0,
    currency: 'USD',
  }) as Record<string, unknown>;

  assert.equal(row.is_liability, 1);
  assert.equal(row.institution_name, 'SomeBank');
});

test('the snapshot series extracts one account\'s points, skipping what it cannot read', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());
  insertAccount(db, { id: 'acct' });
  const ins = db.prepare(`INSERT INTO net_worth_snapshots
    (id, date, total_assets, total_liabilities, net_worth, breakdown, created_at)
    VALUES (?,?,0,0,0,?,'2026-01-01T00:00:00.000Z')`);
  ins.run('s1', '2026-01-01', JSON.stringify({ acct: 10000, other: 5000 }));
  ins.run('s2', '2026-02-01', JSON.stringify({ acct: 12000, other: 5000 }));
  ins.run('s3', '2026-03-01', JSON.stringify({ other: 5000 })); // acct not present yet/anymore
  ins.run('s4', '2026-04-01', 'not json');                      // malformed, skipped

  const hist = getSnapshotBalanceHistory(db, 'acct');
  assert.equal(hist.basis, 'snapshot');
  assert.deepEqual(hist.points, [
    { date: '2026-01-01', balance: 10000, source: 'measured' },
    { date: '2026-02-01', balance: 12000, source: 'measured' },
  ]);
});

/**
 * A balance an institution reported cannot be overwritten through the API.
 *
 * `updateAccount`'s policy comment enumerated the provider-sourced fields and left out the money
 * one; `current_balance` was then written unconditionally. The edit modal hides the field for
 * synced accounts, which is not a guard: `PATCH /api/accounts/:id` took it from any client. And
 * `takeSnapshot()` on the next sync recorded the falsified figure into `net_worth_snapshots` as a
 * measured sheet before the provider put the real balance back, so history carried a number nobody
 * reported. The standing rule is that a provider number is never rewritten; disagreement is
 * recorded through migration 048's field provenance instead.
 */
test('a synced account refuses a balance edit, a manual one accepts it', (t) => {
  const db = setupDb();
  t.after(() => db.close());
  const synced = insertAccount(db, { type: 'checking', is_manual: 0, current_balance: 123456 });
  const manual = insertAccount(db, { type: 'cash', is_manual: 1, current_balance: 5000 });

  const refused = updateAccount(db, synced, { current_balance: 9999.99 });
  assert.deepEqual(refused, { ok: false, reason: 'manual_only' });
  const untouched = db.prepare('SELECT current_balance FROM accounts WHERE id = ?').get(synced) as { current_balance: number };
  assert.equal(untouched.current_balance, 123456, 'a provider balance was overwritten');

  const accepted = updateAccount(db, manual, { current_balance: 75.25 });
  assert.equal(accepted.ok, true);
  const written = db.prepare('SELECT current_balance FROM accounts WHERE id = ?').get(manual) as { current_balance: number };
  assert.equal(written.current_balance, 7525);
});

test('HEALTHY: the fields a synced account MAY edit still work', (t) => {
  const db = setupDb();
  t.after(() => db.close());
  const synced = insertAccount(db, { type: 'checking', is_manual: 0 });
  // type and is_liability are the documented escape hatch for a misclassified synced account.
  const result = updateAccount(db, synced, { type: 'savings', account_name: 'Renamed' });
  assert.equal(result.ok, true);
  const row = db.prepare('SELECT type, account_name FROM accounts WHERE id = ?').get(synced) as { type: string; account_name: string };
  assert.deepEqual(row, { type: 'savings', account_name: 'Renamed' });
});
