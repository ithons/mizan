import type Database from 'better-sqlite3';
import type { SyncEvent } from '../../../shared/types';
import { getDb } from '../db/index';
import type { AiJobName } from './advisorSettings';
import { AI_JOBS, runAiJob, type AiJobCollect, type AiJobDeclaration, type AiJobOutcome, type AiJobTrigger } from './aiJobs';
import { collectBackgroundReview } from './aiWorker';

/**
 * Who fires the jobs, and when.
 *
 * There is no timer in this file. Every AI job that exists is triggered by a sync finishing, and
 * sync itself already runs on startup and on the hourly interval `index.ts` owns. Adding a clock
 * here would mean adding a job that needs one, and no such job exists.
 *
 * The one behaviour change worth naming: the after-sync trigger now fires from `finalizeSyncRun`'s
 * `finally`, so a sync where a stage failed still gets a review pass. It used to sit after
 * `if (deferredError) throw`, so a 'partial' run stepped over the kickoff no matter what it had
 * already written. Measured on a copy of .mizan/mizan.db, 2026-07-31:
 *   SELECT started_at, accounts_seen, transactions_added, transactions_modified,
 *          transactions_removed, error_message
 *     FROM sync_runs WHERE status = 'partial';
 *     -> 10 rows. Nine are 0/0/0/0: eight consecutive
 *        'getaddrinfo ENOTFOUND beta-bridge.simplefin.org' on 2026-07-28 and one on 07-24. Skipping
 *        a pass on those cost nothing, because nothing landed for one to review.
 *     -> One is not: 2026-07-24T04:21, 'FOREIGN KEY constraint failed', accounts_seen 17,
 *        transactions_modified 111.
 * That one row is the whole case. 111 modified transactions were committed and then dropped out of
 * the review path because a later stage threw, and nothing in the ledger says so. A change that
 * catches one such run a month is worth making; inflating it to ten is not.
 */

/**
 * The collector each job runs, exhaustive over AiJobName so a new job forces a decision here
 * rather than silently never running.
 *
 * `null` is a job this scheduler does not fire. It is not a gap to be filled later by whoever
 * notices: `AI_JOBS` records the same fact as `execution: 'callsite'`, and the test suite asserts
 * the two agree.
 */
const COLLECTORS: Readonly<Record<AiJobName, AiJobCollect | null>> = {
  background_review: collectBackgroundReview,
  // Answers POST /api/ai/suggest-categories on demand; nothing here starts it.
  bulk_categorization: null,
};

/** What this scheduler would run for a job, or null where it fires nothing. */
export function collectorFor(name: AiJobName): AiJobCollect | null {
  return COLLECTORS[name];
}

/** Set at shutdown so a sync completing on the way out cannot start a pass into a closing database. */
let stopped = false;

export function stopAiScheduler(): void {
  stopped = true;
}

export function jobsForTrigger(trigger: AiJobTrigger): AiJobDeclaration[] {
  return Object.values(AI_JOBS).filter((job) => job.trigger === trigger);
}

export interface AfterSyncOptions {
  syncRunId: string;
  emit: (event: SyncEvent) => void;
  db?: Database.Database;
}

/**
 * Run every after-sync job, in registry order, one at a time.
 *
 * Serial rather than parallel on purpose: the jobs write drafts and apply categorizations through
 * the same tables, and `runAiJob`'s re-entrancy guard is per job, not global.
 */
export async function runAfterSyncAiJobs(options: AfterSyncOptions): Promise<AiJobOutcome[]> {
  const db = options.db ?? getDb();
  const outcomes: AiJobOutcome[] = [];

  for (const job of jobsForTrigger('after_sync')) {
    const collect = COLLECTORS[job.name];
    if (!collect) {
      // Unreachable while the test asserting every after-sync job has a collector passes. Loud
      // rather than skipped, because a job that silently never runs is what this file replaces.
      console.error(`[ai-scheduler] ${job.name} declares an after_sync trigger with no collector; it did not run.`);
      continue;
    }
    outcomes.push(
      await runAiJob(job, collect, {
        db,
        trigger: 'after_sync',
        syncRunId: options.syncRunId,
        emit: options.emit,
      })
    );
  }

  return outcomes;
}

/**
 * The entry a sync uses. Never throws and never rejects: it is called from a `finally` that is
 * already carrying the sync's own failure, and a rejection here would replace it.
 */
export function triggerAfterSyncAiJobs(options: AfterSyncOptions): void {
  if (stopped) return;

  // Deferred a tick so the sync's own promise settles and its terminal event reaches the client
  // before a pass starts reading. unref'd so a pending trigger cannot hold the process open.
  const handle = setTimeout(() => {
    if (stopped) return;
    runAfterSyncAiJobs(options).catch((err) => {
      console.error('[ai-scheduler] After-sync jobs failed:', err);
    });
  }, 100);
  handle.unref?.();
}
