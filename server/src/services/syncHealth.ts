import { differenceInCalendarDays, parseISO } from 'date-fns';
import type Database from 'better-sqlite3';
import type {
  SyncHealth,
  SyncHealthConnection,
  SyncHealthFreshness,
  SyncHealthRecommendedAction,
  SyncHealthStatus,
} from '../../../shared/types';

const STALE_AFTER_DAYS = 3;

export interface SyncHealthConnectionRow {
  id: string;
  provider: 'plaid' | 'coinbase' | 'teller' | 'simplefin';
  institution_name: string | null;
  status: string;
  last_synced_at: string | null;
  account_count: number;
}

function ageInDays(iso: string | null, now: Date): number | null {
  if (!iso) return null;

  const parsed = parseISO(iso);
  if (Number.isNaN(parsed.getTime())) return null;

  return Math.max(0, differenceInCalendarDays(now, parsed));
}

function fallbackInstitutionName(provider: SyncHealthConnectionRow['provider']): string {
  switch (provider) {
    case 'plaid': return 'Bank connection';
    case 'teller': return 'Teller connection';
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
    return {
      freshness: 'attention',
      statusLabel: 'Last sync failed',
      statusDetail: 'Retry this sync. If it fails again, reconnect the institution.',
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

export function summarizeSyncHealth(connections: SyncHealthConnection[]): SyncHealth {
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
    statusDetail = `${attentionCount} connection${attentionCount === 1 ? '' : 's'} need action before Mizān can fully trust the data.`;
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
    connections,
  };
}

export function getSyncHealth(db: Database.Database): SyncHealth {
  const plaidRows = db.prepare(`
    SELECT
      pi.id,
      'plaid' AS provider,
      pi.institution_name,
      pi.status,
      pi.last_synced_at,
      COUNT(a.id) AS account_count
    FROM plaid_items pi
    LEFT JOIN accounts a
      ON a.connection_id = pi.id
     AND a.connection_type = 'plaid'
     AND a.is_hidden = 0
    WHERE pi.status != 'removed'
    GROUP BY pi.id
  `).all() as SyncHealthConnectionRow[];

  const tellerRows = db.prepare(`
    SELECT
      ti.id,
      'teller' AS provider,
      ti.institution_name,
      ti.status,
      ti.last_synced_at,
      COUNT(a.id) AS account_count
    FROM teller_items ti
    LEFT JOIN accounts a
      ON a.connection_id = ti.id
     AND a.connection_type = 'teller'
     AND a.is_hidden = 0
    GROUP BY ti.id
  `).all() as SyncHealthConnectionRow[];

  const simplefinRows = db.prepare(`
    SELECT
      sc.id,
      'simplefin' AS provider,
      'SimpleFIN' AS institution_name,
      sc.status,
      sc.last_synced_at,
      COUNT(a.id) AS account_count
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
      COUNT(a.id) AS account_count
    FROM coinbase_connections cc
    LEFT JOIN accounts a
      ON a.connection_id = cc.id
     AND a.connection_type = 'coinbase'
     AND a.is_hidden = 0
    WHERE cc.status != 'disconnected'
    GROUP BY cc.id
  `).all() as SyncHealthConnectionRow[];

  const connections = [...plaidRows, ...tellerRows, ...simplefinRows, ...coinbaseRows].map((row) => classifySyncConnection(row));
  return summarizeSyncHealth(connections);
}
