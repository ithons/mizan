// Record each Fidelity statement's ending account value as a valuation (migration 076), from the
// reviewed data/backfill/raw/fidelity-statements/statements.json. A valuation already stored for
// that account and date is left as it is.
//
//   tsx scripts/backfill/fidelity-valuations-import.ts [--commit]
import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { getDb, closeDb } from '../../server/src/db/index';

const INPUT = path.join(process.cwd(), 'data', 'backfill', 'raw', 'fidelity-statements', 'statements.json');
const ACCOUNTS = ['Fidelity Individual', 'Fidelity Roth IRA'];

type MonthEnd = Record<string, unknown> & { date: string; statement: string };

function main(): void {
  const commit = process.argv.includes('--commit');
  const { month_end_values } = JSON.parse(fs.readFileSync(INPUT, 'utf8')) as { month_end_values: MonthEnd[] };
  const db = getDb();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO account_valuations (id, account_id, date, value_cents, source, note, created_at)
    VALUES (?, ?, ?, ?, 'statement', ?, ?)
  `);
  const now = new Date().toISOString();
  let added = 0;
  const run = db.transaction(() => {
    for (const name of ACCOUNTS) {
      const account = db.prepare('SELECT id FROM accounts WHERE account_name = ?').get(name) as { id: string } | undefined;
      if (!account) throw new Error(`No account named ${name}`);
      for (const month of month_end_values) {
        const value = month[name];
        if (month[`${name} present_on_statement`] !== true || typeof value !== 'number' || !Number.isInteger(value)) continue;
        added += insert.run(uuidv4(), account.id, month.date, value, `Fidelity ${month.statement}`, now).changes;
      }
    }
  });
  if (commit) run();
  console.log(commit ? `Recorded ${added} statement valuations.` : 'Dry run: pass --commit to write.');
}

try { main(); } finally { closeDb(); }
