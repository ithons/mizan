import test from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { transfersInTransit } from '../server/src/services/inTransit';
import { getNetWorthAttribution } from '../server/src/services/reporting';
import { netWorthTimeline } from '../server/src/services/netWorthTimeline';
import { _setDbForTesting } from '../server/src/db/index';
import { runAdvisorTool } from '../server/src/services/advisorChatTools';
import { buildFinancialContext } from '../server/src/services/aiContext';
import { insertAccount, insertTransaction, migratedTestDb } from './helpers/schema';

function snapshot(db: Database.Database, date: string, createdAt: string, breakdown: Record<string, number>): void {
  const netWorth = Object.values(breakdown).reduce((sum, value) => sum + value, 0);
  db.prepare(`
    INSERT INTO net_worth_snapshots (id, date, total_assets, total_liabilities, net_worth, breakdown, is_estimated, created_at)
    VALUES (?, ?, ?, 0, ?, ?, 0, ?)
  `).run(`snap_${date}`, date, netWorth, netWorth, JSON.stringify(breakdown), createdAt);
}

function leg(db: Database.Database, accountId: string, date: string, amount: number, createdAt: string, pairId: string): void {
  const id = insertTransaction(db, { account_id: accountId, date, amount, original_name: amount < 0 ? 'Wealthfront EDI PYMNTS' : 'Chase (Account ****6391)' });
  db.prepare("UPDATE transactions SET created_at = ?, transfer_pair_id = ?, transfer_status = 'confirmed', source_type = 'simplefin' WHERE id = ?")
    .run(createdAt, pairId, id);
}

/** The real case: $5,000 left Chase on 09-30, and Wealthfront did not show it until 10-15. */
function chaseToWealthfront(db: Database.Database) {
  const chase = insertAccount(db, { id: 'chase', account_name: 'Chase Checking', type: 'checking' });
  const wealthfront = insertAccount(db, { id: 'wf', account_name: 'Wealthfront Cash', type: 'savings' });
  snapshot(db, '2026-09-30', '2026-10-01T02:51:10.116Z', { chase: 1104728, wf: 321 });
  snapshot(db, '2026-10-01', '2026-10-01T18:55:11.836Z', { chase: 650016, wf: 321 });
  snapshot(db, '2026-10-15', '2026-10-15T17:50:55.727Z', { chase: 583948, wf: 500370 });
  leg(db, chase, '2026-09-30', -500000, '2026-10-01T18:55:04.759Z', 'xfer_wf');
  leg(db, wealthfront, '2026-09-30', 500000, '2026-10-15T17:50:47.307Z', 'xfer_wf');
  return { chase, wealthfront };
}

test('what moved net worth is read off the timeline, where a transfer moves both accounts on its own date', () => {
  const db = migratedTestDb();
  const { chase, wealthfront } = chaseToWealthfront(db);
  db.prepare('UPDATE accounts SET current_balance = ? WHERE id = ?').run(583948, chase);
  db.prepare('UPDATE accounts SET current_balance = ? WHERE id = ?').run(500370, wealthfront);
  insertTransaction(db, { account_id: chase, date: '2026-09-01', amount: 1083948 });
  insertTransaction(db, { account_id: wealthfront, date: '2026-09-01', amount: 370 });
  const attribution = getNetWorthAttribution(db, { startDate: '2026-09-29', endDate: '2026-10-01' });
  assert.ok(attribution);
  const timeline = netWorthTimeline(db, { from: '2026-09-29', to: '2026-10-01' });
  assert.equal(attribution.end_net_worth, timeline.points.at(-1)!.net_worth);
  assert.equal(attribution.start_net_worth, timeline.points[0].net_worth);
  assert.equal(attribution.delta, 0, 'money that left one account and reached the other is no movement');
  assert.deepEqual(attribution.accounts.map((a) => [a.account_id, a.delta]), [[chase, -500000], [wealthfront, 500000]]);
});

test('a transfer both banks had shown, or neither, is not in flight', () => {
  const db = migratedTestDb();
  chaseToWealthfront(db);
  const breakdown = { chase: 0, wf: 0 };
  assert.equal(transfersInTransit(db, { date: '2026-10-15', taken_at: '2026-10-15T18:00:00Z', created_at: '', breakdown }).total, 0);
  assert.equal(transfersInTransit(db, { date: '2026-09-30', taken_at: '2026-10-01T02:51:10Z', created_at: '', breakdown }).total, 0);
});

