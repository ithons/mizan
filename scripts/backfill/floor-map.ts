// Read-only inventory of every account + the oldest date its provider currently
// serves. That oldest date becomes the account's backfill floor: manual history
// fills strictly below it, the provider owns at/above it.
//
//   tsx scripts/backfill/floor-map.ts            # write data/backfill/floors.json + print
//   tsx scripts/backfill/floor-map.ts --apply    # write floors.json's `floor` into accounts
//
// Review (and hand-edit) floors.json BEFORE --apply. --apply is what arms the
// permanent sync guard (migration 030 / backfillFloor.ts).
import fs from 'node:fs';
import { getDb, closeDb } from '../../server/src/db/index';
import { BACKFILL_DIR, FLOORS_PATH, loadFloors, type FloorEntry } from './lib';

function buildFloorMap(): FloorEntry[] {
  const db = getDb();
  const accounts = db.prepare(`
    SELECT id, account_name, institution_name, connection_type, type, is_manual
    FROM accounts
    ORDER BY connection_type, account_name
  `).all() as Array<{
    id: string; account_name: string; institution_name: string;
    connection_type: string; type: string; is_manual: number;
  }>;

  // Oldest PROVIDER-served date, ignoring any rows already imported/entered by hand —
  // the floor tracks what the aggregator owns, not what we backfill below it.
  const providerStats = db.prepare(`
    SELECT MIN(date) AS oldest, COUNT(*) AS count
    FROM transactions
    WHERE account_id = ? AND source_type NOT IN ('import', 'manual')
  `);

  return accounts.map((a) => {
    const stats = providerStats.get(a.id) as { oldest: string | null; count: number };
    return {
      account_id: a.id,
      account_name: a.account_name,
      institution_name: a.institution_name,
      provider: a.connection_type,
      type: a.type,
      is_manual: Boolean(a.is_manual),
      oldest_synced_date: stats.oldest,
      synced_count: stats.count,
      floor: stats.oldest,
    };
  });
}

function applyFloors(): void {
  const db = getDb();
  const floors = loadFloors();
  const update = db.prepare('UPDATE accounts SET backfill_floor_date = ?, updated_at = ? WHERE id = ?');
  const now = new Date().toISOString();
  const apply = db.transaction((entries: FloorEntry[]) => {
    let n = 0;
    for (const e of entries) {
      update.run(e.floor, now, e.account_id);
      n++;
    }
    return n;
  });
  const n = apply(floors);
  console.log(`[floor-map] Applied floors to ${n} account(s).`);
  for (const e of floors) {
    console.log(`  ${e.account_name.padEnd(28)} floor=${e.floor ?? '(none)'}`);
  }
}

function main(): void {
  const apply = process.argv.includes('--apply');
  if (apply) { applyFloors(); return; }

  const entries = buildFloorMap();
  fs.mkdirSync(BACKFILL_DIR, { recursive: true });
  fs.writeFileSync(FLOORS_PATH, JSON.stringify(entries, null, 2) + '\n');

  console.log(`[floor-map] Wrote ${entries.length} account(s) to ${FLOORS_PATH}\n`);
  console.log('provider     account                       oldest       count   floor');
  console.log('─'.repeat(78));
  for (const e of entries) {
    console.log(
      `${e.provider.padEnd(12)} ${e.account_name.slice(0, 28).padEnd(28)} ` +
      `${(e.oldest_synced_date ?? '—').padEnd(12)} ${String(e.synced_count).padStart(5)}   ${e.floor ?? '—'}`
    );
  }
  console.log('\nReview/edit floors.json, then arm the guard with:  tsx scripts/backfill/floor-map.ts --apply');
}

try { main(); } finally { closeDb(); }
