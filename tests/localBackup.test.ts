import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  buildLocalBackup,
  buildLocalBackupRestorePreview,
  LOCAL_BACKUP_TABLES,
  restoreLocalBackup,
  LocalBackupValidationError,
} from '../server/src/services/localBackup';

function setupBackupDb(): Database.Database {
  const db = new Database(':memory:');

  for (const table of LOCAL_BACKUP_TABLES) {
    db.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY, value TEXT)`);
  }

  db.prepare('INSERT INTO accounts (id, value) VALUES (?, ?)').run('acct_1', 'Checking');
  db.prepare('INSERT INTO transactions (id, value) VALUES (?, ?)').run('txn_1', 'Coffee');
  db.prepare('INSERT INTO sync_runs (id, value) VALUES (?, ?)').run('sync_1', 'Succeeded');
  db.prepare('INSERT INTO schema_migrations (id, value) VALUES (?, ?)').run('migration_1', 'Initial');

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

test('local backup restore preview validates row counts and skips migration state', (t) => {
  const db = setupBackupDb();
  t.after(() => db.close());

  const backup = buildLocalBackup(db, new Date('2026-06-30T12:00:00.000Z'));
  const preview = buildLocalBackupRestorePreview(db, backup);
  const migrationTable = preview.tables.find((table) => table.table === 'schema_migrations');

  assert.equal(preview.valid, true);
  assert.equal(preview.app, 'mizan');
  assert.equal(preview.version, 1);
  assert.equal(preview.table_count, LOCAL_BACKUP_TABLES.length);
  assert.equal(preview.restorable_table_count, LOCAL_BACKUP_TABLES.length - 1);
  assert.equal(preview.restorable_rows, 3);
  assert.equal(migrationTable?.restorable, false);
  assert.equal(migrationTable?.backup_rows, 1);
});

test('local backup restore replaces data tables without rewriting schema migrations', (t) => {
  const source = setupBackupDb();
  const target = setupBackupDb();
  t.after(() => source.close());
  t.after(() => target.close());

  source.prepare('INSERT INTO accounts (id, value) VALUES (?, ?)').run('acct_2', 'Savings');
  target.prepare('INSERT INTO accounts (id, value) VALUES (?, ?)').run('acct_old', 'Old Checking');
  target.prepare('INSERT INTO schema_migrations (id, value) VALUES (?, ?)').run('migration_current', 'Current');

  const backup = buildLocalBackup(source, new Date('2026-06-30T12:00:00.000Z'));
  const result = restoreLocalBackup(target, backup);

  assert.equal(result.restored_tables, LOCAL_BACKUP_TABLES.length - 1);
  assert.equal(result.restored_rows, 4);
  assert.deepEqual(result.skipped_tables, ['schema_migrations']);
  assert.deepEqual(
    target.prepare('SELECT * FROM accounts ORDER BY id').all(),
    [
      { id: 'acct_1', value: 'Checking' },
      { id: 'acct_2', value: 'Savings' },
    ]
  );
  assert.deepEqual(
    target.prepare('SELECT * FROM schema_migrations ORDER BY id').all(),
    [
      { id: 'migration_1', value: 'Initial' },
      { id: 'migration_current', value: 'Current' },
    ]
  );
});

test('local backup restore rejects unsupported columns before mutation', (t) => {
  const db = setupBackupDb();
  t.after(() => db.close());

  const backup = buildLocalBackup(db, new Date('2026-06-30T12:00:00.000Z'));
  backup.tables.accounts = [
    { id: 'acct_2', value: 'Savings', unsupported_column: true },
  ];

  const preview = buildLocalBackupRestorePreview(db, backup);
  assert.equal(preview.valid, false);
  assert.ok(preview.errors.some((error) => error.includes('unsupported_column')));

  assert.throws(
    () => restoreLocalBackup(db, backup),
    LocalBackupValidationError
  );
  assert.deepEqual(
    db.prepare('SELECT * FROM accounts ORDER BY id').all(),
    [{ id: 'acct_1', value: 'Checking' }]
  );
});
