import test from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import {
  applySimplefinResponse,
  reappearanceRefetch,
  triageSimplefinErrors,
} from '../server/src/services/simplefin';
import { migratedTestDb, insertAccount } from './helpers/schema';

/**
 * An account that drops out of the SimpleFIN response and comes back.
 *
 * When one institution needs a fresh login its accounts vanish from the response while the rest of
 * the connection keeps syncing hourly, and every one of those passes advanced last_synced_at. Once
 * the owner logged back in, the next request reached back an ordinary 30 days and the outage's
 * earlier rows were never asked for, with nothing said. Holding last_synced_at was tried and
 * rejected: the whole connection then reads stale while it syncs fine. The watermark is per account.
 */

const NOW = '2026-10-01T12:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const DAY = 86_400_000;
const daysBefore = (n: number): string => new Date(NOW_MS - n * DAY).toISOString();
const WINDOW_30 = NOW_MS - 30 * DAY;

function payload(ids: string[], balance = '100.00'): unknown {
  return {
    accounts: ids.map((id) => ({ id, name: id, currency: 'USD', balance, org: { name: 'Bank' }, transactions: [] })),
  };
}

function fixture(seen: Record<string, string | null>): Database.Database {
  const db = migratedTestDb();
  for (const [providerId, seenAt] of Object.entries(seen)) {
    const id = insertAccount(db, { account_name: providerId, connection_type: 'simplefin', is_manual: 0 });
    db.prepare('UPDATE accounts SET simplefin_account_id = ?, provider_seen_at = ? WHERE id = ?').run(providerId, seenAt, id);
  }
  return db;
}

function seenAt(db: Database.Database, providerId: string): string | null {
  return (db.prepare('SELECT provider_seen_at AS s FROM accounts WHERE simplefin_account_id = ?').get(providerId) as { s: string | null }).s;
}

test('HEALTHY: an hourly pass over accounts seen an hour ago reappears nothing and asks for nothing more', () => {
  const db = fixture({ checking: daysBefore(1 / 24), card: daysBefore(1 / 24) });
  const result = applySimplefinResponse(db, payload(['checking', 'card']), NOW, { windowStartMs: WINDOW_30 });
  assert.deepEqual(result.reappeared, []);
  assert.deepEqual(reappearanceRefetch(result.reappeared, 30, NOW_MS), { refetchDays: null, notices: [] });
  assert.equal(seenAt(db, 'checking'), NOW);
});

test('HEALTHY: an account never stamped before this column existed is not a reappearance', () => {
  const db = fixture({ checking: null });
  const result = applySimplefinResponse(db, payload(['checking']), NOW, { windowStartMs: WINDOW_30 });
  assert.deepEqual(result.reappeared, []);
  assert.equal(seenAt(db, 'checking'), NOW, 'the first pass stamps it');
});

test('an account back after a 45-day absence is asked for again, far enough back to cover it', () => {
  const db = fixture({ checking: daysBefore(1 / 24), card: daysBefore(45) });
  const result = applySimplefinResponse(db, payload(['checking', 'card']), NOW, { windowStartMs: WINDOW_30 });
  assert.deepEqual(result.reappeared.map((r) => r.accountName), ['card']);
  // Within what Bridge serves, so the whole absence is fetched and nothing is claimed missing.
  assert.deepEqual(reappearanceRefetch(result.reappeared, 30, NOW_MS), { refetchDays: 47, notices: [] });
});

test('an absence past what SimpleFIN serves is fetched as far as it can be, and the rest is named per account', () => {
  const card = { accountId: 'a', accountName: 'Old Card', seenAt: daysBefore(120) };
  const plan = reappearanceRefetch([card], 30, NOW_MS);
  assert.equal(plan.refetchDays, 90);
  assert.equal(plan.notices.length, 1);
  assert.match(plan.notices[0], /^Old Card was last returned by SimpleFIN on 2026-06-03, .* from 2026-06-03 to 2026-07-03 were not fetched/);
  // It is an advisory: the remedy is a CSV import, never re-linking the bank.
  assert.deepEqual(triageSimplefinErrors(plan.notices).reauth, []);
});

test('a first request that already reached the bridge limit asks nothing more, but still names what it missed', () => {
  const plan = reappearanceRefetch([{ accountId: 'a', accountName: 'Old Card', seenAt: daysBefore(120) }], 90, NOW_MS);
  assert.equal(plan.refetchDays, null);
  assert.equal(plan.notices.length, 1);
});

test('an account skipped for an unreadable balance is not stamped as seen', () => {
  const db = fixture({ checking: daysBefore(45) });
  applySimplefinResponse(db, payload(['checking'], 'not a number'), NOW, { windowStartMs: WINDOW_30 });
  assert.equal(seenAt(db, 'checking'), daysBefore(45), 'its rows were not taken, so its absence is not over');
});

test('last_synced_at still advances on a pass with an absent account, so freshness is unchanged', () => {
  const db = fixture({ checking: daysBefore(1 / 24), card: daysBefore(10) });
  db.prepare("INSERT INTO simplefin_connections (id, status, created_at) VALUES ('simplefin_primary', 'active', ?)").run(daysBefore(200));
  applySimplefinResponse(db, payload(['checking']), NOW, { windowStartMs: WINDOW_30 });
  const row = db.prepare("SELECT last_synced_at FROM simplefin_connections WHERE id = 'simplefin_primary'").get() as { last_synced_at: string };
  assert.equal(row.last_synced_at, NOW);
});

test('HEALTHY: an absence of 89 days is wholly inside what SimpleFIN serves, so no notice is written', () => {
  const plan = reappearanceRefetch([{ accountId: 'a', accountName: 'Card', seenAt: daysBefore(89) }], 30, NOW_MS);
  assert.equal(plan.refetchDays, 90);
  assert.deepEqual(plan.notices, []);
});

test('a reappeared account is left unstamped by the pass, so a failed follow-up cannot use up its absence', () => {
  const db = fixture({ checking: daysBefore(1 / 24), card: daysBefore(45) });
  applySimplefinResponse(db, payload(['checking', 'card']), NOW, { windowStartMs: WINDOW_30 });
  assert.equal(seenAt(db, 'checking'), NOW);
  assert.equal(seenAt(db, 'card'), daysBefore(45));
});

test('a closed account returning is stamped, never treated as an absence to chase', () => {
  const db = fixture({ old: daysBefore(200) });
  db.prepare("UPDATE accounts SET type = 'closed' WHERE simplefin_account_id = 'old'").run();
  const result = applySimplefinResponse(db, payload(['old']), NOW, { windowStartMs: WINDOW_30 });
  assert.deepEqual(result.reappeared, []);
  assert.equal(seenAt(db, 'old'), NOW);
});
