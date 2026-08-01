import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import type { Response } from 'express';
import {
  addSseClient,
  emitSyncEvent,
  finalizeSyncRun,
  isSyncStale,
  reconcileBalanceChanges,
  removeSseClient,
  runPostSyncStages,
  terminalSyncEvent,
} from '../server/src/services/syncManager';
import type { SyncFinalizeDeps } from '../server/src/services/syncManager';
import type { AccountBalanceChange } from '../server/src/services/balanceChanges';
import type { TransactionIntegrityResult } from '../server/src/services/transactionIntegrity';
import type { SyncEvent } from '../shared/types';
import { migratedTestDb } from './helpers/schema';

function setupSyncDb(): Database.Database {
  const db = migratedTestDb();
  db.prepare(`
    INSERT INTO sync_runs (id, scope, status, started_at)
    VALUES ('run_1', 'full', 'running', '2026-06-30T00:00:00.000Z')
  `).run();

  return db;
}

/**
 * The provider's own run item, which exists before any of its changes are recorded:
 * `sync_changes.run_item_id` references `sync_run_items(id)`. The hand-written schema this file
 * used to build dropped that foreign key, so the balance-change tests below asserted a change row
 * pointing at a run item that never existed.
 */
function insertProviderRunItem(db: Database.Database): void {
  db.prepare(`
    INSERT INTO sync_run_items (id, run_id, provider, status, started_at)
    VALUES ('item_sf', 'run_1', 'simplefin', 'succeeded', '2026-06-30T00:00:00.000Z')
  `).run();
}

const emptyIntegrity: TransactionIntegrityResult = {
  duplicates: { groupCount: 0, transactionCount: 0, newGroupCount: 0, newTransactionCount: 0 },
  transfers: { pairCount: 0, transactionCount: 0, newPairCount: 0 },
};

test('runPostSyncStages: all stages succeed, no deferred error', (t) => {
  const db = setupSyncDb();
  t.after(() => db.close());

  const calls: string[] = [];
  const result = runPostSyncStages(db, 'run_1', null, {
    detectRecurring: () => { calls.push('detectRecurring'); },
    refreshTransactionIntegrity: () => { calls.push('refreshTransactionIntegrity'); return emptyIntegrity; },
    autoCategorizeTransactions: () => { calls.push('autoCategorizeTransactions'); return { updated: 0 }; },
    correctLiabilitySigns: () => { calls.push('correctLiabilitySigns'); return { corrections: [], unverifiable: [] }; },
    takeSnapshot: () => { calls.push('takeSnapshot'); },
  });

  assert.deepEqual(calls, ['correctLiabilitySigns', 'detectRecurring', 'refreshTransactionIntegrity', 'autoCategorizeTransactions', 'takeSnapshot']);
  assert.equal(result.deferredError, null);
  assert.deepEqual(result.integrity, emptyIntegrity);

  const items = db.prepare('SELECT * FROM sync_run_items ORDER BY connection_id').all() as { status: string; connection_id: string }[];
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((i) => i.connection_id), ['auto-categorization', 'transaction-integrity']);
  assert.ok(items.every((i) => i.status === 'succeeded'));
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
    autoCategorizeTransactions: () => { calls.push('autoCategorizeTransactions'); return { updated: 0 }; },
    correctLiabilitySigns: () => { calls.push('correctLiabilitySigns'); return { corrections: [], unverifiable: [] }; },
    takeSnapshot: () => { calls.push('takeSnapshot'); },
  });

  assert.deepEqual(calls, ['correctLiabilitySigns', 'detectRecurring', 'refreshTransactionIntegrity', 'autoCategorizeTransactions', 'takeSnapshot']);
  assert.equal(result.deferredError?.message, 'recurring blew up');
  assert.deepEqual(result.integrity, emptyIntegrity);

  const items = db.prepare('SELECT provider, connection_id, status, error_message FROM sync_run_items ORDER BY connection_id').all() as
    { provider: string; connection_id: string; status: string; error_message: string | null }[];
  assert.equal(items.length, 3);
  assert.deepEqual(items.map((i) => i.connection_id).sort(), ['auto-categorization', 'recurring-detection', 'transaction-integrity']);
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
    autoCategorizeTransactions: () => ({ updated: 0 }),
    correctLiabilitySigns: () => ({ corrections: [], unverifiable: [] }),
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
    autoCategorizeTransactions: () => { calls.push('autoCategorizeTransactions'); return { updated: 0 }; },
    correctLiabilitySigns: () => { calls.push('correctLiabilitySigns'); return { corrections: [], unverifiable: [] }; },
    takeSnapshot: () => { calls.push('takeSnapshot'); },
  });

  assert.deepEqual(calls, ['correctLiabilitySigns', 'detectRecurring', 'refreshTransactionIntegrity', 'autoCategorizeTransactions', 'takeSnapshot']);
  assert.equal(result.deferredError?.message, 'integrity blew up');
  assert.deepEqual(result.integrity, emptyIntegrity);

  const items = db.prepare('SELECT connection_id, status FROM sync_run_items ORDER BY connection_id').all() as { connection_id: string; status: string }[];
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((i) => i.connection_id), ['auto-categorization', 'transaction-integrity']);
  const integrityItem = items.find((i) => i.connection_id === 'transaction-integrity');
  assert.equal(integrityItem?.status, 'failed');
});

