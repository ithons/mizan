// Convert institution-specific raw exports into the canonical CSV shape, dropping
// anything at/above the account's floor (the provider already owns that range).
//
//   tsx scripts/backfill/normalize.ts            # process every job in data/backfill/jobs.json
//
// A "job" points a raw file at a target account with an adapter + its options. The
// generic-csv adapter covers most bank/brokerage CSV/OFX-exported-to-CSV files;
// add OFX/QFX/PDF adapters to ADAPTERS below as real formats show up. Output lands
// in data/backfill/normalized/<account-slug>.csv for review before import.
import fs from 'node:fs';
import path from 'node:path';
import { format, isValid, parse } from 'date-fns';
import {
  NORMALIZED_DIR, BACKFILL_DIR, loadFloors,
  parseCsv, readCanonicalCsv, writeCanonicalCsv,
  type CanonicalRow, type FloorEntry,
} from './lib';

const JOBS_PATH = path.join(BACKFILL_DIR, 'jobs.json');

export interface GenericCsvOptions {
  dateColumn: string;
  dateFormat: string;          // date-fns pattern, e.g. 'MM/dd/yyyy'
  amountColumn?: string;       // single signed column …
  debitColumn?: string;        // … OR separate debit/credit columns
  creditColumn?: string;
  flipSign?: boolean;          // true when the source uses positive = expense
  merchantColumn?: string;
  merchantStrip?: string[];    // regex sources removed from the merchant (e.g. card-network junk)
  categoryColumn?: string;
  notesColumn?: string;
}

// Strip issuer noise (e.g. Discover's "APPLE PAY ENDING IN 8537…" tail) and collapse
// whitespace, so imported merchants read cleanly instead of carrying wallet cruft.
function cleanMerchant(value: string, strip?: string[]): string {
  let out = value;
  for (const pattern of strip ?? []) out = out.replace(new RegExp(pattern, 'gi'), ' ');
  return out.replace(/\s+/g, ' ').trim();
}

export interface Job {
  adapter: keyof typeof ADAPTERS;
  account_name: string;
  file: string;                // path relative to data/backfill/
  options: GenericCsvOptions;
}

export interface NormalizeIssue { row: number; message: string }
export interface NormalizeResult { rows: CanonicalRow[]; issues: NormalizeIssue[] }

function parseAmount(raw: string | undefined): number | null {
  const t = (raw ?? '').trim();
  if (!t) return null;
  const paren = t.startsWith('(') && t.endsWith(')');
  const n = Number(t.replace(/^\((.*)\)$/, '-$1').replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n)) return null;
  return paren ? -Math.abs(n) : n;
}

// Pure core — unit-tested without touching the DB or filesystem.
export function normalizeGenericCsv(
  rawRows: Array<Record<string, string>>,
  accountName: string,
  opts: GenericCsvOptions
): NormalizeResult {
  const rows: CanonicalRow[] = [];
  const issues: NormalizeIssue[] = [];

  rawRows.forEach((raw, i) => {
    const rowNum = i + 1;
    const rawDate = (raw[opts.dateColumn] ?? '').trim();
    const parsed = parse(rawDate, opts.dateFormat, new Date());
    if (!isValid(parsed)) { issues.push({ row: rowNum, message: `invalid date "${rawDate}"` }); return; }
    const date = format(parsed, 'yyyy-MM-dd');

    let amount: number | null;
    if (opts.amountColumn) {
      amount = parseAmount(raw[opts.amountColumn]);
      if (amount != null && opts.flipSign) amount = -amount;
    } else {
      // Debit/credit pair: credit is inflow (+), debit is outflow (−).
      const debit = parseAmount(raw[opts.debitColumn ?? '']) ?? 0;
      const credit = parseAmount(raw[opts.creditColumn ?? '']) ?? 0;
      amount = credit - Math.abs(debit);
    }
    if (amount == null) { issues.push({ row: rowNum, message: 'invalid amount' }); return; }

    rows.push({
      account_name: accountName,
      date,
      amount: amount.toFixed(2),
      merchant: opts.merchantColumn ? cleanMerchant(raw[opts.merchantColumn] ?? '', opts.merchantStrip) : '',
      category: opts.categoryColumn ? (raw[opts.categoryColumn] ?? '').trim() : '',
      notes: opts.notesColumn ? (raw[opts.notesColumn] ?? '').trim() : '',
    });
  });

  return { rows, issues };
}

// Adapter registry. Each adapter turns a raw file's text into canonical rows.
// Add 'ofx', 'qfx', 'pdf-<bank>' entries here as real formats arrive.
const ADAPTERS = {
  'generic-csv': (text: string, job: Job): NormalizeResult =>
    normalizeGenericCsv(parseCsv(text), job.account_name, job.options),
} as const;

// Keep manual history strictly below the floor; the provider owns at/above it.
export function applyFloor(rows: CanonicalRow[], floor: string | null): {
  kept: CanonicalRow[]; dropped: number;
} {
  if (!floor) return { kept: rows, dropped: 0 };
  const kept = rows.filter((r) => r.date < floor);
  return { kept, dropped: rows.length - kept.length };
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function main(): void {
  if (!fs.existsSync(JOBS_PATH)) {
    console.log(`No jobs file at ${JOBS_PATH}.\n\nCreate one shaped like:\n` + JSON.stringify([{
      adapter: 'generic-csv', account_name: 'Chase Checking', file: 'raw/chase-2019-2024.csv',
      options: { dateColumn: 'Posting Date', dateFormat: 'MM/dd/yyyy', amountColumn: 'Amount', merchantColumn: 'Description' },
    }], null, 2));
    return;
  }

  const jobs = JSON.parse(fs.readFileSync(JOBS_PATH, 'utf-8')) as Job[];
  const floors = loadFloors();
  const floorByName = new Map<string, FloorEntry>(floors.map((f) => [f.account_name, f]));

  // Accumulate per account so multiple source files for one account merge cleanly.
  const byAccount = new Map<string, CanonicalRow[]>();

  for (const job of jobs) {
    const adapter = ADAPTERS[job.adapter];
    if (!adapter) { console.error(`✗ unknown adapter "${job.adapter}" for ${job.account_name}`); continue; }
    const floor = floorByName.get(job.account_name);
    if (!floor) { console.error(`✗ no floor entry for account "${job.account_name}" — run floor-map.ts`); continue; }

    const raw = fs.readFileSync(path.join(BACKFILL_DIR, job.file), 'utf-8');
    const { rows, issues } = adapter(raw, job);
    const { kept, dropped } = applyFloor(rows, floor.floor);
    byAccount.set(job.account_name, [...(byAccount.get(job.account_name) ?? []), ...kept]);

    console.log(
      `${job.account_name}: ${rows.length} parsed, ${dropped} at/above floor dropped, ` +
      `${kept.length} kept${issues.length ? `, ${issues.length} issue(s)` : ''}`
    );
    for (const issue of issues.slice(0, 10)) console.log(`   row ${issue.row}: ${issue.message}`);
  }

  for (const [accountName, rows] of byAccount) {
    rows.sort((a, b) => a.date.localeCompare(b.date));
    const out = path.join(NORMALIZED_DIR, `${slug(accountName)}.csv`);
    writeCanonicalCsv(out, rows);
    console.log(`→ ${out} (${rows.length} rows)`);
  }
  void readCanonicalCsv; // exported for downstream scripts/tests
}

if (process.argv[1] && process.argv[1].endsWith('normalize.ts')) main();
