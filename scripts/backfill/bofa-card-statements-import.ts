// Add what the BofA card's statements carry and its ledger lacks (bofa_card_statements.py output),
// then prove the card's ledger reproduces every statement's new balance at its closing date.
// A statement row counts as present when the card already holds a row of the same cents within
// five days of its posting date, so rows from earlier imports and the provider are never doubled.
//
//   tsx scripts/backfill/bofa-card-statements-import.ts            # dry run: insert, verify, roll back
//   tsx scripts/backfill/bofa-card-statements-import.ts --commit
//   tsx scripts/backfill/bofa-card-statements-import.ts --verify
import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import { getDb, closeDb } from '../../server/src/db/index';
import { recordDataImportRun } from '../../server/src/services/importRuns';
import { isBelowBackfillFloor } from '../../server/src/services/backfillFloor';

const ACCOUNT = 'BofA Cash Rewards';
const SOURCE_DETAIL = 'bofa-card-statement';
const INPUT = path.join(process.cwd(), 'data', 'backfill', 'raw', 'bofa-card-statements.json');
const MATCH_DAYS = 5;

interface Row { section: 'credits' | 'purchases' | 'fees' | 'interest'; date: string; transaction_date: string; desc: string; reference: string | null; cents: number }
interface Statement { file: string; start: string; close: string; summary: Record<'previous' | 'new', number>; rows: Row[] }
interface Ledger { id: string; date: string; amount: number }

class DryRun extends Error {}

const day = (iso: string) => Math.round(Date.parse(`${iso}T00:00:00Z`) / 86_400_000);

function card(db: Database.Database): { id: string; current_balance: number; floor: string | null } {
  const found = db.prepare('SELECT id, current_balance, backfill_floor_date AS floor FROM accounts WHERE account_name = ? AND is_liability = 1')
    .all(ACCOUNT) as Array<{ id: string; current_balance: number; floor: string | null }>;
  if (found.length !== 1) throw new Error(`${ACCOUNT}: ${found.length} matching cards, expected 1`);
  return found[0];
}

function absent(statements: Statement[], ledger: Ledger[]): Array<Row & { statement: Statement }> {
  const free = new Map(ledger.map((r) => [r.id, r]));
  let pending = statements.flatMap((statement) => statement.rows.map((row) => ({ ...row, statement })));
  for (let gap = 0; gap <= MATCH_DAYS; gap++) {
    pending = pending.filter((row) => {
      const hit = [...free.values()].filter((r) => r.amount === row.cents && Math.abs(day(r.date) - day(row.date)) === gap)
        .sort((a, b) => a.id.localeCompare(b.id))[0];
      if (hit) free.delete(hit.id);
      return !hit;
    });
  }
  return pending;
}

function merchantFor(row: Row): { merchant: string; category: string } {
  if (row.section === 'fees') return { merchant: 'Foreign transaction fee', category: 'cat_fees' };
  if (row.section === 'interest') return { merchant: 'Interest charged', category: 'cat_fees' };
  const from = /from (SAV|CHK) \d{4}/.exec(row.desc);
  if (from) return { merchant: `Payment from BofA ${from[1] === 'SAV' ? 'Savings' : 'Checking'}`, category: 'cat_xfer_cc' };
  if (/PAYMENT - THANK YOU|BA ELECTRONIC PAYMENT|ONLINE\/MOBILE RECURRING/.test(row.desc)) return { merchant: 'Payment', category: 'cat_xfer_cc' };
  throw new Error(`No mapping for a missing ${row.section} row: ${row.date} ${row.desc}`);
}

function verify(db: Database.Database, statements: Statement[]): string[] {
  const account = card(db);
  const ledger = db.prepare('SELECT date, amount FROM transactions WHERE account_id = ? AND pending = 0').all(account.id) as Ledger[];
  return statements.flatMap((s) => {
    const owed = account.current_balance + ledger.filter((r) => r.date > s.close).reduce((sum, r) => sum + r.amount, 0);
    return owed === s.summary.new ? [] : [`${s.close}: ledger owes ${owed}, statement ${s.summary.new}`];
  });
}

function main(): void {
  const mode = process.argv.includes('--commit') ? 'commit' : process.argv.includes('--verify') ? 'verify' : 'dry';
  const statements = JSON.parse(fs.readFileSync(INPUT, 'utf8')) as Statement[];
  const db = getDb();
  const run = () => {
    if (mode !== 'verify') {
      const account = card(db);
      const ledger = db.prepare('SELECT id, date, amount FROM transactions WHERE account_id = ?').all(account.id) as Ledger[];
      const missing = absent(statements, ledger);
      const aboveFloor = missing.filter((row) => account.floor && !isBelowBackfillFloor(row.date, account.floor));
      if (aboveFloor.length) throw new Error(`${aboveFloor.length} missing rows sit at or above the provider floor ${account.floor}; refusing`);
      const now = new Date().toISOString();
      const insert = db.prepare(`
        INSERT INTO transactions
          (id, account_id, date, amount, merchant_name, original_name, category_id, category_source, review_status,
           pending, notes, is_manual, source_type, source_detail, is_internal_trade, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'reviewed', 0, ?, 1, 'import', ?, 0, ?, ?)
      `);
      for (const row of missing) {
        const { merchant, category } = merchantFor(row);
        insert.run(uuidv4(), account.id, row.date, row.cents, merchant, row.reference ? `${row.desc} REF ${row.reference}` : row.desc, category,
          category ? 'import' : null,
          `BofA card statement ${row.statement.start} to ${row.statement.close}, ref ${row.reference ?? 'none'}, transaction date ${row.transaction_date}`,
          SOURCE_DETAIL, now, now);
      }
      console.log(`${ACCOUNT}: ${missing.length} statement rows were missing and are now added`);
      recordDataImportRun(db, {
        source: 'csv', status: 'succeeded', rows_seen: statements.reduce((n, s) => n + s.rows.length, 0), rows_imported: missing.length,
        errors_count: 0, summary: `BofA card statements ${statements[0].start} to ${statements.at(-1)!.close}: added ${missing.length} rows the ledger lacked`,
      });
    }
    const failures = verify(db, statements);
    if (failures.length) throw new Error(`Ledger does not reproduce the statements:\n${failures.join('\n')}`);
    console.log(`Verified: the card's ledger reproduces all ${statements.length} statement balances to the cent.`);
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
