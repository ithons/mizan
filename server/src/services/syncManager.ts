import type { Response } from 'express';
import type Database from 'better-sqlite3';
import type { SyncEvent, SyncRunItem, SyncRunItemStatus } from '../../../shared/types';
import { syncCoinbase } from './coinbase';
import {
  classifySimplefinFailure,
  syncSimplefin,
  triageSimplefinErrors,
  type SimplefinSyncResult,
} from './simplefin';
import type { RelinkSyncBlock } from './simplefinRelink';
import { detectRecurring } from './recurring';
import { autoCategorizeTransactions } from './rules';
import { reconcileReconstructedHistory, takeSnapshot, type ReconstructionRun } from './snapshot';
import { getCredentials, credentialsUnreadable } from './credentials';
import { getDb } from '../db/index';
import {
  finishSyncRun,
  recordSyncChange,
  recordSyncRunItem,
  startSyncRun,
} from './syncHistory';
import { refreshTransactionIntegrity, type TransactionIntegrityResult } from './transactionIntegrity';
import { hasRolloverBudgets, recordBudgetRolloverLedger } from './budgetProjection';
import {
  correctLiabilitySigns,
  describeLiabilitySignCorrection,
  type LiabilitySignCorrection,
  type LiabilitySignReport,
} from './liabilitySign';
import { describeBalanceChange, type AccountBalanceChange } from './balanceChanges';
import { toCents, toDollars } from './money';
import { triggerAfterSyncAiJobs } from './aiScheduler';
import { withRetry } from './retry';

// SSE clients registry
const sseClients = new Set<Response>();
let _activeSyncPromise: Promise<void> | null = null;
let _lastSyncEvent: SyncEvent | null = null;

export function addSseClient(res: Response): void {
  sseClients.add(res);
  if (_activeSyncPromise && _lastSyncEvent) {
    try {
      res.write(`data: ${JSON.stringify(_lastSyncEvent)}\n\n`);
    } catch {
      sseClients.delete(res);
    }
  }
}

export function removeSseClient(res: Response): void {
  sseClients.delete(res);
}

export function emitSyncEvent(event: SyncEvent): void {
  _lastSyncEvent = event;
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      // Client disconnected
      sseClients.delete(client);
    }
  }
}



/**
 * The one event that ends a run, whether or not the run succeeded.
 *
 * A partial run has already committed provider writes by the time a later stage fails, so it has to
 * reach the client as a completion the client will act on. Emitting only `sync_error` left Today,
 * Accounts, Budget and Reports rendering pre-sync figures for the whole 5-minute staleTime under a
 * header still claiming the previous sync time: run 888332de wrote 111 changed transactions and
 * then auto-categorization threw 'FOREIGN KEY constraint failed'. A failed sync can still have
 * committed writes, so the failure travels inside the completion rather than instead of it.
 */
export function terminalSyncEvent(deferredError: Error | null, completedAt: string): SyncEvent {
  if (!deferredError) {
    return { type: 'sync_complete', message: 'Sync complete', progress: 100, completedAt, status: 'succeeded' };
  }
  return {
    type: 'sync_complete',
    message: `Sync finished with issues: ${deferredError.message}`,
    progress: 100,
    completedAt,
    status: 'partial',
  };
}

export interface SyncFinalizeDeps {
  emit: (event: SyncEvent) => void;
  triggerAiJobs: (syncRunId: string, emit: (event: SyncEvent) => void) => void;
  now: () => string;
}

const defaultFinalizeDeps: SyncFinalizeDeps = {
  emit: emitSyncEvent,
  triggerAiJobs: (syncRunId, emit) => triggerAfterSyncAiJobs({ syncRunId, emit }),
  now: () => new Date().toISOString(),
};

/**
 * End a run: tell the client, then fire the AI pass, then let a partial run's failure out.
 *
 * The trigger sitting in the `finally` is the whole reason this is a function. It used to sit
 * after `if (deferredError) throw`, so the one kind of sync that never got a review pass was a
 * sync where a stage had failed, which is the kind most worth reviewing. Measured on a copy of
 * .mizan/mizan.db, 2026-07-31: `SELECT status, COUNT(*) FROM sync_runs GROUP BY status` returns
 * succeeded 98, partial 10, failed 4, running 5, and 'partial' is written only here, so each of
 * those 10 runs reached the kickoff and stepped over it.
 *
 * A run that dies before reaching here (the credential store or the database is unavailable) gets
 * no pass, deliberately: nothing was written for a pass to review.
 */