test('runPostSyncStages: a liability sign correction is recorded, naming both values', (t) => {
  const db = setupSyncDb();
  t.after(() => db.close());

  runPostSyncStages(db, 'run_1', null, {
    detectRecurring: () => {},
    refreshTransactionIntegrity: () => emptyIntegrity,
    autoCategorizeTransactions: () => ({ updated: 0 }),
    correctLiabilitySigns: () => ({
      corrections: [{
        account_id: 'acct_1',
        account_name: 'Discover',
        anchor_date: '2026-07-16',
        anchor_value: 8973,
        stored_balance: 56326,
        corrected_balance: -56326,
      }],
      unverifiable: [],
    }),
    takeSnapshot: () => {},
  });

  const change = db.prepare(
    "SELECT entity_id, change_type, description FROM sync_changes"
  ).get() as { entity_id: string; change_type: string; description: string } | undefined;
  // A corrected balance must never be silently different from what the provider reported.
  assert.equal(change?.entity_id, 'acct_1');
  assert.equal(change?.change_type, 'updated');
  assert.match(change?.description ?? '', /563\.26 owed/);
  assert.match(change?.description ?? '', /credit balance of \$563\.26/);
});

test('runPostSyncStages: an unverifiable liability is reported rather than passed over', (t) => {
  const db = setupSyncDb();
  t.after(() => db.close());

  runPostSyncStages(db, 'run_1', null, {
    detectRecurring: () => {},
    refreshTransactionIntegrity: () => emptyIntegrity,
    autoCategorizeTransactions: () => ({ updated: 0 }),
    correctLiabilitySigns: () => ({
      corrections: [],
      unverifiable: [{ account_id: 'acct_2', account_name: 'Amex', reason: 'no anchor' }],
    }),
    takeSnapshot: () => {},
  });

  const item = db.prepare(
    "SELECT error_message FROM sync_run_items WHERE connection_id = 'liability-sign'"
  ).get() as { error_message: string | null } | undefined;
  assert.match(item?.error_message ?? '', /Amex: no anchor/);
});

// ── The hourly re-correction loop ────────────────────────────────────────────
// A card in credit has the provider's wrong sign written over it on every sync and corrected back
// on every sync. Left alone that manufactures a balance-change row and a correction row per card
// per hour, forever, describing a swing that never happened.

const freedomFlex: AccountBalanceChange = {
  accountId: 'acct_1',
  accountName: 'Chase Freedom Flex',
  provider: 'simplefin',
  previousBalance: -283.81,
  newBalance: 283.81,
  isLiability: true,
};

const flexCorrection = {
  account_id: 'acct_1',
  account_name: 'Chase Freedom Flex',
  anchor_date: '2026-07-16',
  anchor_value: 0,
  stored_balance: 28381,
  corrected_balance: -28381,
};

test('reconcileBalanceChanges: a pure sign flip is dropped, not reported as a $567.62 swing', () => {
  assert.deepEqual(reconcileBalanceChanges([freedomFlex], [flexCorrection]), []);
});

test('reconcileBalanceChanges: a real movement under a flipped sign is restated, not dropped', () => {
  const moved: AccountBalanceChange = { ...freedomFlex, newBalance: 300 };
  const corrected = reconcileBalanceChanges([moved], [{ ...flexCorrection, stored_balance: 30000, corrected_balance: -30000 }]);
  assert.equal(corrected.length, 1);
  assert.equal(corrected[0].previousBalance, -283.81);
  assert.equal(corrected[0].newBalance, -300);
});

test('reconcileBalanceChanges: an account nobody corrected passes through untouched', () => {
  const checking: AccountBalanceChange = {
    accountId: 'acct_9',
    accountName: 'Chase Checking',
    provider: 'simplefin',
    previousBalance: 1000,
    newBalance: 1200,
    isLiability: false,
  };
  assert.deepEqual(reconcileBalanceChanges([checking], [flexCorrection]), [checking]);
});

