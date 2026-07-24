// Create the user's closed deposit accounts (no export source yet) as first-class type='closed'
// accounts at $0. They stay out of the live account list and current net worth, but their
// historical transactions (backfilled later from bank-statement PDFs) will rebuild past net worth.
// Idempotent: skips any that already exist by (account_name, type='closed').
import { getDb, closeDb } from '../../server/src/db/index';
import { createManualAccount } from '../../server/src/services/accounts';

const db = getDb();
const now = new Date().toISOString();

const CLOSED = [
  { account_name: 'BofA Checking', institution_name: 'Bank of America' },
  { account_name: 'BofA Savings', institution_name: 'Bank of America' },
  { account_name: 'Chase Savings', institution_name: 'Chase' },
];

for (const spec of CLOSED) {
  const existing = db.prepare(
    "SELECT id FROM accounts WHERE account_name = ? AND type = 'closed'"
  ).get(spec.account_name) as { id: string } | undefined;
  if (existing) {
    console.log(`[closed] skip (exists): ${spec.account_name}`);
    continue;
  }
  const row = createManualAccount(db, {
    account_name: spec.account_name,
    institution_name: spec.institution_name,
    type: 'closed',
    current_balance: 0,
    currency: 'USD',
  }) as { id: string };
  // Mark type/name as user-chosen so nothing ever re-derives them.
  db.prepare("UPDATE accounts SET type_source = 'manual', name_source = 'manual', updated_at = ? WHERE id = ?")
    .run(now, row.id);
  console.log(`[closed] created: ${spec.account_name} (${row.id})`);
}

closeDb();
