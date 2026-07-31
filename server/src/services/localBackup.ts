import type Database from 'better-sqlite3';

/**
 * Every table a full backup carries, ordered parents before children.
 *
 * Two properties are load-bearing and both are re-derived from the real migrated schema in
 * `tests/localBackup.test.ts`, so a new table or a new foreign key fails there rather than at
 * restore time:
 *
 * 1. Order. Restore DELETEs this list in reverse and INSERTs it forward, so a child placed
 *    before its parent survives the delete pass.
 * 2. Foreign-key closure. A table left out keeps its old rows through a restore, and because
 *    those rows point at accounts, categories and transactions the restore just replaced, the
 *    `foreign_key_check` guarding COMMIT aborts a restore the preview had already called valid.
 *    Leaving a table out also silently discards it: `holdings_history` and `advisor_actions`
 *    were both absent, so every price series and every undoable AI action died in a round trip.
 *
 * Tables with no outbound foreign key may sit anywhere; they are grouped with the data they
 * belong to rather than hoisted, because the grouping is what makes an omission visible.
 */
export const LOCAL_BACKUP_TABLES = [
  // Exported for provenance, never restored: the target database's own migration state is the
  // only thing that describes the schema its rows are about to land in.
  'schema_migrations',

  'accounts',
  'categories',
  'securities',
  'transactions',
  'transaction_category_revisions',
  'transaction_field_revisions',
  'holdings',
  'holdings_history',
  'budgets',
  'budget_rollover_ledger',
  'recurring_patterns',
  'recurring_occurrence_adjustments',
  'merchant_rules',
  'merchant_rule_revisions',
  'goals',
  'coinbase_connections',
  // No longer holds access_url (moved to the credentials store in migration 021), so it's
  // safe to back up: it carries only status/last_synced metadata for the SimpleFIN connection.
  'simplefin_connections',
  'net_worth_snapshots',
  'sync_runs',
  'sync_run_items',
  'sync_changes',
  'app_preferences',
  'data_import_runs',
  'advisor_actions',
  'advisor_drafts',
  // Declares no foreign key on purpose (migration 047): the record of a rejected AI answer has to
  // outlive the draft the worker deletes and the category a merge removes. Listed here anyway,
  // and last among the advisor tables, because the closure test only guards tables it can see.
  'ai_feedback',
  'ai_memory',
  // Also no foreign key (migration 051): `sync_run_id` is a recorded historical value, and the
  // record of what the model did has to survive a sync run being pruned or a pass fired outside
  // one. Listed here because the closure test only guards tables it can see.
  'ai_runs',
  // Declares no foreign key for the same reason ai_feedback does not (migration 050): an incident is
  // evidence about advisor_actions rows and has to outlive them, and the batch it describes may have
  // been reverted out of existence. Grouped with the advisor tables so an omission is visible.
  'ai_incidents',
  'conversations',
  'messages',
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
  /** True only if this table's rows will land as-is. Drives `restorable_table_count`. */
  restorable: boolean;
  /** False when the backup predates the table; it is then restored empty rather than rejected. */
  present_in_backup: boolean;
  missing_columns: string[];
  extra_columns: string[];
}

export interface LocalBackupRestorePreview {
  valid: boolean;
  app?: string;
  version?: number;
  exported_at?: string;
  /** Tables the restore covers, i.e. `LOCAL_RESTORE_TABLES.length`. The denominator of N/M. */
  table_count: number;
  /** Covered tables the backup actually supplies and that restore as-is. The numerator. */
  restorable_table_count: number;
  total_rows: number;
  restorable_rows: number;
  tables: LocalBackupRestorePreviewTable[];
  errors: string[];
  warnings: string[];
}

