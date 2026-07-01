import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runPostSyncStages } from '../server/src/services/syncManager';
import type { TransactionIntegrityResult } from '../server/src/services/transactionIntegrity';

function setupSyncDb(): Database.Database {
  const db = new Database(':memory:');

  db.exec(`
    CREATE TABLE sync_runs (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      message TEXT,
      error_code TEXT,
      error_message TEXT,
      recovery_action TEXT,
      accounts_seen INTEGER NOT NULL DEFAULT 0,
      transactions_added INTEGER NOT NULL DEFAULT 0,
      transactions_modified INTEGER NOT NULL DEFAULT 0,
      transactions_removed INTEGER NOT NULL DEFAULT 0,
      transactions_skipped INTEGER NOT NULL DEFAULT 0,
      duplicate_candidates INTEGER NOT NULL DEFAULT 0,
      transfer_candidates INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE sync_run_items (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      connection_id TEXT,
      institution_name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      accounts_seen INTEGER NOT NULL DEFAULT 0,
      transactions_added INTEGER NOT NULL DEFAULT 0,
      transactions_modified INTEGER NOT NULL DEFAULT 0,
      transactions_removed INTEGER NOT NULL DEFAULT 0,
      transactions_skipped INTEGER NOT NULL DEFAULT 0,
      error_code TEXT,
      error_message TEXT,
      recovery_action TEXT
    );

    CREATE TABLE sync_changes (
      id TEXT PRIMARY KEY,
      run_item_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      change_type TEXT NOT NULL,
      description TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    INSERT INTO sync_runs (id, scope, status, started_at)
    VALUES ('run_1', 'full', 'running', '2026-06-30T00:00:00.000Z');
  `);

  return db;
}

const emptyIntegrity: TransactionIntegrityResult = {
  duplicates: { groupCount: 0, transactionCount: 0 },
  transfers: { pairCount: 0, transactionCount: 0 },
};

test('runPostSyncStages: all stages succeed, no deferred error', (t) => {
  const db = setupSyncDb();
  t.after(() => db.close());

  const calls: string[] = [];
  const result = runPostSyncStages(db, 'run_1', null, {
    detectRecurring: () => { calls.push('detectRecurring'); },
    refreshTransactionIntegrity: () => { calls.push('refreshTransactionIntegrity'); return emptyIntegrity; },
    takeSnapshot: () => { calls.push('takeSnapshot'); },
  });

  assert.deepEqual(calls, ['detectRecurring', 'refreshTransactionIntegrity', 'takeSnapshot']);
  assert.equal(result.deferredError, null);
  assert.deepEqual(result.integrity, emptyIntegrity);

  const items = db.prepare('SELECT * FROM sync_run_items').all() as { status: string; connection_id: string }[];
  assert.equal(items.length, 1);
  assert.equal(items[0]?.connection_id, 'transaction-integrity');
  assert.equal(items[0]?.status, 'succeeded');
});

test('runPostSyncStages: a stage failure does not skip the later stages', (t) => {
  const db = setupSyncDb();
  t.after(() => db.close());

  const calls: string[] = [];
  const result = runPostSyncStages(db, 'run_1', null, {
    detectRecurring: () => {
      calls.push('detectRecurring');
      throw new Error('recurring blew up');
    },
    refreshTransactionIntegrity: () => { calls.push('refreshTransactionIntegrity'); return emptyIntegrity; },
    takeSnapshot: () => { calls.push('takeSnapshot'); },
  });

  assert.deepEqual(calls, ['detectRecurring', 'refreshTransactionIntegrity', 'takeSnapshot']);
  assert.equal(result.deferredError?.message, 'recurring blew up');
  assert.deepEqual(result.integrity, emptyIntegrity);

  const items = db.prepare('SELECT provider, connection_id, status, error_message FROM sync_run_items ORDER BY connection_id').all() as
    { provider: string; connection_id: string; status: string; error_message: string | null }[];
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((i) => i.connection_id).sort(), ['recurring-detection', 'transaction-integrity']);
  const recurringItem = items.find((i) => i.connection_id === 'recurring-detection');
  assert.equal(recurringItem?.status, 'failed');
  assert.equal(recurringItem?.error_message, 'recurring blew up');
});

test('runPostSyncStages: preserves the first deferred error when a later stage also fails', (t) => {
  const db = setupSyncDb();
  t.after(() => db.close());

  const result = runPostSyncStages(db, 'run_1', new Error('SimpleFIN sync failed'), {
    detectRecurring: () => { throw new Error('recurring blew up'); },
    refreshTransactionIntegrity: () => emptyIntegrity,
    takeSnapshot: () => {},
  });

  assert.equal(result.deferredError?.message, 'SimpleFIN sync failed');
});

test('runPostSyncStages: integrity failure still lets snapshot run and reports its own item', (t) => {
  const db = setupSyncDb();
  t.after(() => db.close());

  const calls: string[] = [];
  const result = runPostSyncStages(db, 'run_1', null, {
    detectRecurring: () => { calls.push('detectRecurring'); },
    refreshTransactionIntegrity: () => { calls.push('refreshTransactionIntegrity'); throw new Error('integrity blew up'); },
    takeSnapshot: () => { calls.push('takeSnapshot'); },
  });

  assert.deepEqual(calls, ['detectRecurring', 'refreshTransactionIntegrity', 'takeSnapshot']);
  assert.equal(result.deferredError?.message, 'integrity blew up');
  assert.deepEqual(result.integrity, emptyIntegrity);

  const items = db.prepare('SELECT connection_id, status FROM sync_run_items').all() as { connection_id: string; status: string }[];
  assert.equal(items.length, 1);
  assert.equal(items[0]?.connection_id, 'transaction-integrity');
  assert.equal(items[0]?.status, 'failed');
});
