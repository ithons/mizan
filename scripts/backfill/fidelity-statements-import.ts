// Add the Fidelity statement activity the ledger lacks (trades, core sweeps, dividends), from the
// reviewed data/backfill/raw/fidelity-statements/statements.json. Each row is worded the way the
// provider words it and signed by those words (directedAmount), because the statements print
// core-sweep amounts with the opposite sign. Rows at or above the provider floor, and deposit
// reversals the provider already holds under a different sign, are reported and not written.
//
//   tsx scripts/backfill/fidelity-statements-import.ts            # dry run, rolled back
//   tsx scripts/backfill/fidelity-statements-import.ts --commit
import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { getDb, closeDb } from '../../server/src/db/index';
import { recordDataImportRun } from '../../server/src/services/importRuns';
import { isBelowBackfillFloor } from '../../server/src/services/backfillFloor';
import { directedAmount, isInternalTrade } from '../../server/src/services/investmentTrades';

const SOURCE_DETAIL = 'fidelity-statement';
const INPUT = path.join(process.cwd(), 'data', 'backfill', 'raw', 'fidelity-statements', 'statements.json');
const CORE = 'FIDELITY GOVERNMENT MONEY MARKET (SPAXX)';

interface Missing { statement: string; date: string; class: string; description: string; symbol: string | null; quantity: number | null; amount_cents: number }

function worded(row: Missing): { text: string; merchant: string; category: string } | null {
  const sym = row.symbol ?? '';
  if (row.class === 'core') {
    if (row.description === 'You Bought') return { text: `PURCHASE INTO CORE ACCOUNT ${CORE} (Cash)`, merchant: 'Fidelity', category: 'cat_inv_transfer' };
    if (row.description === 'You Sold') return { text: `REDEMPTION FROM CORE ACCOUNT ${CORE} (Cash)`, merchant: 'Fidelity', category: 'cat_inv_transfer' };
    if (row.description === 'Reinvestment') return { text: `REINVESTMENT ${CORE} (Cash)`, merchant: 'Fidelity', category: 'cat_inv_transfer' };
  }
  if (row.class === 'trade' && row.description === 'You Bought') return { text: `YOU BOUGHT ${sym} (Cash)`, merchant: 'Investment Buy', category: 'cat_inv_transfer' };
  if (row.class === 'trade' && row.description === 'You Sold') return { text: `YOU SOLD ${sym} (Cash)`, merchant: 'Investment Sell', category: 'cat_inv_transfer' };
  if (row.class === 'income' && row.description === 'Dividend Received') return { text: `DIVIDEND RECEIVED ${sym} (Cash)`, merchant: 'Dividend', category: 'cat_inv_dividend' };
  if (row.class === 'income' && row.description === 'Dividend Adjustment') return { text: `DIVIDEND ADJUSTMENT ${sym} (Cash)`, merchant: 'Dividend', category: 'cat_inv_dividend' };
  return null;
}

class DryRun extends Error {}

function main(): void {
  const commit = process.argv.includes('--commit');
  const parsed = JSON.parse(fs.readFileSync(INPUT, 'utf8')) as { db_comparison: Record<string, { missing_from_db: Missing[] }> };
  const db = getDb();
  const run = () => {
    if ((db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE source_detail = ?').get(SOURCE_DETAIL) as { n: number }).n) {
      throw new Error('Fidelity statement rows are already imported; refusing to import twice');
    }
    const security = db.prepare('SELECT id FROM securities WHERE ticker = ? LIMIT 1');
    const insert = db.prepare(`
      INSERT INTO transactions
        (id, account_id, date, amount, merchant_name, original_name, category_id, category_source, review_status, pending, notes,
         is_manual, source_type, source_detail, is_internal_trade, quantity, security_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'reviewed', 0, ?, 1, 'import', ?, ?, ?, ?, ?, ?)
    `);
    const now = new Date().toISOString();
    for (const [name, { missing_from_db }] of Object.entries(parsed.db_comparison)) {
      const account = db.prepare('SELECT id, backfill_floor_date AS floor FROM accounts WHERE account_name = ?').get(name) as { id: string; floor: string | null } | undefined;
      if (!account) throw new Error(`No account named ${name}`);
      const skipped: string[] = [];
      let added = 0;
      for (const row of missing_from_db) {
        const words = worded(row);
        if (!words) { skipped.push(`${row.date} ${row.description}: provider holds it with another sign`); continue; }
        if (account.floor && !isBelowBackfillFloor(row.date, account.floor)) { skipped.push(`${row.date} ${row.description} ${row.symbol}: at or above the floor`); continue; }
        const amount = directedAmount(row.amount_cents, words.text);
        const quantity = row.quantity == null ? null : Math.sign(-amount || 1) * Math.abs(row.quantity);
        const securityId = row.symbol ? (security.get(row.symbol) as { id: string } | undefined)?.id ?? null : null;
        insert.run(uuidv4(), account.id, row.date, amount, words.merchant, words.text, words.category, words.category ? 'import' : null,
          `Fidelity statement ${row.statement}`, SOURCE_DETAIL, isInternalTrade(words.text) ? 1 : 0, quantity, securityId, now, now);
        added++;
      }
      console.log(`${name}: ${added} rows added, ${skipped.length} not written`);
      for (const line of skipped) console.log(`  ${line}`);
      recordDataImportRun(db, { source: 'csv', status: 'succeeded', rows_seen: missing_from_db.length, rows_imported: added, errors_count: 0,
        summary: `Fidelity statements: added ${added} rows to ${name}` });
    }
    if (!commit) throw new DryRun();
  };
  try {
    db.transaction(run)();
    console.log('Committed. Next: tsx scripts/backfill/rebuild.ts');
  } catch (err) {
    if (!(err instanceof DryRun)) throw err;
    console.log('Dry run: rolled back. Re-run with --commit.');
  }
}

try { main(); } finally { closeDb(); }
