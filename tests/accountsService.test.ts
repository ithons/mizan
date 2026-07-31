import test from 'node:test';
import assert from 'node:assert/strict';
import { migratedTestDb, insertAccount } from './helpers/schema';
import { createManualAccount } from '../server/src/services/accounts';
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
