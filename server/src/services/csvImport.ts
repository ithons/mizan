import type Database from 'better-sqlite3';
import { format, isValid, parse } from 'date-fns';
import { v4 as uuidv4 } from 'uuid';
import type { z } from 'zod';
import type { CsvImportPreview, CsvImportPreviewIssue, CsvImportPreviewRow } from '../../../shared/types';
import type { CsvImportMappingSchema } from '../../../shared/schemas';
import { adjustManualAccountBalance } from './manualAccountBalance';

export type CsvImportMapping = z.infer<typeof CsvImportMappingSchema>;

export interface CsvImportInput {
  rows: Array<Record<string, string>>;
  mapping: CsvImportMapping;
}

export interface CsvImportCommitResult {
  imported: number;
  errors: string[];
  balanceChanged: boolean;
}

interface AccountMatch {
  id: string;
  account_name: string;
  institution_name: string;
  is_manual: number;
}

interface CategoryMatch {
  id: string;
  name: string;
}

function parseCsvAmount(rawAmount: string | undefined): number | null {
  const trimmed = rawAmount?.trim();
  if (!trimmed) return null;

  const isParenthesized = trimmed.startsWith('(') && trimmed.endsWith(')');
  const normalized = trimmed
    .replace(/^\((.*)\)$/, '-$1')
    .replace(/[$,\s]/g, '');

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return null;

  return isParenthesized ? -Math.abs(parsed) : parsed;
}

function rowIssue(
  rowNumber: number,
  severity: CsvImportPreviewIssue['severity'],
  message: string,
  field?: string
): CsvImportPreviewIssue {
  return { row_number: rowNumber, severity, message, field };
}

function findAccount(
  db: Database.Database,
  row: Record<string, string>,
  mapping: CsvImportMapping
): AccountMatch | null {
  if (mapping.account && row[mapping.account]) {
    const accountValue = row[mapping.account];
    const account = db.prepare(`
      SELECT id, account_name, institution_name, is_manual
      FROM accounts
      WHERE account_name = ? OR institution_name = ?
      LIMIT 1
    `).get(accountValue, accountValue) as AccountMatch | undefined;
    if (account) return account;
  }

  const fallback = db.prepare(`
    SELECT id, account_name, institution_name, is_manual
    FROM accounts
    WHERE is_manual = 1
    LIMIT 1
  `).get() as AccountMatch | undefined;

  return fallback ?? null;
}

function findCategory(
  db: Database.Database,
  row: Record<string, string>,
  mapping: CsvImportMapping
): CategoryMatch | null {
  if (!mapping.category || !row[mapping.category]) return null;

  const category = db.prepare(`
    SELECT id, name
    FROM categories
    WHERE name = ?
    LIMIT 1
  `).get(row[mapping.category]) as CategoryMatch | undefined;

  return category ?? null;
}

function duplicateCandidateCount(
  db: Database.Database,
  row: CsvImportPreviewRow
): number {
  if (!row.account_id || !row.date || row.amount == null || !row.original_name) return 0;

  const duplicate = db.prepare(`
    SELECT COUNT(*) AS count
    FROM transactions
    WHERE account_id = ?
      AND date = ?
      AND ABS(amount - ?) < 0.005
      AND (
        merchant_name = ?
        OR original_name = ?
      )
  `).get(
    row.account_id,
    row.date,
    row.amount,
    row.merchant_name,
    row.original_name
  ) as { count: number } | undefined;

  return duplicate?.count ?? 0;
}

function transferCandidateCount(
  db: Database.Database,
  row: CsvImportPreviewRow
): number {
  if (!row.account_id || !row.date || row.amount == null) return 0;

  const transfer = db.prepare(`
    SELECT COUNT(*) AS count
    FROM transactions
    WHERE account_id <> ?
      AND date = ?
      AND ABS(amount + ?) < 0.005
  `).get(
    row.account_id,
    row.date,
    row.amount
  ) as { count: number } | undefined;

  return transfer?.count ?? 0;
}

