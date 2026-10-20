// Record each Fidelity statement's ending account value as a valuation (migration 076), and its
// month-end positions in holdings_history on dates that hold none for the account yet, from the
// reviewed data/backfill/raw/fidelity-statements/statements.json. Nothing already stored is changed.
//
//   tsx scripts/backfill/fidelity-valuations-import.ts [--commit]
import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { getDb, closeDb } from '../../server/src/db/index';

const INPUT = path.join(process.cwd(), 'data', 'backfill', 'raw', 'fidelity-statements', 'statements.json');
const ACCOUNTS = ['Fidelity Individual', 'Fidelity Roth IRA'];

type MonthEnd = Record<string, unknown> & { date: string; statement: string };
interface Holding { symbol: string; quantity: number; price: number; market_value_cents: number; cost_basis_cents: number | null }
interface Statement { file: string; period_end: string; accounts: Record<string, { holdings: Holding[] } | undefined> }

function main(): void {
  const commit = process.argv.includes('--commit');
  const { month_end_values, statements } = JSON.parse(fs.readFileSync(INPUT, 'utf8')) as { month_end_values: MonthEnd[]; statements: Statement[] };
  const db = getDb();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO account_valuations (id, account_id, date, value_cents, source, note, created_at)
    VALUES (?, ?, ?, ?, 'statement', ?, ?)
  `);
  const now = new Date().toISOString();
  const holdingRow = db.prepare(`
    INSERT INTO holdings_history (id, account_id, security_id, date, quantity, institution_price, institution_value, cost_basis, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const security = db.prepare('SELECT id FROM securities WHERE ticker = ? LIMIT 1');
  const hasDay = db.prepare('SELECT 1 FROM holdings_history WHERE account_id = ? AND date = ? LIMIT 1');
  let added = 0;
  let positions = 0;
  const run = db.transaction(() => {
    for (const name of ACCOUNTS) {
      const account = db.prepare('SELECT id FROM accounts WHERE account_name = ?').get(name) as { id: string } | undefined;
      if (!account) throw new Error(`No account named ${name}`);
      for (const month of month_end_values) {
        const value = month[name];
        if (month[`${name} present_on_statement`] !== true || typeof value !== 'number' || !Number.isInteger(value)) continue;
        added += insert.run(uuidv4(), account.id, month.date, value, `Fidelity ${month.statement}`, now).changes;
      }
      for (const statement of statements) {
        const holdings = statement.accounts[name]?.holdings ?? [];
        if (holdings.length === 0 || hasDay.get(account.id, statement.period_end)) continue;
        for (const h of holdings) {
          const sec = security.get(h.symbol) as { id: string } | undefined;
          if (!sec) throw new Error(`No security ${h.symbol}`);
          holdingRow.run(uuidv4(), account.id, sec.id, statement.period_end, h.quantity, h.price, h.market_value_cents, h.cost_basis_cents, now);
          positions++;
        }
      }
    }
  });
  if (commit) run();
  console.log(commit ? `Recorded ${added} statement valuations and ${positions} month-end positions.` : 'Dry run: pass --commit to write.');
}

try { main(); } finally { closeDb(); }
