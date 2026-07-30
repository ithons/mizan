import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createManualAccount, getAccountBalanceHistory } from '../server/src/services/accounts';

// Minimal accounts schema covering the columns createManualAccount writes/reads.
// institution_name is NOT NULL DEFAULT '' (as in the real schema) so the test proves
// the bind-site fallback, not just the Zod default.
function setupDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      connection_type TEXT NOT NULL,
      institution_name TEXT NOT NULL DEFAULT '',
      account_name TEXT NOT NULL,
      type TEXT NOT NULL,
      current_balance INTEGER NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'USD',
      is_manual INTEGER NOT NULL DEFAULT 0,
      is_hidden INTEGER NOT NULL DEFAULT 0,
      is_liability INTEGER NOT NULL DEFAULT 0,
      color TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return db;
}

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

test('getAccountBalanceHistory extracts one account\'s series from snapshot breakdowns', (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE net_worth_snapshots (id TEXT PRIMARY KEY, date TEXT NOT NULL, breakdown TEXT NOT NULL, is_estimated INTEGER NOT NULL DEFAULT 0)`);
  const ins = db.prepare('INSERT INTO net_worth_snapshots (id, date, breakdown) VALUES (?,?,?)');
  ins.run('s1', '2026-01-01', JSON.stringify({ acct: 10000, other: 5000 }));
  ins.run('s2', '2026-02-01', JSON.stringify({ acct: 12000, other: 5000 }));
  ins.run('s3', '2026-03-01', JSON.stringify({ other: 5000 })); // acct not present yet/anymore
  ins.run('s4', '2026-04-01', 'not json');                      // malformed — skipped

  const hist = getAccountBalanceHistory(db, 'acct');
  assert.deepEqual(hist, [
    { date: '2026-01-01', balance: 10000, estimated: false },
    { date: '2026-02-01', balance: 12000, estimated: false },
  ]);
});
