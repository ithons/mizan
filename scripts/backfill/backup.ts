// Durability insurance: export a full local backup (the same JSON the app's
// backup/restore uses) after the backfill. If the SQLite file is ever lost, this
// plus the raw sources restores the entire hand-built history — so it never has to
// be done twice.
//
//   tsx scripts/backfill/backup.ts
import fs from 'node:fs';
import path from 'node:path';
import { getDb, closeDb } from '../../server/src/db/index';
import { buildLocalBackup } from '../../server/src/services/localBackup';
import { BACKFILL_DIR } from './lib';

function main(): void {
  const db = getDb();
  const backup = buildLocalBackup(db);

  const dir = path.join(BACKFILL_DIR, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = backup.exported_at.replace(/[:.]/g, '-');
  const out = path.join(dir, `backup-${stamp}.json`);
  fs.writeFileSync(out, JSON.stringify(backup, null, 2));

  const txns = backup.tables.transactions.length;
  const accts = backup.tables.accounts.length;
  console.log(`Wrote ${out}\n  ${accts} account(s), ${txns} transaction(s).`);
  console.log('Restore path if ever needed: Settings → Restore (or restoreLocalBackup) with this file.');
}

try { main(); } finally { closeDb(); }