export function finalizeSyncRun(
  syncRunId: string,
  deferredError: Error | null,
  deps: SyncFinalizeDeps = defaultFinalizeDeps
): void {
  try {
    deps.emit(terminalSyncEvent(deferredError, deps.now()));
    if (deferredError) throw deferredError;
  } finally {
    try {
      deps.triggerAiJobs(syncRunId, deps.emit);
    } catch (err) {
      // A throw from a `finally` replaces whatever the block was already throwing, and what it is
      // already throwing here is the sync's own failure: the one error the caller must not lose.
      console.error('[sync] Could not fire the after-sync AI jobs:', err);
    }
  }
}

export interface PostSyncStageFns {
  detectRecurring: () => void;
  refreshTransactionIntegrity: (db: Database.Database) => TransactionIntegrityResult;
  autoCategorizeTransactions: (db: Database.Database) => { updated: number };
  correctLiabilitySigns: (db: Database.Database) => LiabilitySignReport;
  takeSnapshot: () => void;
}

const defaultPostSyncStages: PostSyncStageFns = {
  detectRecurring,
  refreshTransactionIntegrity,
  autoCategorizeTransactions,
  correctLiabilitySigns: (db) => correctLiabilitySigns(db, new Date().toISOString()),
  takeSnapshot,
};

/** What the reconstruction found, in the words the sync panel shows the owner. */
export function describeReconstruction(run: ReconstructionRun): string {
  const reach = run.oldestReconstructed
    ? `back to ${run.oldestReconstructed}`
    : 'and the ledger now justifies none';
  const cause: Record<NonNullable<ReconstructionRun['trigger']>, string> = {
    no_ledger: 'nothing holding value has ledger history left',
    floor_raised: 'replayed months sat below what the ledger can now justify',
    unreachable_estimates: 'replayed rows sat outside the months the replay can revisit',
    never_reconstructed: 'the ledger had never been replayed',
    ledger_window_moved: 'the ledger reaches a different month than the last replay used',
    balances_moved: 'the balances the replay starts from have been written since',
  };
  const because = run.trigger ? cause[run.trigger] : 'rebuilt on request';
  return `${run.reconstructed} reconstructed month(s) ${reach}: ${because}.`;
}

/** The one sentence a reauth-shaped provider message earns, in one place because two paths use it. */
const SIMPLEFIN_REAUTH_RECOVERY =
  'Reconnect SimpleFIN in Settings to restore access for the affected institution.';

/**
 * What a SimpleFIN stage that refused to write puts on its run item.
 *
 * Derived from the block the way `classifySimplefinFailure` derives its advice from the HTTP
 * status, rather than being a sentence written here: the headline and the recovery action come from
 * `RELINK_OUTCOMES`, and every count is one the guard produced. The "wrote nothing" clause is a
 * property of the code path rather than a reassurance: `applySimplefinResponse` returns above its
 * first write, so the account loop, the transaction upserts and `zeroAccountsMissingFromResponse`
 * are all unreached. `tests/simplefinRelinkGate.test.ts` holds that shape to the schema.
 */
export function describeRelinkBlock(block: RelinkSyncBlock): string {
  return [
    block.headline,
    `${block.pairCount} pairing(s) proposed, ${block.unpairedStoredCount} stored account(s) and ` +
      `${block.unpairedProviderCount} provider account(s) left unpaired.`,
    'Nothing was written this pass: no account was added, updated or zeroed, and no transaction was recorded.',
  ].join(' ');
}

export interface SimplefinStageRecord {
  runItem: SyncRunItem;
  /** What the connection row was left at. Never 'sync_error' here: this path is the non-throwing one. */
  connectionStatus: 'active' | 'reauth_required';
  /** True exactly when the pass wrote nothing because a re-link is pending. */
  blocked: boolean;
}

