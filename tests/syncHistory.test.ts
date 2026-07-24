import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  startSyncRun,
  recordSyncRunItem,
  recordSyncChange,
  finishSyncRun,
  getSyncRunDetail,
  listSyncRuns,
} from '../server/src/services/syncHistory';

function setupDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE sync_runs (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL, status TEXT NOT NULL,
      started_at TEXT NOT NULL, completed_at TEXT, message TEXT,
      error_code TEXT, error_message TEXT, recovery_action TEXT,
      accounts_seen INTEGER DEFAULT 0, transactions_added INTEGER DEFAULT 0,
      transactions_modified INTEGER DEFAULT 0, transactions_removed INTEGER DEFAULT 0,
      transactions_skipped INTEGER DEFAULT 0, duplicate_candidates INTEGER DEFAULT 0,
      transfer_candidates INTEGER DEFAULT 0
    );
    CREATE TABLE sync_run_items (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, provider TEXT NOT NULL,
      connection_id TEXT, institution_name TEXT, status TEXT NOT NULL,
      started_at TEXT NOT NULL, completed_at TEXT,
      accounts_seen INTEGER DEFAULT 0, transactions_added INTEGER DEFAULT 0,
      transactions_modified INTEGER DEFAULT 0, transactions_removed INTEGER DEFAULT 0,
      transactions_skipped INTEGER DEFAULT 0, error_code TEXT, error_message TEXT,
      recovery_action TEXT
    );
    CREATE TABLE sync_changes (
      id TEXT PRIMARY KEY, run_item_id TEXT NOT NULL, entity_type TEXT NOT NULL,
      entity_id TEXT, change_type TEXT NOT NULL, description TEXT NOT NULL, created_at TEXT NOT NULL
    );
  `);
  return db;
}

test('a sync run aggregates per-item transaction counts on finish', (t) => {
  const db = setupDb();
  t.after(() => db.close());

  const run = startSyncRun(db, 'full', 'manual sync');
  assert.equal(run.status, 'running');

  recordSyncRunItem(db, run.id, {
    provider: 'simplefin', institution_name: 'BofA', status: 'succeeded',
    transactions_added: 10, accounts_seen: 3,
  });
  recordSyncRunItem(db, run.id, {
    provider: 'coinbase', institution_name: 'Coinbase', status: 'succeeded',
    transactions_added: 5, accounts_seen: 1,
  });

  // finishSyncRun sums the item counts when the run-level count isn't given explicitly.
  const finished = finishSyncRun(db, run.id, { status: 'succeeded' });
  assert.equal(finished.status, 'succeeded');
  assert.equal(finished.transactions_added, 15);
  assert.equal(finished.accounts_seen, 4);
  assert.ok(finished.completed_at);
});

test('getSyncRunDetail returns the run with its items and changes', (t) => {
  const db = setupDb();
  t.after(() => db.close());

  const run = startSyncRun(db, 'full');
  const item = recordSyncRunItem(db, run.id, {
    provider: 'simplefin', institution_name: 'Chase', status: 'succeeded', transactions_added: 2,
  });
  recordSyncChange(db, item.id, {
    entity_type: 'transaction', entity_id: 'txn_1', change_type: 'inserted', description: 'New coffee purchase',
  });
  finishSyncRun(db, run.id, { status: 'succeeded' });

  const detail = getSyncRunDetail(db, run.id);
  assert.equal(detail.items.length, 1);
  assert.equal(detail.items[0].institution_name, 'Chase');
  assert.equal(detail.changes.length, 1);
  assert.equal(detail.changes[0].entity_id, 'txn_1');
});

test('listSyncRuns returns runs newest-first', (t) => {
  const db = setupDb();
  t.after(() => db.close());

  const a = startSyncRun(db, 'full');
  db.prepare("UPDATE sync_runs SET started_at = '2026-01-01T00:00:00Z' WHERE id = ?").run(a.id);
  const b = startSyncRun(db, 'full');
  db.prepare("UPDATE sync_runs SET started_at = '2026-02-01T00:00:00Z' WHERE id = ?").run(b.id);

  const runs = listSyncRuns(db);
  assert.equal(runs[0].id, b.id, 'most recent first');
  assert.equal(runs[1].id, a.id);
});