test('a transfer imported long after it settled is not taken for one in flight', () => {
  const db = migratedTestDb();
  const chase = insertAccount(db, { id: 'chase', type: 'checking' });
  const fid = insertAccount(db, { id: 'fid', type: 'brokerage' });
  leg(db, chase, '2026-04-13', -10000, '2026-07-01T00:00:00Z', 'xfer_old');
  leg(db, fid, '2026-04-13', 10000, '2026-07-24T03:33:30Z', 'xfer_old');
  const transit = transfersInTransit(db, { date: '2026-07-10', taken_at: '2026-07-10T12:00:00Z', created_at: '', breakdown: { chase: 0, fid: 0 } });
  assert.equal(transit.total, 0);
});

test('a leg synced live against its partner backfilled from a file months later is not in flight', () => {
  const db = migratedTestDb();
  const chase = insertAccount(db, { id: 'chase', type: 'checking' });
  const fid = insertAccount(db, { id: 'fid', type: 'brokerage' });
  leg(db, chase, '2026-04-13', -10000, '2026-04-14T09:00:00Z', 'xfer_csv');
  leg(db, fid, '2026-04-13', 10000, '2026-07-24T03:33:30Z', 'xfer_csv');
  db.prepare("UPDATE transactions SET source_type = 'import' WHERE account_id = 'fid'").run();
  const transit = transfersInTransit(db, { date: '2026-05-01', taken_at: '2026-05-01T12:00:00Z', created_at: '', breakdown: { chase: 0, fid: 0 } });
  assert.equal(transit.total, 0);
});

test('a card payment the card had not yet shown counts against what the card owes', () => {
  const db = migratedTestDb();
  const checking = insertAccount(db, { id: 'chase', type: 'checking' });
  const card = insertAccount(db, { id: 'disc', type: 'credit', is_liability: 1 });
  leg(db, checking, '2026-10-14', -33143, '2026-10-14T20:00:00Z', 'xfer_card');
  leg(db, card, '2026-10-12', 33143, '2026-10-16T09:00:00Z', 'xfer_card');
  const transit = transfersInTransit(db, { date: '2026-10-15', taken_at: '2026-10-15T09:00:00Z', created_at: '', breakdown: { chase: 0, disc: 0 } });
  assert.equal(transit.total, 33143);
  assert.equal(transit.byAccount.get('disc'), -33143);
});

test('money that arrived before its sending bank showed it leaving is counted once, not twice', () => {
  const db = migratedTestDb();
  const chase = insertAccount(db, { id: 'chase', type: 'checking' });
  const wf = insertAccount(db, { id: 'wf', type: 'savings' });
  leg(db, wf, '2026-08-19', -200322, '2026-08-21T10:00:00Z', 'xfer_back');
  leg(db, chase, '2026-08-19', 200322, '2026-08-19T20:00:00Z', 'xfer_back');
  const transit = transfersInTransit(db, { date: '2026-08-20', taken_at: '2026-08-20T09:00:00Z', created_at: '', breakdown: { chase: 0, wf: 0 } });
  assert.equal(transit.total, -200322);
  assert.equal(transit.byAccount.get('wf'), -200322);
});

test('the advisor reads the same net worth history the charts draw, which needs no in-transit note', (t) => {
  const db = migratedTestDb();
  t.after(() => { _setDbForTesting(null); db.close(); });
  _setDbForTesting(db);
  const { chase, wealthfront } = chaseToWealthfront(db);
  insertTransaction(db, { account_id: chase, date: '2026-09-01', amount: 1083948 });
  insertTransaction(db, { account_id: wealthfront, date: '2026-09-01', amount: 370 });
  db.prepare('UPDATE accounts SET current_balance = ? WHERE id = ?').run(583948, chase);
  db.prepare('UPDATE accounts SET current_balance = ? WHERE id = ?').run(500370, wealthfront);
  type Row = { date: string; net_worth: number; assets: number; liabilities: number };
  const history = (runAdvisorTool(db, 'get_net_worth_history', { months: 60 }) as { history: Row[] }).history;
  const timeline = netWorthTimeline(db, { from: history[0].date, step: 'week' });
  assert.deepEqual(history.map((r) => [r.date, r.net_worth]), timeline.points.map((p) => [p.date, p.net_worth / 100]));
  assert.doesNotMatch(buildFinancialContext(), /Balance shows/);
});