test('runPostSyncStages: a settled card produces no rows at all on the next sync', (t) => {
  const db = setupSyncDb();
  t.after(() => db.close());
  insertProviderRunItem(db);

  runPostSyncStages(db, 'run_1', null, {
    detectRecurring: () => {},
    refreshTransactionIntegrity: () => emptyIntegrity,
    autoCategorizeTransactions: () => ({ updated: 0 }),
    correctLiabilitySigns: () => ({ corrections: [flexCorrection], unverifiable: [] }),
    takeSnapshot: () => {},
  }, [{ runItemId: 'item_sf', changes: [freedomFlex] }]);

  const changes = db.prepare('SELECT COUNT(*) AS n FROM sync_changes').get() as { n: number };
  assert.equal(changes.n, 0, 'the card was already corrected before this sync; nothing happened to it');
  const signItem = db.prepare(
    "SELECT COUNT(*) AS n FROM sync_run_items WHERE connection_id = 'liability-sign'"
  ).get() as { n: number };
  assert.equal(signItem.n, 0);
});

test('runPostSyncStages: a correction the ledger has not seen before is still reported', (t) => {
  const db = setupSyncDb();
  t.after(() => db.close());

  // The provider reported the same wrong figure it reported last time, so there is no balance
  // change to reconcile against, and the pre-sync balance is the wrong one.
  runPostSyncStages(db, 'run_1', null, {
    detectRecurring: () => {},
    refreshTransactionIntegrity: () => emptyIntegrity,
    autoCategorizeTransactions: () => ({ updated: 0 }),
    correctLiabilitySigns: () => ({ corrections: [flexCorrection], unverifiable: [] }),
    takeSnapshot: () => {},
  }, []);

  const changes = db.prepare('SELECT COUNT(*) AS n FROM sync_changes').get() as { n: number };
  assert.equal(changes.n, 1);
});

test('runPostSyncStages: provider balance changes still reach the panel when nothing was corrected', (t) => {
  const db = setupSyncDb();
  t.after(() => db.close());
  insertProviderRunItem(db);

  runPostSyncStages(db, 'run_1', null, {
    detectRecurring: () => {},
    refreshTransactionIntegrity: () => emptyIntegrity,
    autoCategorizeTransactions: () => ({ updated: 0 }),
    correctLiabilitySigns: () => ({ corrections: [], unverifiable: [] }),
    takeSnapshot: () => {},
  }, [{ runItemId: 'item_sf', changes: [freedomFlex] }]);

  const change = db.prepare('SELECT run_item_id, entity_id FROM sync_changes').get() as
    { run_item_id: string; entity_id: string } | undefined;
  assert.equal(change?.run_item_id, 'item_sf', 'a change belongs to the provider item that produced it');
  assert.equal(change?.entity_id, 'acct_1');
});

// ── Terminal event ───────────────────────────────────────────────────────────
// A partial run has already committed provider writes by the time a later stage fails. It used to
// throw before emitting anything, so the client saw only sync_error, did not invalidate its caches,
// and kept rendering pre-sync figures under a header still claiming the previous sync time.

test('a partial run ends in a terminal completion event that carries the failure', () => {
  const event = terminalSyncEvent(new Error('FOREIGN KEY constraint failed'), '2026-07-30T12:00:00.000Z');

  assert.equal(event.type, 'sync_complete', 'the client acts on completions, not on errors');
  assert.equal(event.status, 'partial');
  assert.equal(event.completedAt, '2026-07-30T12:00:00.000Z');
  assert.match(event.message, /FOREIGN KEY constraint failed/);
  assert.equal(event.progress, 100);
});

test('a clean run ends in the same event marked succeeded', () => {
  const event = terminalSyncEvent(null, '2026-07-30T12:00:00.000Z');

  assert.equal(event.type, 'sync_complete');
  assert.equal(event.status, 'succeeded');
  assert.equal(event.message, 'Sync complete');
});

// ── The AI pass a failed stage used to cost ──────────────────────────────────
// The trigger sat after `if (deferredError) throw`, so a sync where one stage failed never got a
// review pass. On the owner's own history that is 10 runs: SELECT status, COUNT(*) FROM sync_runs
// GROUP BY status, on a copy of .mizan/mizan.db, 2026-07-31, returns succeeded 98, partial 10,
// failed 4, running 5, and a run is marked 'partial' only after it has recorded its outcome.

interface FinalizeSpy {
  order: string[];
  events: SyncEvent[];
  triggered: string[];
  // Not `Parameters<typeof finalizeSyncRun>[2]`: that argument is optional, so the derived type
  // includes `undefined` and every `spy.deps.x = ...` below reads as possibly-unset. The spy always
  // supplies all three.
  deps: SyncFinalizeDeps;
}

function finalizeSpy(): FinalizeSpy {
  const spy: FinalizeSpy = {
    order: [],
    events: [],
    triggered: [],
    deps: {
      emit: () => {},
      triggerAiJobs: () => {},
      now: () => '2026-07-30T12:00:00.000Z',
    },
  };
  spy.deps = {
    emit: (event) => { spy.order.push(`emit:${event.type}`); spy.events.push(event); },
    triggerAiJobs: (syncRunId) => { spy.order.push('trigger'); spy.triggered.push(syncRunId); },
    now: () => '2026-07-30T12:00:00.000Z',
  };
  return spy;
}

