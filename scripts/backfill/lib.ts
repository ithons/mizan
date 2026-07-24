// Shared contract + helpers for the one-time historical backfill.
//
// The whole pipeline speaks ONE canonical CSV shape. Institution-specific raw
// exports (CSV/OFX/PDF) are converted to this shape by an adapter in normalize.ts;
// everything downstream (import, dedup, rebuild) only ever sees canonical rows.
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';

// ── Canonical CSV ────────────────────────────────────────────────────────────
// Fixed column names, one row per transaction. Sign convention matches how the DB
// stores amounts: NEGATIVE = money out (expense/outflow), POSITIVE = money in.
// `date` is yyyy-MM-dd local day. `account_name` must match an existing account
// exactly (import refuses otherwise — no silent fallback). category/notes optional.
export const CANONICAL_COLUMNS = [
  'account_name',
  'date',
  'amount',
  'merchant',
  'category',
  'notes',
] as const;

export interface CanonicalRow {
  account_name: string;
  date: string;
  amount: string; // dollars, signed; kept as string through CSV round-trips
  merchant: string;
  category: string;
  notes: string;
}

export const BACKFILL_DIR = path.join(process.cwd(), 'data', 'backfill');
export const NORMALIZED_DIR = path.join(BACKFILL_DIR, 'normalized');
export const FLOORS_PATH = path.join(BACKFILL_DIR, 'floors.json');

export interface FloorEntry {
  account_id: string;
  account_name: string;
  institution_name: string;
  provider: string; // connection_type
  type: string;
  is_manual: boolean;
  oldest_synced_date: string | null; // null when the account has no provider rows yet
  synced_count: number;
  // The chosen floor: manual history fills strictly below this, provider owns at/above.
  // Defaults to oldest_synced_date; edit floors.json by hand to override before --apply.
  floor: string | null;
}

// ── Minimal, dependency-free CSV (RFC-4180 quoting) ──────────────────────────
export function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { record.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      record.push(field); field = '';
      if (record.length > 1 || record[0] !== '') rows.push(record);
      record = [];
    } else field += c;
  }
  if (field !== '' || record.length > 0) { record.push(field); rows.push(record); }
  if (rows.length === 0) return [];

  const header = rows[0];
  return rows.slice(1).map((cells) => {
    const obj: Record<string, string> = {};
    header.forEach((h, idx) => { obj[h] = cells[idx] ?? ''; });
    return obj;
  });
}

function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function writeCanonicalCsv(filePath: string, rows: CanonicalRow[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lines = [CANONICAL_COLUMNS.join(',')];
  for (const row of rows) {
    lines.push(CANONICAL_COLUMNS.map((col) => csvCell(String(row[col] ?? ''))).join(','));
  }
  fs.writeFileSync(filePath, lines.join('\n') + '\n');
}

export function readCanonicalCsv(filePath: string): CanonicalRow[] {
  const parsed = parseCsv(fs.readFileSync(filePath, 'utf-8'));
  return parsed.map((row) => ({
    account_name: row.account_name ?? '',
    date: row.date ?? '',
    amount: row.amount ?? '',
    merchant: row.merchant ?? '',
    category: row.category ?? '',
    notes: row.notes ?? '',
  }));
}

// Resolve a canonical account_name to exactly one account row. Returns null when
// zero or multiple match — callers MUST refuse rather than guess (the HTTP importer's
// "first manual account" fallback is exactly the silent misfiling we avoid here).
export function resolveAccount(
  db: Database.Database,
  accountName: string
): { id: string; is_manual: number } | null {
  const matches = db.prepare(
    'SELECT id, is_manual FROM accounts WHERE account_name = ?'
  ).all(accountName) as Array<{ id: string; is_manual: number }>;
  return matches.length === 1 ? matches[0] : null;
}

export function loadFloors(): FloorEntry[] {
  if (!fs.existsSync(FLOORS_PATH)) {
    throw new Error(`No floor map at ${FLOORS_PATH}. Run: tsx scripts/backfill/floor-map.ts`);
  }
  return JSON.parse(fs.readFileSync(FLOORS_PATH, 'utf-8')) as FloorEntry[];
}