/**
 * Record what a completed SimpleFIN call did, including the case where it deliberately did nothing.
 *
 * Extracted from `_runFullSyncInternal` so this can be driven against a migrated database: the
 * property worth a regression test is that a blocked pass is recorded as a skip naming where to
 * resolve it, and that an ordinary pass is recorded exactly as it was before.
 *
 * SimpleFIN reports per-institution problems (e.g. reauth needed) inside a successful HTTP
 * response's `errors` array rather than as an HTTP failure, so a sync can return fewer/no accounts
 * for an affected institution while still "succeeding" unless this is surfaced explicitly. Only the
 * auth-shaped messages may claim reauth: the same array also carries advisories, and telling the
 * owner their institution login had expired over "Requested date range exceeds limit of 90 days and
 * was capped." pointed them at re-linking the bank, the riskiest action available.
 */
export function recordSimplefinStage(
  db: Database.Database,
  runId: string,
  result: SimplefinSyncResult
): SimplefinStageRecord {
  const triage = triageSimplefinErrors(result.errors);
  const needsReauth = triage.reauth.length > 0;
  const providerMessages = [...triage.reauth, ...triage.advisories];
  const relink: RelinkSyncBlock | null = result.relinkBlock;

  // Persist reauth state onto the connection so sync-health (and the per-account badges) reflect
  // it; a clean sync clears it back to active.
  //
  // A pending re-link takes this same derivation and deliberately not a status of its own.
  // Everything the connection is answerable for worked: the stored access URL authenticated, the
  // bridge answered, and a full account list parsed. Leaving a previous `sync_error` standing
  // instead would keep telling the owner to act on a failure this very response disproved, which is
  // the 402-then-renew sequence that produced the incident. What is NOT claimed is freshness:
  // `applySimplefinResponse` returns without advancing `last_synced_at`, so sync-health keeps
  // ageing this connection off its last real pull for as long as the block stands.
  const connectionStatus = needsReauth ? 'reauth_required' : 'active';
  db.prepare(`UPDATE simplefin_connections SET status = ? WHERE id = 'simplefin_primary' AND status != 'removed'`)
    .run(connectionStatus);

  // 'skipped' rather than 'failed' or 'reauth_required'. Nothing failed: the provider answered and
  // the response parsed, so 'failed' would be a claim about SimpleFIN that nothing here checked. No
  // login expired either, and 'reauth_required' points the owner at re-linking the bank, which is
  // the action that mints new ids and caused this in the first place. The stage declined to run and
  // says where to settle it, which is what 'skipped' means.
  const status: SyncRunItemStatus = relink
    ? relink.syncRunItemStatus
    : needsReauth ? 'reauth_required' : 'succeeded';
  const messages = relink ? [describeRelinkBlock(relink), ...providerMessages] : providerMessages;
  // Both sentences, when both apply: a re-link blocks every institution and an expired login blocks
  // one, and dropping either would leave the owner acting on half of what is standing.
  const recovery = [
    relink ? relink.recoveryAction : null,
    needsReauth ? SIMPLEFIN_REAUTH_RECOVERY : null,
  ].filter((sentence): sentence is string => sentence !== null);

  const runItem = recordSyncRunItem(db, runId, {
    provider: 'simplefin',
    connection_id: 'simplefin_primary',
    institution_name: 'SimpleFIN',
    status,
    accounts_seen: result.accountCount,
    transactions_added: result.added,
    transactions_modified: result.modified,
    transactions_removed: result.removed,
    transactions_skipped: result.skipped,
    error_code: relink ? relink.errorCode : undefined,
    // Advisories still get reported on the item, which the sync panel renders whatever the item's
    // status is; what they no longer do is set that status.
    error_message: messages.length > 0 ? messages.join('; ') : undefined,
    recovery_action: recovery.length > 0 ? recovery.join(' ') : undefined,
  });

  return { runItem, connectionStatus, blocked: relink !== null };
}

export interface PostSyncStagesResult {
  integrity: TransactionIntegrityResult;
  deferredError: Error | null;
}

/** A provider's balance changes, held back until the liability signs have been settled. */
export interface PendingBalanceChanges {
  runItemId: string;
  changes: AccountBalanceChange[];
}

/**
 * Drop or restate the balance changes that a sign correction is about to undo.
 *
 * A liability whose provider reports its credit as debt gets that wrong number written every hour,
 * so `balancesDiffer` sees -$283.81 becoming +$283.81 and the panel reports a $567.62 swing that
 * never happened. A sign correction is not a balance change: where the corrected value equals what
 * was there before the sync, the account did not move and there is nothing to report.
 */