export interface LocalBackupRestoreResult {
  /** Tables rewritten from the backup, including any restored empty because the backup lacked them. */
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
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

interface ForeignKeyListRow {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string | null;
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
      db.prepare(`SELECT * FROM ${quoteIdentifier(table)}`).all() as Array<Record<string, unknown>>,
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

function isBackupTable(name: string): name is LocalBackupTableName {
  return (LOCAL_BACKUP_TABLES as readonly string[]).includes(name);
}

function tableInfo(db: Database.Database, table: LocalBackupTableName): TableInfoRow[] {
  return db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as TableInfoRow[];
}

function tableColumns(db: Database.Database, table: LocalBackupTableName): string[] {
  return tableInfo(db, table).map((column) => column.name);
}

function primaryKeyColumns(db: Database.Database, table: LocalBackupTableName): string[] {
  return tableInfo(db, table)
    .filter((column) => column.pk > 0)
    .sort((a, b) => a.pk - b.pk)
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

  const backupTables = value.tables;
  const tables: Partial<Record<LocalBackupTableName, Array<Record<string, unknown>>>> = {};

  for (const table of LOCAL_BACKUP_TABLES) {
    if (!Object.prototype.hasOwnProperty.call(backupTables, table)) {
      // A backup written before this table joined the list is still a complete backup of
      // everything the owner had at the time. Rejecting it outright made every accounts,
      // categories and transactions row in it unrecoverable over one absent key.
      warnings.push(`Backup predates table ${table}; it will be restored empty.`);
      tables[table] = [];
      continue;
    }

    const rowsValue = backupTables[table];
    if (!Array.isArray(rowsValue)) {
      errors.push(`Backup table ${table} must be an array of rows.`);
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

  const extraTables = Object.keys(backupTables).filter((table) => !isBackupTable(table));
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

/**
 * A composite-safe key for one row, or null when any component is absent or NULL.
 *
 * SQLite treats a foreign key with a NULL component as satisfied, so a partially populated key
 * is not a violation and must never be compared against the parent set. A component missing from
 * the row entirely is the same case: the restore inserts the column's database default.
 */
function rowKey(row: Record<string, unknown>, columns: string[]): string | null {
  const values: unknown[] = [];
  for (const column of columns) {
    const value = row[column];
    if (value === null || value === undefined) {
      return null;
    }
    values.push(value);
  }
  return JSON.stringify(values);
}

/**
 * Reproduce `PRAGMA foreign_key_check` against the backup payload before anything is written.
 *
 * The restore runs that pragma inside its transaction, so a backup with dangling references is
 * rolled back after the preview has already told the owner it was "Ready". Catching it here is
 * what makes the preview's verdict mean something.
 */
function backupForeignKeyErrors(
  db: Database.Database,
  tables: Record<LocalBackupTableName, Array<Record<string, unknown>>>
): string[] {
  const errors: string[] = [];
  const parentKeyCache = new Map<string, Set<string>>();

  const parentKeys = (parent: LocalBackupTableName, columns: string[]): Set<string> => {
    const cacheKey = `${parent}:${columns.join(',')}`;
    const cached = parentKeyCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    const keys = new Set<string>();
    for (const row of tables[parent]) {
      const key = rowKey(row, columns);
      if (key !== null) {
        keys.add(key);
      }
    }
    parentKeyCache.set(cacheKey, keys);
    return keys;
  };

  for (const table of LOCAL_RESTORE_TABLES) {
    const rows = tables[table];
    if (rows.length === 0) {
      continue;
    }

    const constraints = new Map<number, ForeignKeyListRow[]>();
    const declared = db
      .prepare(`PRAGMA foreign_key_list(${quoteIdentifier(table)})`)
      .all() as ForeignKeyListRow[];
    for (const fk of declared) {
      const group = constraints.get(fk.id);
      if (group) {
        group.push(fk);
      } else {
        constraints.set(fk.id, [fk]);
      }
    }

    for (const group of constraints.values()) {
      const parent = group[0].table;
      // A parent outside the backup set cannot be validated from the payload. The closure test
      // asserts this never happens; the branch exists so a future omission degrades to no check
      // rather than a crash on an undefined table.
      if (!isBackupTable(parent)) {
        continue;
      }

      const ordered = [...group].sort((a, b) => a.seq - b.seq);
      const childColumns = ordered.map((fk) => fk.from);
      const parentColumns = ordered.every((fk) => fk.to !== null)
        ? ordered.map((fk) => fk.to as string)
        : primaryKeyColumns(db, parent);
      const keys = parentKeys(parent, parentColumns);

      let orphans = 0;
      for (const row of rows) {
        const key = rowKey(row, childColumns);
        if (key !== null && !keys.has(key)) {
          orphans += 1;
        }
      }
      if (orphans > 0) {
        errors.push(
          `${table} has ${orphans} row${orphans === 1 ? '' : 's'} whose ${childColumns.join(', ')} references a ${parent} row the backup does not contain.`
        );
      }
    }
  }

  return errors;
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
    const suppliedTables = isRecord(value) && isRecord(value.tables) ? value.tables : {};

    for (const table of LOCAL_BACKUP_TABLES) {
      const rows = parsed.backup.tables[table];
      const presentInBackup = Object.prototype.hasOwnProperty.call(suppliedTables, table);
      const isRestoreTable = table !== 'schema_migrations';
      const columns = tableInfo(db, table);

      if (columns.length === 0) {
        // Restoring into a database behind on migrations would otherwise fail deep inside the
        // transaction with a bare "no such table" and no indication of which one.
        errors.push(`Target database is missing table ${table}; run pending migrations before restoring.`);
        tables.push({
          table,
          backup_rows: rows.length,
          current_rows: 0,
          restorable: false,
          present_in_backup: presentInBackup,
          missing_columns: [],
          extra_columns: [],
        });
        continue;
      }

      const targetColumns = columns.map((column) => column.name);
      const targetColumnSet = new Set(targetColumns);
      const sourceColumns = backupColumns(rows);
      const sourceColumnSet = new Set(sourceColumns);
      const extraColumns = sourceColumns.filter((column) => !targetColumnSet.has(column));
      const missingColumns = targetColumns.filter((column) => !sourceColumnSet.has(column));

      // A missing column normally falls back to the database default. A missing column that is
      // NOT NULL or part of the primary key with no default has no fallback, and the INSERT
      // fails once the transaction is already open.
      const unfillableColumns = isRestoreTable && rows.length > 0
        ? columns
            .filter((column) => !sourceColumnSet.has(column.name))
            .filter((column) => (column.notnull === 1 || column.pk > 0) && column.dflt_value === null)
            .map((column) => column.name)
        : [];

      const emptyRows = isRestoreTable
        ? rows.filter((row) => !Object.keys(row).some((column) => targetColumnSet.has(column))).length
        : 0;

      if (extraColumns.length > 0) {
        errors.push(`${table} includes unsupported column${extraColumns.length === 1 ? '' : 's'}: ${extraColumns.join(', ')}.`);
      }
      if (unfillableColumns.length > 0) {
        errors.push(`${table} is missing required column${unfillableColumns.length === 1 ? '' : 's'} with no database default: ${unfillableColumns.join(', ')}.`);
      }
      if (emptyRows > 0) {
        errors.push(`${table} has ${emptyRows} row${emptyRows === 1 ? '' : 's'} with no column matching the current schema.`);
      }
      if (rows.length > 0 && missingColumns.length > 0 && isRestoreTable && unfillableColumns.length === 0) {
        warnings.push(`${table} is missing column${missingColumns.length === 1 ? '' : 's'} restored from database defaults: ${missingColumns.join(', ')}.`);
      }

      tables.push({
        table,
        backup_rows: rows.length,
        current_rows: currentRowCount(db, table),
        restorable:
          isRestoreTable &&
          presentInBackup &&
          extraColumns.length === 0 &&
          unfillableColumns.length === 0 &&
          emptyRows === 0,
        present_in_backup: presentInBackup,
        missing_columns: missingColumns,
        extra_columns: extraColumns,
      });
    }

    errors.push(...backupForeignKeyErrors(db, parsed.backup.tables));
  }

  return {
    valid: errors.length === 0,
    app: parsed.backup?.app,
    version: parsed.backup?.version,
    exported_at: parsed.backup?.exported_at,
    table_count: parsed.backup ? LOCAL_RESTORE_TABLES.length : 0,
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
