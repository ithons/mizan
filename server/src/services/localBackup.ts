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
export type LocalRestoreTableName = Exclude<LocalBackupTableName, 'schema_migrations'>;

export const LOCAL_RESTORE_TABLES = LOCAL_BACKUP_TABLES.filter(
  (table): table is LocalRestoreTableName => table !== 'schema_migrations'
);

export interface LocalBackup {
  app: 'mizan';
  version: 1;
  exported_at: string;
  tables: Record<LocalBackupTableName, Array<Record<string, unknown>>>;
}

export interface LocalBackupRestorePreviewTable {
  table: LocalBackupTableName;
  backup_rows: number;
  current_rows: number;
  restorable: boolean;
  missing_columns: string[];
  extra_columns: string[];
}

export interface LocalBackupRestorePreview {
  valid: boolean;
  app?: string;
  version?: number;
  exported_at?: string;
  table_count: number;
  restorable_table_count: number;
  total_rows: number;
  restorable_rows: number;
  tables: LocalBackupRestorePreviewTable[];
  errors: string[];
  warnings: string[];
}

export interface LocalBackupRestoreResult {
  restored_tables: number;
  restored_rows: number;
  skipped_tables: LocalBackupTableName[];
  warnings: string[];
}

export class LocalBackupValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(errors.join('; '));
    this.name = 'LocalBackupValidationError';
  }
}

interface TableInfoRow {
  name: string;
}