function normalizeCsvRow(
  db: Database.Database,
  rawRow: Record<string, string>,
  mapping: CsvImportMapping,
  index: number
): CsvImportPreviewRow {
  const rowNumber = index + 1;
  const issues: CsvImportPreviewIssue[] = [];

  let normalizedDate: string | undefined;
  const rawDate = (rawRow[mapping.date] || '').trim();
  const dateFormat = mapping.dateFormat || 'yyyy-MM-dd';
  const parsedDate = parse(rawDate, dateFormat, new Date());
  if (!isValid(parsedDate)) {
    issues.push(rowIssue(rowNumber, 'error', `Invalid date "${rawDate}"`, mapping.date));
  } else {
    normalizedDate = format(parsedDate, 'yyyy-MM-dd');
  }

  let amount = parseCsvAmount(rawRow[mapping.amount]);
  if (amount === null) {
    issues.push(rowIssue(rowNumber, 'error', `Invalid amount "${rawRow[mapping.amount]}"`, mapping.amount));
  } else if (mapping.amountNegate) {
    amount = -amount;
  }

  const account = findAccount(db, rawRow, mapping);
  if (!account) {
    issues.push(rowIssue(rowNumber, 'error', 'No account matched and no manual fallback account exists', mapping.account));
  }

  const category = findCategory(db, rawRow, mapping);
  if (mapping.category && rawRow[mapping.category] && !category) {
    issues.push(rowIssue(rowNumber, 'warning', `Category "${rawRow[mapping.category]}" was not found`, mapping.category));
  }

  const merchantName = mapping.merchant ? (rawRow[mapping.merchant] || null) : null;
  const originalName = merchantName || 'Imported transaction';
  const notes = mapping.notes ? (rawRow[mapping.notes] || null) : null;

  const previewRow: CsvImportPreviewRow = {
    row_number: rowNumber,
    valid: !issues.some((issue) => issue.severity === 'error'),
    date: normalizedDate,
    amount: amount ?? undefined,
    merchant_name: merchantName,
    original_name: originalName,
    account_id: account?.id,
    account_name: account ? account.account_name : undefined,
    category_id: category?.id ?? null,
    category_name: category?.name ?? null,
    notes,
    duplicate_candidate_count: 0,
    transfer_candidate_count: 0,
    balance_delta: account?.is_manual && amount != null ? amount : 0,
    issues,
  };

  const duplicateCount = duplicateCandidateCount(db, previewRow);
  previewRow.duplicate_candidate_count = duplicateCount;
  if (duplicateCount > 0) {
    previewRow.issues.push(rowIssue(rowNumber, 'warning', `${duplicateCount} matching transaction already exists`));
  }

  const transferCount = transferCandidateCount(db, previewRow);
  previewRow.transfer_candidate_count = transferCount;
  if (transferCount > 0) {
    previewRow.issues.push(rowIssue(
      rowNumber,
      'warning',
      `${transferCount} equal and opposite transaction${transferCount === 1 ? '' : 's'} may be ${transferCount === 1 ? 'a transfer' : 'transfers'}`
    ));
  }

  return previewRow;
}

export function buildCsvImportPreview(
  db: Database.Database,
  input: CsvImportInput
): CsvImportPreview {
  const rows = input.rows.map((row, index) => normalizeCsvRow(db, row, input.mapping, index));
  const validRows = rows.filter((row) => row.valid);
  const issues = rows.flatMap((row) => row.issues);
  const errors = issues.filter((issue) => issue.severity === 'error');
  const warnings = issues.filter((issue) => issue.severity === 'warning');

  return {
    rows,
    valid_count: validRows.length,
    invalid_count: rows.length - validRows.length,
    duplicate_candidate_count: rows.reduce((sum, row) => sum + row.duplicate_candidate_count, 0),
    transfer_candidate_count: rows.reduce((sum, row) => sum + row.transfer_candidate_count, 0),
    balance_delta: validRows.reduce((sum, row) => sum + row.balance_delta, 0),
    errors,
    warnings,
  };
}

export function commitCsvImport(
  db: Database.Database,
  input: CsvImportInput,
  now = new Date().toISOString()
): CsvImportCommitResult {
  const preview = buildCsvImportPreview(db, input);
  let imported = 0;
  let balanceChanged = false;
  const errors = preview.errors.map((issue) => `Row ${issue.row_number}: ${issue.message}`);

  for (const row of preview.rows) {
    if (!row.valid || !row.account_id || !row.date || row.amount == null || !row.original_name) continue;

    try {
      const accountId = row.account_id;
      const date = row.date;
      const amount = row.amount;
      const originalName = row.original_name;
      const importRow = db.transaction(() => {
        db.prepare(`
          INSERT INTO transactions
            (id, account_id, date, amount, merchant_name, original_name,
             category_id, pending, notes, is_manual, source_type, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 1, 'import', ?, ?)
        `).run(
          uuidv4(),
          accountId,
          date,
          amount,
          row.merchant_name,
          originalName,
          row.category_id,
          row.notes,
          now,
          now
        );

        return adjustManualAccountBalance(db, accountId, amount, now);
      });

      if (importRow()) {
        balanceChanged = true;
      }
      imported++;
    } catch (err) {
      errors.push(`Row ${row.row_number}: ${(err as Error).message}`);
    }
  }

  return { imported, errors, balanceChanged };
}
