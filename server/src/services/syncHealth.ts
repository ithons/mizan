import { differenceInCalendarDays, parseISO } from 'date-fns';
import type Database from 'better-sqlite3';
import type {
  SyncHealth,
  SyncHealthConnection,
  SyncHealthFreshness,
  SyncHealthLastRun,
  SyncHealthRecommendedAction,
  SyncHealthStatus,
  SyncRunStatus,
} from '../../../shared/types';

const STALE_AFTER_DAYS = 3;

export interface SyncHealthConnectionRow {
  id: string;
  provider: 'coinbase' | 'simplefin';
  institution_name: string | null;
  status: string;
  last_synced_at: string | null;
  account_count: number;
  /**
   * The recovery advice the most recent failed sync recorded for this connection, or null when the
   * connection has never failed.
   *
   * Read rather than invented. `classifyStatus` used to answer `sync_error` with one sentence,
   * "Retry this sync. If it fails again, reconnect the institution.", for every possible cause. The
   * sync had already classified the real one and written it to `sync_run_items.recovery_action`, so
   * the panel and the account badge were stating a generic guess beside a specific fact the same
   * database already held. On a 402 the guess was advice that cannot work.
   */
  last_failure_action?: string | null;
}

function ageInDays(iso: string | null, now: Date): number | null {
  if (!iso) return null;

  const parsed = parseISO(iso);
  if (Number.isNaN(parsed.getTime())) return null;

  return Math.max(0, differenceInCalendarDays(now, parsed));
}

function fallbackInstitutionName(provider: SyncHealthConnectionRow['provider']): string {
  switch (provider) {
    case 'simplefin': return 'SimpleFIN connection';
    case 'coinbase': return 'Coinbase';
    default: return 'Connection';
  }
}

function classifyStatus(row: SyncHealthConnectionRow, syncAgeDays: number | null): {
  freshness: SyncHealthFreshness;
  statusLabel: string;
  statusDetail: string;
  failureReason: string | null;
  recommendedAction: SyncHealthRecommendedAction;
  isStale: boolean;
  needsAttention: boolean;
} {
  if (row.status === 'reauth_required') {
    return {
      freshness: 'attention',
      statusLabel: 'Reconnect required',
      statusDetail: 'This connection needs a fresh login before balances and transactions can update.',
      failureReason: 'Institution login expired',
      recommendedAction: 'reconnect',
      isStale: false,
      needsAttention: true,
    };
  }

  if (row.status === 'sync_error') {
    const recorded = row.last_failure_action?.trim();
    return {
      freshness: 'attention',
      statusLabel: 'Last sync failed',
      // The recorded reason wins when there is one. The fallback is only for a connection marked
      // sync_error with no failed run item behind it, which the migration window can produce.
      statusDetail: recorded && recorded.length > 0
        ? recorded
        : 'Retry this sync. If it fails again, reconnect the institution.',
      failureReason: 'Last sync attempt failed',
      recommendedAction: 'retry',
      isStale: false,
      needsAttention: true,
    };
  }

  if (row.status !== 'active') {
    return {
      freshness: 'attention',
      statusLabel: row.status.replace(/_/g, ' '),
      statusDetail: 'This connection is not active.',
      failureReason: row.status,
      recommendedAction: 'retry',
      isStale: false,
      needsAttention: true,
    };
  }

  if (syncAgeDays === null) {
    return {
      freshness: 'never',
      statusLabel: 'Never synced',
      statusDetail: 'This connection has not completed an initial sync yet.',
      failureReason: null,
      recommendedAction: 'sync',
      isStale: true,
      needsAttention: false,
    };
  }

  if (syncAgeDays >= STALE_AFTER_DAYS) {
    return {
      freshness: 'stale',
      statusLabel: `${syncAgeDays}d old`,
      statusDetail: `Data is ${syncAgeDays} days old. Sync before relying on reports or advisor answers.`,
      failureReason: null,
      recommendedAction: 'sync',
      isStale: true,
      needsAttention: false,
    };
  }

  return {
    freshness: 'fresh',
    statusLabel: 'Synced',
    statusDetail: 'Data is current enough for reports, budgets, and advisor context.',
    failureReason: null,
    recommendedAction: 'none',
    isStale: false,
    needsAttention: false,
  };
}

export function classifySyncConnection(
  row: SyncHealthConnectionRow,
  now = new Date()
): SyncHealthConnection {
  const syncAgeDays = ageInDays(row.last_synced_at, now);
  const classification = classifyStatus(row, syncAgeDays);

  return {
    id: row.id,
    provider: row.provider,
    institution_name: row.institution_name || fallbackInstitutionName(row.provider),
    status: row.status,
    last_synced_at: row.last_synced_at,
    last_success_at: row.last_synced_at,
    last_attempted_at: row.status === 'active' ? row.last_synced_at : null,
    age_days: syncAgeDays,
    account_count: row.account_count,
    is_stale: classification.isStale,
    needs_attention: classification.needsAttention,
    freshness: classification.freshness,
    status_label: classification.statusLabel,
    status_detail: classification.statusDetail,
    failure_reason: classification.failureReason,
    recommended_action: classification.recommendedAction,
  };
}