interface ForeignKeyViolationRow {
  table: string;
  rowid: number | null;
  parent: string;
  fkid: number;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function tableColumns(db: Database.Database, table: LocalBackupTableName): string[] {
  return (db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as TableInfoRow[])
    .map((column) => column.name);
}

function currentRowCount(db: Database.Database, table: LocalBackupTableName): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`).get() as { count: number };
  return row.count;
}

function parseLocalBackup(value: unknown): {
  backup?: LocalBackup;
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!isRecord(value)) {
    return { errors: ['Backup must be a JSON object.'], warnings };
  }

  if (value.app !== 'mizan') {
    errors.push('Backup app must be mizan.');
  }
  if (value.version !== 1) {
    errors.push('Backup version must be 1.');
  }
  if (typeof value.exported_at !== 'string' || Number.isNaN(Date.parse(value.exported_at))) {
    errors.push('Backup exported_at must be a valid timestamp.');
  }
  if (!isRecord(value.tables)) {
    errors.push('Backup tables must be an object.');
    return { errors, warnings };
  }

  const tables: Partial<Record<LocalBackupTableName, Array<Record<string, unknown>>>> = {};

  for (const table of LOCAL_BACKUP_TABLES) {
    const rowsValue = value.tables[table];
    if (!Array.isArray(rowsValue)) {
      errors.push(`Missing or invalid backup table: ${table}.`);
      continue;
    }

    const rows: Array<Record<string, unknown>> = [];
    rowsValue.forEach((row, index) => {
      if (isRecord(row)) {
        rows.push(row);
      } else {
        errors.push(`${table} row ${index + 1} must be an object.`);
      }
    });
    tables[table] = rows;
  }

  const extraTables = Object.keys(value.tables).filter(
    (table) => !LOCAL_BACKUP_TABLES.includes(table as LocalBackupTableName)
  );
  if (extraTables.length > 0) {
    warnings.push(`Ignored unsupported backup tables: ${extraTables.join(', ')}.`);
  }

  if (errors.length > 0) {
    return { errors, warnings };
  }

  return {
    backup: {
      app: 'mizan',
      version: 1,
      exported_at: value.exported_at as string,
      tables: tables as Record<LocalBackupTableName, Array<Record<string, unknown>>>,
    },
    errors,
    warnings,
  };
}

function backupColumns(rows: Array<Record<string, unknown>>): string[] {
  return [...new Set(rows.flatMap((row) => Object.keys(row)))].sort();
}

export function buildLocalBackupRestorePreview(
  db: Database.Database,
  value: unknown
): LocalBackupRestorePreview {
  const parsed = parseLocalBackup(value);
  const tables: LocalBackupRestorePreviewTable[] = [];
  const errors = [...parsed.errors];
  const warnings = [...parsed.warnings];

  if (parsed.backup) {
    for (const table of LOCAL_BACKUP_TABLES) {
      const rows = parsed.backup.tables[table];
      const targetColumns = tableColumns(db, table);
      const targetColumnSet = new Set(targetColumns);
      const sourceColumns = backupColumns(rows);
      const extraColumns = sourceColumns.filter((column) => !targetColumnSet.has(column));
      const missingColumns = targetColumns.filter((column) => !sourceColumns.includes(column));
      const restorable = LOCAL_RESTORE_TABLES.includes(table as LocalRestoreTableName) && extraColumns.length === 0;

      if (extraColumns.length > 0) {
        errors.push(`${table} includes unsupported column${extraColumns.length === 1 ? '' : 's'}: ${extraColumns.join(', ')}.`);
      }
      if (rows.length > 0 && missingColumns.length > 0 && table !== 'schema_migrations') {
        warnings.push(`${table} is missing column${missingColumns.length === 1 ? '' : 's'} restored from database defaults: ${missingColumns.join(', ')}.`);
      }

      tables.push({
        table,
        backup_rows: rows.length,
        current_rows: currentRowCount(db, table),
        restorable,
        missing_columns: missingColumns,
        extra_columns: extraColumns,
      });
    }
  }

  return {
    valid: errors.length === 0,
    app: parsed.backup?.app,
    version: parsed.backup?.version,
    exported_at: parsed.backup?.exported_at,
    table_count: parsed.backup ? LOCAL_BACKUP_TABLES.length : 0,
    restorable_table_count: tables.filter((table) => table.restorable).length,
    total_rows: tables.reduce((sum, table) => sum + table.backup_rows, 0),
    restorable_rows: tables
      .filter((table) => table.restorable)
      .reduce((sum, table) => sum + table.backup_rows, 0),
    tables,
    errors,
    warnings,
  };
}

function insertBackupRow(
  db: Database.Database,
  table: LocalRestoreTableName,
  targetColumns: Set<string>,
  row: Record<string, unknown>
): void {
  const columns = Object.keys(row).filter((column) => targetColumns.has(column));
  if (columns.length === 0) {
    throw new LocalBackupValidationError([`${table} has a row with no supported columns.`]);
  }

  const columnSql = columns.map(quoteIdentifier).join(', ');
  const placeholders = columns.map(() => '?').join(', ');
  db.prepare(`INSERT INTO ${quoteIdentifier(table)} (${columnSql}) VALUES (${placeholders})`)
    .run(...columns.map((column) => row[column]));
}

export function restoreLocalBackup(
  db: Database.Database,
  value: unknown
): LocalBackupRestoreResult {
  const preview = buildLocalBackupRestorePreview(db, value);
  if (!preview.valid) {
    throw new LocalBackupValidationError(preview.errors);
  }

  const parsed = parseLocalBackup(value);
  if (!parsed.backup) {
    throw new LocalBackupValidationError(parsed.errors);
  }
  const backup = parsed.backup;

  const targetColumns = Object.fromEntries(
    LOCAL_RESTORE_TABLES.map((table) => [table, new Set(tableColumns(db, table))])
  ) as Record<LocalRestoreTableName, Set<string>>;

  const restoreTransaction = db.transaction(() => {
    for (const table of [...LOCAL_RESTORE_TABLES].reverse()) {
      db.prepare(`DELETE FROM ${quoteIdentifier(table)}`).run();
    }

    let restoredRows = 0;
    for (const table of LOCAL_RESTORE_TABLES) {
      for (const row of backup.tables[table]) {
        insertBackupRow(db, table, targetColumns[table], row);
        restoredRows++;
      }
    }

    const violations = db.prepare('PRAGMA foreign_key_check').all() as ForeignKeyViolationRow[];
    if (violations.length > 0) {
      throw new LocalBackupValidationError(
        violations.slice(0, 5).map((violation) =>
          `Restored backup violates ${violation.table} foreign key ${violation.fkid} referencing ${violation.parent}.`
        )
      );
    }

    return restoredRows;
  });

  const foreignKeysEnabled = db.pragma('foreign_keys', { simple: true }) === 1;
  db.pragma('foreign_keys = OFF');
  try {
    const restoredRows = restoreTransaction();
    return {
      restored_tables: LOCAL_RESTORE_TABLES.length,
      restored_rows: restoredRows,
      skipped_tables: ['schema_migrations'],
      warnings: preview.warnings,
    };
  } finally {
    db.pragma(`foreign_keys = ${foreignKeysEnabled ? 'ON' : 'OFF'}`);
  }
}