test('finalizeSyncRun: a partial run still fires the AI pass, and still rethrows', () => {
  const spy = finalizeSpy();

  assert.throws(
    () => finalizeSyncRun('run_1', new Error('auto-categorization failed'), spy.deps),
    /auto-categorization failed/
  );

  assert.deepEqual(spy.triggered, ['run_1'], 'a stage failing is when a review pass is most useful');
  assert.equal(spy.events[0].status, 'partial');
});

test('finalizeSyncRun: a clean run fires it exactly once, after the terminal event', () => {
  const spy = finalizeSpy();

  finalizeSyncRun('run_1', null, spy.deps);

  // Order is load-bearing: the client drops its caches on sync_complete, so a pass that wrote
  // before that event would have its writes overwritten on screen by the refresh that follows it.
  assert.deepEqual(spy.order, ['emit:sync_complete', 'trigger']);
  assert.deepEqual(spy.triggered, ['run_1']);
});

test('finalizeSyncRun: a trigger that throws does not replace the run\'s own failure', () => {
  const spy = finalizeSpy();
  spy.deps.triggerAiJobs = () => { throw new Error('scheduler exploded'); };

  // A throw out of a `finally` replaces whatever the block was throwing. The real trigger is
  // written not to throw; this is what happens on the day that stops being true.
  assert.throws(
    () => finalizeSyncRun('run_1', new Error('SimpleFIN sync failed'), spy.deps),
    /SimpleFIN sync failed/
  );
});

function fakeSseClient(): { res: Response; frames: string[] } {
  const frames: string[] = [];
  const res = {
    write(chunk: string): boolean {
      frames.push(chunk);
      return true;
    },
  };
  return { res: res as unknown as Response, frames };
}

test('the partial terminal event actually reaches a connected SSE client', (t) => {
  const client = fakeSseClient();
  addSseClient(client.res);
  t.after(() => removeSseClient(client.res));

  emitSyncEvent(terminalSyncEvent(new Error('auto-categorization failed'), '2026-07-30T12:00:00.000Z'));

  assert.equal(client.frames.length, 1);
  const parsed = JSON.parse(client.frames[0].replace(/^data: /, '').trim()) as SyncEvent;
  assert.equal(parsed.type, 'sync_complete');
  assert.equal(parsed.status, 'partial');
  assert.match(parsed.message, /auto-categorization failed/);
});

const setupConnectionsDb = migratedTestDb;

test('isSyncStale: no configured connections at all is not considered stale (nothing to sync)', (t) => {
  const db = setupConnectionsDb();
  t.after(() => db.close());
  assert.equal(isSyncStale(db, 10), false);
});

test('isSyncStale: a connection that has never synced is stale', (t) => {
  const db = setupConnectionsDb();
  t.after(() => db.close());
  db.prepare(`INSERT INTO simplefin_connections (id, last_synced_at, created_at) VALUES ('c1', NULL, '2026-06-30T00:00:00.000Z')`).run();
  assert.equal(isSyncStale(db, 10), true);
});

test('isSyncStale: a recent sync within the threshold is not stale', (t) => {
  const db = setupConnectionsDb();
  t.after(() => db.close());
  db.prepare(`INSERT INTO simplefin_connections (id, last_synced_at, created_at) VALUES ('c1', ?, '2026-06-30T00:00:00.000Z')`).run(new Date(Date.now() - 2 * 60_000).toISOString());
  assert.equal(isSyncStale(db, 10), false);
});

test('isSyncStale: a sync older than the threshold is stale', (t) => {
  const db = setupConnectionsDb();
  t.after(() => db.close());
  db.prepare(`INSERT INTO simplefin_connections (id, last_synced_at, created_at) VALUES ('c1', ?, '2026-06-30T00:00:00.000Z')`).run(new Date(Date.now() - 20 * 60_000).toISOString());
  assert.equal(isSyncStale(db, 10), true);
});

test('isSyncStale: any one stale connection makes the whole thing stale, even if another is fresh', (t) => {
  const db = setupConnectionsDb();
  t.after(() => db.close());
  db.prepare(`INSERT INTO simplefin_connections (id, last_synced_at, created_at) VALUES ('c1', ?, '2026-06-30T00:00:00.000Z')`).run(new Date(Date.now() - 1 * 60_000).toISOString());
  db.prepare(`INSERT INTO coinbase_connections (id, coinbase_user_id, last_synced_at, created_at) VALUES ('c2', 'cb_user', ?, '2026-06-30T00:00:00.000Z')`).run(new Date(Date.now() - 20 * 60_000).toISOString());
  assert.equal(isSyncStale(db, 10), true);
});