export function reconcileBalanceChanges(
  changes: AccountBalanceChange[],
  corrections: LiabilitySignCorrection[]
): AccountBalanceChange[] {
  if (corrections.length === 0) return changes;

  const correctedDollars = new Map(
    corrections.map((correction) => [correction.account_id, toDollars(correction.corrected_balance)])
  );

  const kept: AccountBalanceChange[] = [];
  for (const change of changes) {
    const corrected = correctedDollars.get(change.accountId);
    if (corrected === undefined) {
      kept.push(change);
      continue;
    }
    if (corrected === change.previousBalance) continue;
    kept.push({ ...change, newBalance: corrected });
  }
  return kept;
}

/**
 * What each account held before this sync started, for the accounts a provider moved.
 *
 * A correction's `stored_balance` is what the provider wrote moments ago, not what the ledger had
 * been carrying, so it cannot answer "is this news?" on its own.
 */
function preSyncBalanceCents(pending: PendingBalanceChanges[]): Map<string, number> {
  const balances = new Map<string, number>();
  for (const group of pending) {
    for (const change of group.changes) {
      balances.set(change.accountId, toCents(change.previousBalance));
    }
  }
  return balances;
}

// Each stage (recurring detection, integrity refresh, snapshot) gets its own try/catch
// so a failure in one doesn't skip the others or mask an otherwise-successful provider sync.
export function runPostSyncStages(
  db: Database.Database,
  runId: string,
  deferredError: Error | null,
  stages: PostSyncStageFns = defaultPostSyncStages,
  pendingBalanceChanges: PendingBalanceChanges[] = []
): PostSyncStagesResult {
  let nextDeferredError = deferredError;

  // FIRST, ahead of every other post-sync stage: the providers have just overwritten
  // `accounts.current_balance` with a figure whose direction may be wrong, and every stage after
  // this one reads that column. Correcting it here keeps the window in which the ledger disagrees
  // with itself as short as it can be, and lets the provider's balance changes be reconciled
  // against the corrections before either is reported.
  emitSyncEvent({ type: 'sync_progress', message: 'Verifying liability balances...', progress: 72 });
  let corrections: LiabilitySignCorrection[] = [];
  try {
    const signs = stages.correctLiabilitySigns(db);
    corrections = signs.corrections;

    // Only what changed. An account that was already sitting corrected, had the provider's wrong
    // sign written over it and got corrected back has nothing to say, and saying it hourly forever
    // is how a panel stops being read.
    const preSync = preSyncBalanceCents(pendingBalanceChanges);
    const news = corrections.filter(
      (correction) =>
        (preSync.get(correction.account_id) ?? correction.stored_balance) !== correction.corrected_balance
    );

    // The same de-duplication `news` already gets, applied to the other half of this stage.
    //
    // `news` filters corrections to the ones that actually changed, on the stated reasoning that
    // saying an unchanged thing "hourly forever is how a panel stops being read". The unverifiable
    // list was exempt from that and re-filed an identical row on every sync. Its only silence
    // condition is a PENDING row in flight, and this feed has never produced one: `SELECT pending,
    // COUNT(*) FROM transactions GROUP BY 1` returns `0|2734` on the live ledger, so the branch
    // that suppresses a doubt cannot be reached. Measured before this change: 21 recorded items
    // between 2026-07-30 and 2026-08-31 carrying 5 distinct messages.
    //
    // Compared against the last message this stage filed rather than against a fixed window, so a
    // finding that goes away and comes back is reported again, and one that merely persists is not.
    const unverifiableMessage = signs.unverifiable.length > 0
      ? signs.unverifiable.map((a) => `${a.account_name ?? a.account_id}: ${a.reason}`).join('; ')
      : undefined;
    const lastFiled = db.prepare(`
      SELECT error_message FROM sync_run_items
      WHERE connection_id = 'liability-sign'
      ORDER BY completed_at DESC, rowid DESC
      LIMIT 1
    `).get() as { error_message: string | null } | undefined;
    const unverifiableIsNew = unverifiableMessage !== undefined
      && unverifiableMessage !== (lastFiled?.error_message ?? null);

    if (news.length > 0 || unverifiableIsNew) {
      const signItem = recordSyncRunItem(db, runId, {
        provider: 'system',
        connection_id: 'liability-sign',
        institution_name: 'Liability balance direction',
        status: 'succeeded',
        error_message: unverifiableMessage,
      });
      // A corrected balance is never silently different from what the provider said.
      for (const correction of news) {
        recordSyncChange(db, signItem.id, {
          entity_type: 'account',
          entity_id: correction.account_id,
          change_type: 'updated',
          description: describeLiabilitySignCorrection(correction),
        });
      }
    }
  } catch (err) {
    const message = (err as Error).message || 'Liability balance verification failed';
    recordSyncRunItem(db, runId, {
      provider: 'system',
      connection_id: 'liability-sign',
      institution_name: 'Liability balance direction',
      status: 'failed',
      error_message: message,
      recovery_action: 'Retry sync. Liability balance direction will be checked again next sync.',
    });
    nextDeferredError = nextDeferredError ?? new Error(message);
  }

  for (const group of pendingBalanceChanges) {
    for (const change of reconcileBalanceChanges(group.changes, corrections)) {
      recordSyncChange(db, group.runItemId, {
        entity_type: 'account',
        entity_id: change.accountId,
        change_type: 'updated',
        description: describeBalanceChange(change),
      });
    }
  }

  emitSyncEvent({ type: 'sync_progress', message: 'Detecting recurring transactions...', progress: 75 });
  try {
    stages.detectRecurring();
  } catch (err) {
    const message = (err as Error).message || 'Recurring detection failed';
    recordSyncRunItem(db, runId, {
      provider: 'system',
      connection_id: 'recurring-detection',
      institution_name: 'Recurring detection',
      status: 'failed',
      error_message: message,
      recovery_action: 'Retry sync. Recurring pattern detection will run again next sync.',
    });
    nextDeferredError = nextDeferredError ?? new Error(message);
  }

  let integrity: TransactionIntegrityResult = {
    duplicates: { groupCount: 0, transactionCount: 0, newGroupCount: 0, newTransactionCount: 0 },
    transfers: { pairCount: 0, transactionCount: 0, newPairCount: 0 },
  };
  try {
    integrity = stages.refreshTransactionIntegrity(db);
    const integrityItem = recordSyncRunItem(db, runId, {
      provider: 'system',
      connection_id: 'transaction-integrity',
      institution_name: 'Transaction integrity',
      status: 'succeeded',
    });
    // A `detected` row is an event, so it is written for what THIS run found. Emitting on the
    // standing count instead meant an unresolved candidate rewrote the same row every hour and the
    // panel's history filled with a finding the owner had already seen and could only silence by
    // resolving it. The standing counts still reach `sync_runs` below, where they describe state.
    // Emitted on the transaction count, not the group count, because that is the grain the
    // detector can promise exactly once: a copy joining a group the owner already resolved nothing
    // about is a row they have not seen, and it does not make the group new.
    if (integrity.duplicates.newTransactionCount > 0) {
      const { newTransactionCount, newGroupCount } = integrity.duplicates;
      recordSyncChange(db, integrityItem.id, {
        entity_type: 'integrity',
        entity_id: null,
        change_type: 'detected',
        description:
          `${newTransactionCount} transaction(s) newly flagged as possible duplicates, ` +
          `in ${newGroupCount} group(s)`,
      });
    }
    if (integrity.transfers.newPairCount > 0) {
      recordSyncChange(db, integrityItem.id, {
        entity_type: 'integrity',
        entity_id: null,
        change_type: 'detected',
        description: `${integrity.transfers.newPairCount} new transfer pair(s) need review`,
      });
    }
  } catch (err) {
    const message = (err as Error).message || 'Transaction integrity check failed';
    recordSyncRunItem(db, runId, {
      provider: 'system',
      connection_id: 'transaction-integrity',
      institution_name: 'Transaction integrity',
      status: 'failed',
      error_message: message,
      recovery_action: 'Retry sync. Duplicate/transfer detection will run again next sync.',
    });
    nextDeferredError = nextDeferredError ?? new Error(message);
  }

  emitSyncEvent({ type: 'sync_progress', message: 'Categorizing transactions...', progress: 85 });
  try {
    const result = stages.autoCategorizeTransactions(db);
    recordSyncRunItem(db, runId, {
      provider: 'system',
      connection_id: 'auto-categorization',
      institution_name: 'Auto-categorization',
      status: 'succeeded',
      transactions_modified: result.updated,
    });
  } catch (err) {
    const message = (err as Error).message || 'Auto-categorization failed';
    recordSyncRunItem(db, runId, {
      provider: 'system',
      connection_id: 'auto-categorization',
      institution_name: 'Auto-categorization',
      status: 'failed',
      error_message: message,
      recovery_action: 'Retry sync. Auto-categorization will run again next sync.',
    });
    nextDeferredError = nextDeferredError ?? new Error(message);
  }

  emitSyncEvent({ type: 'sync_progress', message: 'Taking net worth snapshot...', progress: 90 });
  try {
    stages.takeSnapshot();
  } catch (err) {
    const message = (err as Error).message || 'Snapshot failed';
    recordSyncRunItem(db, runId, {
      provider: 'system',
      connection_id: 'net-worth-snapshot',
      institution_name: 'Net worth snapshot',
      status: 'failed',
      error_message: message,
      recovery_action: 'Retry sync. A snapshot will be taken again next sync.',
    });
    nextDeferredError = nextDeferredError ?? new Error(message);
  }

  return { integrity, deferredError: nextDeferredError };
}

