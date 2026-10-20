import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { registerMigrationFunctions } from '../server/src/db/migrationFunctions';
import { mergeAccounts, updateAccount } from '../server/src/services/accounts';
import { createManualTransaction } from '../server/src/services/transactions';
import { buildCsvImportPreview } from '../server/src/services/csvImport';
import { insertAccount, insertTransaction, migratedTestDb } from './helpers/schema';

const MIGRATIONS = path.join(import.meta.dirname, '..', 'server', 'src', 'db', 'migrations');

function wallet(db: Database.Database): string {
  const id = insertAccount(db, { account_name: 'Wallet', type: 'cash', connection_type: 'manual', is_manual: 1, current_balance: 4000 });
  db.prepare('UPDATE accounts SET balance_only = 1 WHERE id = ?').run(id);
  return id;
}

test('migration 071 marks an empty manual cash account balance-only and leaves one with history alone', () => {
  const db = new Database(':memory:');
  registerMigrationFunctions(db);
  const files = fs.readdirSync(MIGRATIONS).filter((file) => file.endsWith('.sql')).sort();
  for (const file of files.filter((name) => name < '071')) db.exec(fs.readFileSync(path.join(MIGRATIONS, file), 'utf8'));
  const empty = insertAccount(db, { account_name: 'Wallet', type: 'cash', connection_type: 'manual', is_manual: 1 });
  const used = insertAccount(db, { account_name: 'Coin jar', type: 'cash', connection_type: 'manual', is_manual: 1 });
  const checking = insertAccount(db, { account_name: 'Checking', type: 'checking', connection_type: 'manual', is_manual: 1 });
  insertTransaction(db, { account_id: used, amount: -500, original_name: 'Coffee' });
  db.exec(fs.readFileSync(path.join(MIGRATIONS, '071_balance_only_accounts.sql'), 'utf8'));
  const flag = (id: string) => (db.prepare('SELECT balance_only FROM accounts WHERE id = ?').get(id) as { balance_only: number }).balance_only;
  assert.deepEqual([flag(empty), flag(used), flag(checking)], [1, 0, 0]);
});

test('a balance-only account refuses an entry, and keeps its balance editable', () => {
  const db = migratedTestDb();
  const id = wallet(db);
  assert.deepEqual(createManualTransaction(db, { account_id: id, date: '2026-10-01', amount: -12, original_name: 'Lunch' }), { ok: false, reason: 'balance_only' });
  const updated = updateAccount(db, id, { current_balance: 85 });
  assert.equal(updated.ok, true);
  assert.equal((db.prepare('SELECT current_balance FROM accounts WHERE id = ?').get(id) as { current_balance: number }).current_balance, 8500);
});

test('an account with transactions cannot be made balance-only, and one without can', () => {
  const db = migratedTestDb();
  const used = insertAccount(db, { account_name: 'Coin jar', type: 'cash', connection_type: 'manual', is_manual: 1 });
  insertTransaction(db, { account_id: used, amount: -500 });
  assert.deepEqual(updateAccount(db, used, { balance_only: true }), { ok: false, reason: 'has_transactions' });
  const empty = insertAccount(db, { account_name: 'Envelope', type: 'cash', connection_type: 'manual', is_manual: 1 });
  assert.equal(updateAccount(db, empty, { balance_only: true }).ok, true);
});

test('a CSV import never lands rows in a balance-only account, by name or with no account given', () => {
  const db = migratedTestDb();
  wallet(db);
  const preview = buildCsvImportPreview(db, {
    rows: [{ Date: '2026-10-01', Amount: '-12.00', Account: 'Wallet', Payee: 'Lunch' }, { Date: '2026-10-02', Amount: '-4.00', Payee: 'Coffee' }],
    mapping: { date: 'Date', amount: 'Amount', amountNegate: false, account: 'Account', merchant: 'Payee' },
  });
  assert.equal(preview.valid_count, 0);
  assert.ok(preview.rows.every((row) => row.account_id === undefined));
});

test('another account cannot be merged into a balance-only one when it has transactions', () => {
  const db = migratedTestDb();
  const id = wallet(db);
  const other = insertAccount(db, { account_name: 'Old cash', type: 'cash', connection_type: 'manual', is_manual: 1 });
  insertTransaction(db, { account_id: other, amount: -700 });
  assert.deepEqual(mergeAccounts(db, id, other), { ok: false, reason: 'balance_only' });
});

test('restoring a backup taken before balance-only accounts existed sets the flag again', async () => {
  const { buildLocalBackup, restoreLocalBackup } = await import('../server/src/services/localBackup');
  const source = migratedTestDb();
  const target = migratedTestDb();
  const id = insertAccount(source, { account_name: 'Wallet', type: 'cash', connection_type: 'manual', is_manual: 1 });
  const wire = JSON.parse(JSON.stringify(buildLocalBackup(source))) as { tables: Record<string, Array<Record<string, unknown>>> };
  for (const row of wire.tables.accounts) delete row.balance_only;
  wire.tables.schema_migrations = wire.tables.schema_migrations.filter((row) => String(row.name) < '071');
  restoreLocalBackup(target, wire);
  assert.deepEqual(target.prepare('SELECT balance_only FROM accounts WHERE id = ?').get(id), { balance_only: 1 });
});
