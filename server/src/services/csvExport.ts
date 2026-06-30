import type Database from 'better-sqlite3';

export type TransactionCsvFormat = 'mizan' | 'monarch';

export interface TransactionCsvExportOptions {
  startDate?: string;
  endDate?: string;
  accountIds?: string[];
  format?: TransactionCsvFormat;
}

interface TransactionCsvRow {
  date: string;
  amount: number;
  merchant_name: string | null;
  original_name: string;
  notes: string | null;
  category_name: string | null;
  account_name: string | null;
  institution_name: string | null;
}

const MIZAN_HEADERS = [
  'date',
  'amount',
  'merchant_name',
  'original_name',
  'category_name',
  'account_name',
  'institution_name',
  'notes',
];

const MONARCH_HEADERS = ['Date', 'Merchant', 'Category', 'Account', 'Amount', 'Notes'];

function csvEscape(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function csvCell(value: string | number | null): string {
  if (value === null) return '';
  return csvEscape(String(value));
}

function serializeCsv(rows: string[][]): string {
  return `${rows.map((row) => row.join(',')).join('\n')}\n`;
}

function getHeaders(format: TransactionCsvFormat): string[] {
  return format === 'monarch' ? MONARCH_HEADERS : MIZAN_HEADERS;
}

function getRow(row: TransactionCsvRow, format: TransactionCsvFormat): string[] {
  if (format === 'monarch') {
    return [
      csvCell(row.date),
      csvCell(row.merchant_name ?? row.original_name),
      csvCell(row.category_name),
      csvCell(row.account_name),
      csvCell(row.amount),
      csvCell(row.notes),
    ];
  }

  return [
    csvCell(row.date),
    csvCell(row.amount),
    csvCell(row.merchant_name),
    csvCell(row.original_name),
    csvCell(row.category_name),
    csvCell(row.account_name),
    csvCell(row.institution_name),
    csvCell(row.notes),
  ];
}

export function transactionCsvFilename(format: TransactionCsvFormat, exportedAt: Date): string {
  const date = exportedAt.toISOString().split('T')[0];
  return format === 'monarch'
    ? `mizan-monarch-transactions-${date}.csv`
    : `mizan-transactions-${date}.csv`;
}

export function buildTransactionsCsv(
  db: Database.Database,
  options: TransactionCsvExportOptions = {}
): string {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options.startDate) {
    conditions.push('t.date >= ?');
    params.push(options.startDate);
  }
  if (options.endDate) {
    conditions.push('t.date <= ?');
    params.push(options.endDate);
  }
  if (options.accountIds && options.accountIds.length > 0) {
    conditions.push(`t.account_id IN (${options.accountIds.map(() => '?').join(',')})`);
    params.push(...options.accountIds);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const format = options.format ?? 'mizan';
  const rows = db.prepare(`
    SELECT
      t.date,
      t.amount,
      t.merchant_name,
      t.original_name,
      t.notes,
      c.name AS category_name,
      a.account_name,
      a.institution_name
    FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    LEFT JOIN accounts a ON a.id = t.account_id
    ${where}
    ORDER BY t.date DESC
  `).all(...params) as TransactionCsvRow[];

  return serializeCsv([
    getHeaders(format).map(csvCell),
    ...rows.map((row) => getRow(row, format)),
  ]);
}