// Callers that need to mutate connection state right before triggering a sync (e.g. a
// forced resync nulling last_synced_at) must check this first: runFullSync() silently
// reuses the in-flight promise when a sync is already running, so a mutation made after
// that in-flight sync already read the old state would have no effect on it.
export function isSyncActive(): boolean {
  return _activeSyncPromise !== null;
}

export async function runFullSync(): Promise<void> {
  if (_activeSyncPromise) {
    console.log('[sync] Full sync already in progress, returning existing promise');
    return _activeSyncPromise;
  }

  _activeSyncPromise = _runFullSyncInternal().finally(() => {
    _activeSyncPromise = null;
    _lastSyncEvent = null;
  });

  return _activeSyncPromise;
}

let _schedulerHandle: NodeJS.Timeout | null = null;

// Overlapping ticks are safe: runFullSync() already guards against concurrent
// runs via _activeSyncPromise, so a tick firing mid-sync just no-ops.
export function startSyncScheduler(intervalMinutes: number): void {
  if (_schedulerHandle) return;
  _schedulerHandle = setInterval(() => {
    runFullSync().catch((err) => {
      console.error('[scheduler] Sync failed:', (err as Error).message);
    });
  }, intervalMinutes * 60_000);
}

export function stopSyncScheduler(): void {
  if (_schedulerHandle) clearInterval(_schedulerHandle);
  _schedulerHandle = null;
}

