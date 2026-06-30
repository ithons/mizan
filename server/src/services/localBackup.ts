import type Database from 'better-sqlite3';

export const LOCAL_BACKUP_TABLES = [
  'schema_migrations',
  'accounts',
  'categories',
  'transactions',
  'securities',
  'holdings',
  'investment_transactions',
  'budgets',
  'recurring_patterns',
  'merchant_rules',
  'goals',
  'plaid_items',
  'coinbase_connections',
  'net_worth_snapshots',
  'sync_runs',
  'sync_run_items',
  'sync_changes',
] as const;

export type LocalBackupTableName = typeof LOCAL_BACKUP_TABLES[number];

export interface LocalBackup {
  app: 'mizan';
  version: 1;
  exported_at: string;
  tables: Record<LocalBackupTableName, Array<Record<string, unknown>>>;
}

export function buildLocalBackup(db: Database.Database, exportedAt = new Date()): LocalBackup {
  const tables = Object.fromEntries(
    LOCAL_BACKUP_TABLES.map((table) => [
      table,
      db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>,
    ])
  ) as Record<LocalBackupTableName, Array<Record<string, unknown>>>;

  return {
    app: 'mizan',
    version: 1,
    exported_at: exportedAt.toISOString(),
    tables,
  };
}
