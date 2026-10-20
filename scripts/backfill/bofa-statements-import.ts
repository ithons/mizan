// Import the reconciled BofA checking and savings statements (bofa_statements.py output) into the
// two closed manual accounts, then prove the ledger reproduces every statement: each section's
// total, and the balance at each statement's end walked back from the account's current balance.
//
//   tsx scripts/backfill/bofa-statements-import.ts            # dry run: insert, verify, roll back
//   tsx scripts/backfill/bofa-statements-import.ts --commit
//   tsx scripts/backfill/bofa-statements-import.ts --verify   # re-check an imported ledger
import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import { getDb, closeDb } from '../../server/src/db/index';
import { recordDataImportRun } from '../../server/src/services/importRuns';
import { isInternalTrade } from '../../server/src/services/investmentTrades';

const SOURCE_DETAIL = 'bofa-statement-scan';
const INPUT = path.join(process.cwd(), 'data', 'backfill', 'raw', 'bofa-statements', 'statements.json');
const ACCOUNTS = {
  checking: { name: 'BofA Checking' },
  savings: { name: 'BofA Savings' },
} as const;
type Folder = keyof typeof ACCOUNTS;
type Section = 'deposits' | 'atm' | 'other' | 'fees';

interface Row { date: string; desc: string; cents: number; section: Section; page: string; merchant: string; category_id: string | null }
interface Statement {
  start: string; end: string; product: string | null; number: string | null;
  summary: Record<'begin' | 'end' | Section, number>; rows: Row[];
}

class DryRun extends Error {}

function accountFor(db: Database.Database, folder: Folder): { id: string; current_balance: number } {
  const found = db.prepare(`
    SELECT id, current_balance FROM accounts WHERE account_name = ? AND connection_type = 'manual' AND balance_only = 0
  `).all(ACCOUNTS[folder].name) as Array<{ id: string; current_balance: number }>;
  if (found.length !== 1) throw new Error(`${ACCOUNTS[folder].name}: ${found.length} matching manual accounts, expected 1`);
  return found[0];
}

function insertAll(db: Database.Database, folder: Folder, statements: Statement[], now: string): number {
  const account = accountFor(db, folder);
  const existing = (db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE account_id = ?').get(account.id) as { n: number }).n;
  if (existing > 0) throw new Error(`${ACCOUNTS[folder].name} already holds ${existing} rows; refusing to import twice`);
  const number = statements[0].number;
  const wrong = statements.find((s) => !s.number || s.number !== number);
  if (wrong) throw new Error(`${folder} statement ${wrong.start} names a different account than ${statements[0].start}`);
  const last = statements[statements.length - 1].summary.end;
  const net = statements.reduce((sum, s) => sum + s.rows.reduce((t, r) => t + r.cents, 0), 0);
  if (statements[0].summary.begin + net !== last) throw new Error(`${folder}: rows do not carry the first balance to the last`);
  if (account.current_balance !== last) {
    throw new Error(`${ACCOUNTS[folder].name} holds ${account.current_balance} cents, its last statement ended at ${last}`);
  }

  const insert = db.prepare(`
    INSERT INTO transactions
      (id, account_id, date, amount, merchant_name, original_name, category_id, review_status,
       pending, notes, is_manual, source_type, source_detail, is_internal_trade, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 1, 'import', ?, ?, ?, ?)
  `);
  let n = 0;
  for (const s of statements) {
    for (const r of s.rows) {
      insert.run(uuidv4(), account.id, r.date, r.cents, r.merchant, r.desc, r.category_id,
        r.category_id ? 'reviewed' : 'open', `BofA statement ${s.start} to ${s.end}, ${r.page}`,
        SOURCE_DETAIL, isInternalTrade(r.desc) ? 1 : 0, now, now);
      n++;
    }
  }
  db.prepare('UPDATE accounts SET mask = ?, subtype = ?, updated_at = ? WHERE id = ?')
    .run(number!.slice(-4), statements[statements.length - 1].product, now, account.id);
  return n;
}

function verify(db: Database.Database, folder: Folder, statements: Statement[]): string[] {
  const account = accountFor(db, folder);
  const rows = db.prepare(`
    SELECT date, amount, notes FROM transactions WHERE account_id = ? AND source_detail = ?
  `).all(account.id, SOURCE_DETAIL) as Array<{ date: string; amount: number; notes: string }>;
  const failures: string[] = [];
  for (const s of statements) {
    const tag = `BofA statement ${s.start} to ${s.end},`;
    const mine = rows.filter((r) => r.notes.startsWith(tag));
    const sections: Section[] = ['deposits', 'atm', 'other', 'fees'];
    const printedNet = sections.reduce((sum, k) => sum + s.summary[k], 0);
    const storedNet = mine.reduce((sum, r) => sum + r.amount, 0);
    if (mine.length !== s.rows.length) failures.push(`${folder} ${s.start}: ${mine.length} rows stored, ${s.rows.length} printed`);
    if (storedNet !== printedNet) failures.push(`${folder} ${s.start}: stored net ${storedNet}, printed ${printedNet}`);
    const after = rows.filter((r) => r.date > s.end).reduce((sum, r) => sum + r.amount, 0);
    if (account.current_balance - after !== s.summary.end) {
      failures.push(`${folder} ${s.end}: ledger balance ${account.current_balance - after}, statement ${s.summary.end}`);
    }
  }
  return failures;
}

function main(): void {
  const mode = process.argv.includes('--commit') ? 'commit' : process.argv.includes('--verify') ? 'verify' : 'dry';
  const input = JSON.parse(fs.readFileSync(INPUT, 'utf8')) as Record<Folder, Statement[]>;
  const db = getDb();
  const folders = Object.keys(ACCOUNTS) as Folder[];
  const run = () => {
    if (mode !== 'verify') {
      const now = new Date().toISOString();
      for (const folder of folders) {
        const n = insertAll(db, folder, input[folder], now);
        console.log(`${ACCOUNTS[folder].name}: ${n} rows from ${input[folder].length} statements`);
        recordDataImportRun(db, {
          source: 'csv', status: 'succeeded', rows_seen: n, rows_imported: n, errors_count: 0,
          summary: `Scanned BofA statements ${input[folder][0].start} to ${input[folder].at(-1)!.end} -> ${ACCOUNTS[folder].name}`,
        });
      }
    }
    const failures = folders.flatMap((folder) => verify(db, folder, input[folder]));
    if (failures.length) throw new Error(`Ledger does not reproduce the statements:\n${failures.join('\n')}`);
    console.log(`Verified: all ${folders.reduce((n, f) => n + input[f].length, 0)} statements reproduce to the cent.`);
    if (mode === 'dry') throw new DryRun();
  };
  try {
    db.transaction(run)();
    if (mode === 'commit') console.log('Committed. Next: tsx scripts/backfill/rebuild.ts');
  } catch (err) {
    if (!(err instanceof DryRun)) throw err;
    console.log('Dry run: rolled back. Re-run with --commit.');
  }
}

try { main(); } finally { closeDb(); }