// Used to gate startup sync: `tsx watch` (npm run dev) restarts the whole process on
// every file save, so firing a full sync unconditionally on every boot would mean a
// real SimpleFIN + Coinbase + AI-worker sync on every single save while coding. Only
// treat the server as needing a fresh pull if every configured connection's last sync
// is older than the threshold (or has never synced).
export function isSyncStale(db: Database.Database, thresholdMinutes: number): boolean {
  const connections = db.prepare(`
    SELECT last_synced_at FROM simplefin_connections WHERE status = 'active'
    UNION ALL
    SELECT last_synced_at FROM coinbase_connections WHERE status = 'active'
  `).all() as Array<{ last_synced_at: string | null }>;

  if (connections.length === 0) return false;

  const thresholdMs = thresholdMinutes * 60_000;
  const now = Date.now();
  return connections.some((c) => {
    if (!c.last_synced_at) return true;
    return now - new Date(c.last_synced_at).getTime() > thresholdMs;
  });
}

async function _runFullSyncInternal(): Promise<void> {
  const db = getDb();
  const run = startSyncRun(db, 'full', 'Full sync started');
  let finished = false;
  let deferredError: Error | null = null;

  emitSyncEvent({ type: 'sync_start', message: 'Starting full sync...' });

  // Held until the liability signs are settled: a balance the provider reported with the wrong
  // direction is about to be corrected, and reporting the provider's figure as a movement would
  // describe a swing that never happened.
  const pendingBalanceChanges: PendingBalanceChanges[] = [];

  try {
    const creds = getCredentials();

    // An unreadable credentials file used to be indistinguishable from an empty one, so both
    // provider gates below simply fell through, the run wrote no provider items at all, and it
    // finished 'succeeded' with "Sync complete". The client toasted that in green and
    // `last_run.incomplete` stayed false, which is the flag the balance beam reads to decide it is
    // calibrated. Recorded as a failed item so the run lands 'partial' and every degradation
    // surface that already exists picks it up, rather than inventing a new one.
    const credentialsFault = credentialsUnreadable();
    if (credentialsFault) {
      recordSyncRunItem(db, run.id, {
        provider: 'system',
        connection_id: null,
        institution_name: 'Credentials',
        status: 'failed',
        error_message: `Stored credentials could not be decrypted: ${credentialsFault}`,
        recovery_action:
          'The encryption key lives in the OS keychain. Unlock it and restart, or restore the .mizan ' +
          'directory these credentials belong to. Until then no provider can sync, and Mizan will ' +
          'refuse to overwrite the file so the stored keys are not lost.',
      });
      deferredError = deferredError ?? new Error('Stored credentials could not be decrypted');
    }

    // Sync SimpleFIN
    if (creds.simplefin?.accessUrl) {
      emitSyncEvent({ type: 'sync_progress', message: 'Syncing SimpleFIN...', progress: 30 });
      try {
        const simplefinResult = await withRetry(() => syncSimplefin());
        const stage = recordSimplefinStage(db, run.id, simplefinResult);

        pendingBalanceChanges.push({ runItemId: stage.runItem.id, changes: simplefinResult.balanceChanges });
      } catch (err) {
        const message = (err as Error).message || 'SimpleFIN sync failed';
        // The recovery advice is derived from the HTTP status, not asserted. One sentence for every
        // transport failure told the owner to retry and re-check the setup token on a 402, which is
        // a lapsed SimpleFIN Bridge subscription and moves for neither.
        const failure = classifySimplefinFailure(err);
        // A rejected access URL is a reauth in every sense the rest of the app means it by, so it
        // takes that status rather than the generic one; the badge and the panel then agree.
        const connectionStatus = failure.kind === 'unauthorized' ? 'reauth_required' : 'sync_error';
        db.prepare(`UPDATE simplefin_connections SET status = ? WHERE id = 'simplefin_primary' AND status != 'removed'`)
          .run(connectionStatus);
        recordSyncRunItem(db, run.id, {
          provider: 'simplefin',
          connection_id: 'simplefin_primary',
          institution_name: 'SimpleFIN',
          status: failure.kind === 'unauthorized' ? 'reauth_required' : 'failed',
          error_message: failure.statusCode === undefined ? message : `${message} (HTTP ${failure.statusCode})`,
          recovery_action: failure.recoveryAction,
        });
        deferredError = deferredError ?? new Error(message);
      }
    }



    // Sync Coinbase if connected
    if (creds.coinbase) {
      emitSyncEvent({ type: 'sync_progress', message: 'Syncing Coinbase...', progress: 50 });
      try {
        const coinbaseResult = await withRetry(() => syncCoinbase());
        // `status` is derived from what the stage reported rather than hardcoded 'succeeded'.
        // A pass that could not price a coin, or that skipped the whole v2 ledger import, or that
        // declined to zero holdings because the feed was empty, is not a clean success, and saying
        // it is keeps `last_run.incomplete` false and the balance beam calibrated on a sheet the
        // provider did not fully refresh. 'skipped' is the same word `recordSimplefinStage` uses
        // for "the provider answered and something did not run": nothing here failed outright, or
        // withRetry would have thrown into the catch below.
        const coinbaseIncomplete = coinbaseResult.errors.length > 0;
        const runItem = recordSyncRunItem(db, run.id, {
          provider: 'coinbase',
          connection_id: 'coinbase',
          institution_name: 'Coinbase',
          status: coinbaseIncomplete ? 'skipped' : 'succeeded',
          error_message: coinbaseIncomplete ? coinbaseResult.errors.join(' ') : undefined,
          accounts_seen: coinbaseResult.accountCount,
          transactions_added: coinbaseResult.transactionCount,
          // `staleAccountCount` is holdings ZEROED, not transactions modified. It used to be
          // written into `transactions_modified`, so the sync panel reported "8 transactions
          // modified" on a run that modified none and zeroed eight positions, which is the more
          // alarming event described as the less alarming one.
          holdings_zeroed: coinbaseResult.staleAccountCount,
        });
        if (coinbaseIncomplete) {
          deferredError = deferredError ?? new Error(coinbaseResult.errors[0]);
        }

        pendingBalanceChanges.push({ runItemId: runItem.id, changes: coinbaseResult.balanceChanges });
      } catch (err) {
        const message = (err as Error).message || 'Coinbase sync failed';
        recordSyncRunItem(db, run.id, {
          provider: 'coinbase',
          connection_id: 'coinbase',
          institution_name: 'Coinbase',
          status: 'failed',
          error_message: message,
          recovery_action: 'Retry sync. If it continues failing, check Coinbase credentials in Settings.',
        });
        deferredError = deferredError ?? new Error(message);
      }
    }

    const postSync = runPostSyncStages(
      db,
      run.id,
      deferredError,
      defaultPostSyncStages,
      pendingBalanceChanges
    );
    const integrity = postSync.integrity;
    deferredError = postSync.deferredError;

    // Reconstructed net-worth history. Conditional, so it lives here rather than in
    // `runPostSyncStages` alongside the stages that run every time, the same way the rollover
    // ledger below does.
    //
    // After `takeSnapshot`, never before: today's sheet is an observation and the replay has to be
    // reconciled against a table that already holds it. Silent when the ledger has nothing new to
    // say, which is almost every sync: `reconcileReconstructedHistory` reads only the cheap
    // frontier in that case, and narrating a stage that did nothing teaches the owner to skim the
    // panel. `reconstructionTrigger` in services/snapshot.ts argues why this is a condition on the
    // data rather than an hourly rewrite of months of reconstructed history.
    try {
      const reconstruction = reconcileReconstructedHistory();
      if (reconstruction.ran) {
        emitSyncEvent({ type: 'sync_progress', message: 'Replaying net worth history...', progress: 92 });
        const item = recordSyncRunItem(db, run.id, {
          provider: 'system',
          connection_id: 'net-worth-reconstruction',
          institution_name: 'Reconstructed net worth history',
          status: 'succeeded',
        });
        recordSyncChange(db, item.id, {
          entity_type: 'snapshot',
          entity_id: null,
          change_type: 'updated',
          description: describeReconstruction(reconstruction),
        });
      }
    } catch (err) {
      const message = (err as Error).message || 'Net worth reconstruction failed';
      recordSyncRunItem(db, run.id, {
        provider: 'system',
        connection_id: 'net-worth-reconstruction',
        institution_name: 'Reconstructed net worth history',
        status: 'failed',
        error_message: message,
        recovery_action: 'Retry sync, or rebuild replayed history from Settings > Data.',
      });
      deferredError = deferredError ?? new Error(message);
    }

    // Runs after auto-categorization, because a row that just changed category changed the budget
    // it counts against. This is the only writer of the rollover ledger now that reading it no
    // longer records it, so a month this skips is a month the ledger has no record of.
    // Silent on an install with no rollover budget: the stage would write nothing, and narrating
    // it teaches the owner that a feature they never turned on is part of every sync.
    if (hasRolloverBudgets(db)) {
      emitSyncEvent({ type: 'sync_progress', message: 'Recording budget carryover...', progress: 95 });
      try {
        recordBudgetRolloverLedger(db);
      } catch (err) {
        const message = (err as Error).message || 'Budget carryover failed';
        recordSyncRunItem(db, run.id, {
          provider: 'system',
          connection_id: 'budget-rollover-ledger',
          institution_name: 'Budget carryover',
          status: 'failed',
          error_message: message,
          recovery_action: 'Retry sync. The carryover will be recorded again next sync.',
        });
        deferredError = deferredError ?? new Error(message);
      }
    }

    finishSyncRun(db, run.id, {
      status: deferredError ? 'partial' : 'succeeded',
      message: deferredError ? 'Sync finished with issues' : 'Sync complete',
      error_message: deferredError?.message,
      recovery_action: deferredError ? 'Open Accounts to reconnect or retry affected institutions.' : null,
      duplicate_candidates: integrity.duplicates.groupCount,
      transfer_candidates: integrity.transfers.pairCount,
    });
    finished = true;

    finalizeSyncRun(run.id, deferredError);
  } catch (err) {
    const message = (err as Error).message || 'Sync failed';
    // `finished` means the run already recorded its outcome and emitted its terminal event. A
    // partial run rethrows so its caller still sees the failure, and must not then be re-reported
    // as a total failure that landed nothing.
    if (!finished) {
      finishSyncRun(db, run.id, {
        status: 'failed',
        message: 'Sync failed',
        error_message: message,
        recovery_action: 'Retry sync. If it continues failing, check provider settings.',
      });
      emitSyncEvent({ type: 'sync_error', message });
    }
    throw err;
  }
}
