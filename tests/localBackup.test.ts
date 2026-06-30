import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { buildLocalBackup, LOCAL_BACKUP_TABLES } from '../server/src/services/localBackup';

function setupBackupDb(): Database.Database {
  const db = new Database(':memory:');

  for (const table of LOCAL_BACKUP_TABLES) {
    db.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY, value TEXT)`);
  }

  db.prepare('INSERT INTO accounts (id, value) VALUES (?, ?)').run('acct_1', 'Checking');
  db.prepare('INSERT INTO transactions (id, value) VALUES (?, ?)').run('txn_1', 'Coffee');
  db.prepare('INSERT INTO sync_runs (id, value) VALUES (?, ?)').run('sync_1', 'Succeeded');

  return db;
}

test('local backup exports all configured tables with metadata', (t) => {
  const db = setupBackupDb();
  t.after(() => db.close());

  const backup = buildLocalBackup(db, new Date('2026-06-30T12:00:00.000Z'));

  assert.equal(backup.app, 'mizan');
  assert.equal(backup.version, 1);
  assert.equal(backup.exported_at, '2026-06-30T12:00:00.000Z');
  assert.deepEqual(Object.keys(backup.tables), [...LOCAL_BACKUP_TABLES]);
  assert.deepEqual(backup.tables.accounts, [{ id: 'acct_1', value: 'Checking' }]);
  assert.deepEqual(backup.tables.transactions, [{ id: 'txn_1', value: 'Coffee' }]);
  assert.deepEqual(backup.tables.sync_runs, [{ id: 'sync_1', value: 'Succeeded' }]);
  assert.ok(!('credentials' in backup.tables));
});
