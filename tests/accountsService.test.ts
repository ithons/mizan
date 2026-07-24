import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createManualAccount } from '../server/src/services/accounts';

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