/**
 * The last run that reached a terminal state.
 *
 * `status = 'running'` is excluded because a run in flight has not said anything yet, and reading
 * it as incomplete would put every instrument on this data into a degraded state for the four
 * seconds a sync takes. Ordered by `completed_at` and then `started_at`, so a row whose
 * `completed_at` is somehow absent still orders sensibly rather than sorting to the top as NULL.
 */
export function readLastSyncRun(db: Database.Database): SyncHealthLastRun | null {
  const row = db.prepare(`
    SELECT id, status, completed_at, message
    FROM sync_runs
    WHERE status <> 'running'
    ORDER BY COALESCE(completed_at, started_at) DESC, started_at DESC
    LIMIT 1
  `).get() as
    | { id: string; status: SyncRunStatus; completed_at: string | null; message: string | null }
    | undefined;

  if (!row) return null;

  return {
    id: row.id,
    status: row.status,
    completed_at: row.completed_at,
    message: row.message,
    incomplete: row.status === 'partial' || row.status === 'failed',
  };
}

export function summarizeSyncHealth(
  connections: SyncHealthConnection[],
  lastRun: SyncHealthLastRun | null = null
): SyncHealth {
  const staleCount = connections.filter((connection) => connection.is_stale).length;
  const attentionCount = connections.filter((connection) => connection.needs_attention).length;
  const freshCount = connections.filter((connection) => connection.freshness === 'fresh').length;
  const neverSyncedCount = connections.filter((connection) => connection.freshness === 'never').length;
  const syncedDates = connections
    .map((connection) => connection.last_success_at)
    .filter((date): date is string => Boolean(date))
    .sort();

  let status: SyncHealthStatus = 'healthy';
  let statusLabel = 'Fresh';
  let statusDetail = 'All connected institutions are fresh enough for reports and advisor context.';

  if (connections.length === 0) {
    status = 'empty';
    statusLabel = 'Not connected';
    statusDetail = 'Connect an institution or add manual accounts to start tracking finances.';
  } else if (attentionCount > 0) {
    status = 'attention';
    statusLabel = 'Needs attention';
    // The verb agrees, because on the live database this row reads at count one and said
    // "1 connection need action".
    statusDetail = attentionCount === 1
      ? '1 connection needs action before Mizān can fully trust the data.'
      : `${attentionCount} connections need action before Mizān can fully trust the data.`;
  } else if (staleCount > 0) {
    status = 'stale';
    statusLabel = 'Stale';
    statusDetail = `${staleCount} connection${staleCount === 1 ? '' : 's'} should be synced before relying on current totals.`;
  }

  return {
    status,
    status_label: statusLabel,
    status_detail: statusDetail,
    connection_count: connections.length,
    stale_count: staleCount,
    attention_count: attentionCount,
    fresh_count: freshCount,
    never_synced_count: neverSyncedCount,
    last_synced_at: syncedDates.at(-1) ?? null,
    last_run: lastRun,
    connections,
  };
}

/**
 * `now` is a parameter and not an ambient `new Date()` because `classifySyncConnection` already
 * took one and this function dropped it, so every caller (`routes/insights.ts`, `aiContext.ts`,
 * and every test) was pinned to the wall clock with no seam to inject. A fixture dated the day it
 * was written stayed `fresh` on that day and turned `stale` three days later, which is how the
 * healthy-case test that proves this detector is silent became the one test that failed with age.
 */
export function getSyncHealth(db: Database.Database, now = new Date()): SyncHealth {
  const simplefinRows = db.prepare(`
    SELECT
      sc.id,
      'simplefin' AS provider,
      'SimpleFIN' AS institution_name,
      sc.status,
      sc.last_synced_at,
      COUNT(a.id) AS account_count,
      (SELECT i.recovery_action
         FROM sync_run_items i
        WHERE i.connection_id = sc.id
          AND i.status IN ('failed', 'reauth_required')
          AND i.recovery_action IS NOT NULL
        ORDER BY i.completed_at DESC, i.rowid DESC
        LIMIT 1) AS last_failure_action
    FROM simplefin_connections sc
    LEFT JOIN accounts a
      ON a.connection_id = sc.id
     AND a.connection_type = 'simplefin'
     AND a.is_hidden = 0
    GROUP BY sc.id
  `).all() as SyncHealthConnectionRow[];

  const coinbaseRows = db.prepare(`
    SELECT
      cc.id,
      'coinbase' AS provider,
      cc.display_name AS institution_name,
      cc.status,
      cc.last_synced_at,
      COUNT(a.id) AS account_count,
      (SELECT i.recovery_action
         FROM sync_run_items i
        WHERE i.connection_id = cc.id
          AND i.status IN ('failed', 'reauth_required')
          AND i.recovery_action IS NOT NULL
        ORDER BY i.completed_at DESC, i.rowid DESC
        LIMIT 1) AS last_failure_action
    FROM coinbase_connections cc
    LEFT JOIN accounts a
      ON a.connection_id = cc.id
     AND a.connection_type = 'coinbase'
     AND a.is_hidden = 0
    WHERE cc.status != 'disconnected'
    GROUP BY cc.id
  `).all() as SyncHealthConnectionRow[];

  const connections = [...simplefinRows, ...coinbaseRows].map((row) => classifySyncConnection(row, now));
  return summarizeSyncHealth(connections, readLastSyncRun(db));
}
