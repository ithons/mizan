import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeAccounts, remapAccountIdInSnapshots } from '../server/src/services/accounts';
import { insertAccount, insertTransaction, migratedTestDb } from './helpers/schema';

/**
 * Migrations 033 and 039 each taught a lesson by hand-repairing the live database, and neither
 * lesson was ever put into `mergeAccounts`: 033 had to rebuild `holdings_history` rows that a
 * consolidation destroyed, and 039 had to fold the deleted account ids out of historical
 * breakdowns afterwards. A repair that is not also a guard decays, so these pin the guards.
 */

function seedSecurity(db: ReturnType<typeof migratedTestDb>, id: string): string {
  db.prepare("INSERT INTO securities (id, name, type) VALUES (?, ?, 'equity')").run(id, id);
  return id;
}

function addHistory(
  db: ReturnType<typeof migratedTestDb>,
  accountId: string,
  securityId: string,
  date: string,
  quantity: number,
  value: number,
  costBasis: number | null = null
): void {
  db.prepare(`
    INSERT INTO holdings_history
      (id, account_id, security_id, date, quantity, institution_price, institution_value,
       cost_basis, created_at)
    VALUES (?, ?, ?, ?, ?, 1.0, ?, ?, '2026-07-01')
  `).run(`${accountId}-${securityId}-${date}`, accountId, securityId, date, quantity, value, costBasis);
}

test('merging a provider-linked account does not violate the unique provider id', () => {
  const db = migratedTestDb();
  const target = insertAccount(db, { type: 'checking' });
  const source = insertAccount(db, { type: 'checking' });
  db.prepare('UPDATE accounts SET simplefin_account_id = ?, connection_type = ? WHERE id = ?')
    .run('sf-123', 'simplefin', source);

  // simplefin_account_id is UNIQUE and SQLite has no deferred unique constraints, so writing the
  // source's id onto the target while the source row still held it threw outright. Merging any
  // SimpleFIN account failed with a raw constraint error.
  const result = mergeAccounts(db, target, source);
  assert.deepEqual(result, { ok: true });

  const row = db.prepare('SELECT simplefin_account_id, connection_type FROM accounts WHERE id = ?')
    .get(target) as { simplefin_account_id: string; connection_type: string };
  assert.equal(row.simplefin_account_id, 'sf-123');
  assert.equal(row.connection_type, 'simplefin');
  assert.equal(db.prepare('SELECT id FROM accounts WHERE id = ?').get(source), undefined, 'the source row is gone');
  db.close();
});

test('merging carries holdings_history across instead of cascading it away', () => {
  const db = migratedTestDb();
  const target = insertAccount(db);
  const source = insertAccount(db);
  const vt = seedSecurity(db, 'sec_vt');
  addHistory(db, source, vt, '2026-06-01', 10, 100000);
  addHistory(db, source, vt, '2026-07-01', 12, 120000);

  mergeAccounts(db, target, source);

  // account_id carries ON DELETE CASCADE, so before this fix deleting the source destroyed exactly
  // the rows migration 033 had to rebuild by hand.
  const rows = db.prepare(
    'SELECT date, quantity, institution_value FROM holdings_history WHERE account_id = ? ORDER BY date'
  ).all(target) as Array<{ date: string; quantity: number; institution_value: number }>;
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.institution_value), [100000, 120000]);
  assert.equal(
    (db.prepare('SELECT COUNT(*) n FROM holdings_history WHERE account_id = ?').get(source) as { n: number }).n,
    0
  );
  db.close();
});

test('a security held by both accounts on the same day is summed, not silently dropped', () => {
  const db = migratedTestDb();
  const target = insertAccount(db);
  const source = insertAccount(db);
  const vt = seedSecurity(db, 'sec_vt');
  addHistory(db, target, vt, '2026-07-01', 4, 40000);
  addHistory(db, source, vt, '2026-07-01', 6, 60000);

  mergeAccounts(db, target, source);

  // The composite key is (account_id, security_id, date), so the two rows collide. After a merge
  // they are two parts of one position, and letting one win would lose value.
  const row = db.prepare(
    'SELECT quantity, institution_value FROM holdings_history WHERE account_id = ? AND date = ?'
  ).get(target, '2026-07-01') as { quantity: number; institution_value: number };
  assert.equal(row.quantity, 10);
  assert.equal(row.institution_value, 100000);
  db.close();
});

test('merging folds the source out of every historical breakdown without changing net worth', () => {
  const db = migratedTestDb();
  const target = insertAccount(db);
  const source = insertAccount(db);

  const insert = db.prepare(`
    INSERT INTO net_worth_snapshots
      (id, date, total_assets, total_liabilities, net_worth, breakdown, is_estimated,
       liquid_assets, investment_assets, crypto_assets, created_at)
    VALUES (?, ?, ?, 0, ?, ?, 0, ?, 0, 0, '2026-07-01')
  `);
  insert.run('s1', '2026-06-01', 30000, 30000, JSON.stringify({ [target]: 10000, [source]: 20000 }), 30000);
  insert.run('s2', '2026-07-01', 20000, 20000, JSON.stringify({ [source]: 20000 }), 20000);

  mergeAccounts(db, target, source);

  const rows = db.prepare('SELECT date, breakdown FROM net_worth_snapshots ORDER BY date').all() as Array<{
    date: string;
    breakdown: string;
  }>;
  const first = JSON.parse(rows[0].breakdown) as Record<string, number>;
  const second = JSON.parse(rows[1].breakdown) as Record<string, number>;

  // Summed, so the month's total is unchanged: after a merge these were two parts of one account.
  // That is the property migration 039 was restoring by hand.
  assert.equal(first[target], 30000);
  assert.ok(!(source in first), 'the orphan id must be gone');
  assert.equal(second[target], 20000);
  assert.ok(!(source in second));
  db.close();
});

test('a goal stays attached to the surviving account', () => {
  const db = migratedTestDb();
  const target = insertAccount(db);
  const source = insertAccount(db);
  db.prepare(`
    INSERT INTO goals (id, name, type, target_amount, current_amount, account_id, is_archived, created_at, updated_at)
    VALUES ('g1', 'Emergency', 'savings', 500000, 100000, ?, 0, '2026-07-01', '2026-07-01')
  `).run(source);

  mergeAccounts(db, target, source);

  // ON DELETE SET NULL would silently detach the goal from the money backing it.
  const goal = db.prepare('SELECT account_id FROM goals WHERE id = ?').get('g1') as { account_id: string };
  assert.equal(goal.account_id, target);
  db.close();
});

test('transactions follow the merge', () => {
  const db = migratedTestDb();
  const target = insertAccount(db);
  const source = insertAccount(db);
  insertTransaction(db, { account_id: source, amount: -1234 });

  mergeAccounts(db, target, source);

  const n = db.prepare('SELECT COUNT(*) n FROM transactions WHERE account_id = ?').get(target) as { n: number };
  assert.equal(n.n, 1);
  db.close();
});

test('remapAccountIdInSnapshots leaves unrelated snapshots alone', () => {
  const db = migratedTestDb();
  const a = insertAccount(db);
  const b = insertAccount(db);
  db.prepare(`
    INSERT INTO net_worth_snapshots
      (id, date, total_assets, total_liabilities, net_worth, breakdown, is_estimated,
       liquid_assets, investment_assets, crypto_assets, created_at)
    VALUES ('s1', '2026-07-01', 100, 0, 100, ?, 0, 100, 0, 0, '2026-07-01')
  `).run(JSON.stringify({ [a]: 100 }));

  assert.equal(remapAccountIdInSnapshots(db, b, a), 0);
  db.close();
});

/**
 * A colliding history day merges all four numeric columns, not two.
 *
 * The collision pass summed `quantity` and `institution_value` and left `cost_basis` and
 * `institution_price` alone, so the merged row kept the target's basis beside a doubled value and
 * the position read as having gained everything the source side had cost. The suite could not see
 * it because `addHistory` did not carry a basis and the collision test asserted only two columns.
 */
function historyRow(db: ReturnType<typeof migratedTestDb>, accountId: string, date: string) {
  return db
    .prepare(
      'SELECT quantity, institution_value, cost_basis, institution_price FROM holdings_history WHERE account_id = ? AND date = ?'
    )
    .get(accountId, date) as {
    quantity: number;
    institution_value: number;
    cost_basis: number | null;
    institution_price: number;
  };
}

test('a colliding history day sums the cost basis as well as the value', () => {
  const db = migratedTestDb();
  const target = insertAccount(db, { type: 'brokerage' });
  const source = insertAccount(db, { type: 'brokerage' });
  const vt = seedSecurity(db, 'vt');
  // Two parts of one position on the same day: 4 units worth $200 costing $150, and 6 units worth
  // $300 costing $250.
  addHistory(db, target, vt, '2026-07-01', 4, 20000, 15000);
  addHistory(db, source, vt, '2026-07-01', 6, 30000, 25000);

  mergeAccounts(db, target, source);

  const row = historyRow(db, target, '2026-07-01');
  assert.equal(row.quantity, 10);
  assert.equal(row.institution_value, 50000);
  // It used to keep 15000 here, so the merged position showed a $350 gain on a $100 one.
  assert.equal(row.cost_basis, 40000);
  // A per-unit price does not sum: $500 over 10 units is $50, not $2.
  assert.equal(row.institution_price, 50);
  db.close();
});

test('a basis unknown on either side makes the merged basis unknown, never zero', () => {
  const db = migratedTestDb();
  const target = insertAccount(db, { type: 'brokerage' });
  const source = insertAccount(db, { type: 'brokerage' });
  const vt = seedSecurity(db, 'vt');
  addHistory(db, target, vt, '2026-07-01', 4, 20000, 15000);
  addHistory(db, source, vt, '2026-07-01', 6, 30000, null);

  mergeAccounts(db, target, source);

  const row = historyRow(db, target, '2026-07-01');
  assert.equal(row.institution_value, 50000);
  // Migration 043's doctrine: a part-unknown total is unknown. Summing to 15000 would claim the
  // source side cost nothing, which is the "stored 0 is a provider declining to answer" trap.
  assert.equal(row.cost_basis, null);
  db.close();
});

test('HEALTHY: a non-colliding day keeps its own basis and price untouched', () => {
  const db = migratedTestDb();
  const target = insertAccount(db, { type: 'brokerage' });
  const source = insertAccount(db, { type: 'brokerage' });
  const vt = seedSecurity(db, 'vt');
  addHistory(db, target, vt, '2026-07-01', 4, 20000, 15000);
  // A different date, so nothing collides and nothing may move.
  addHistory(db, source, vt, '2026-07-02', 6, 30000, 25000);

  mergeAccounts(db, target, source);

  assert.deepEqual(historyRow(db, target, '2026-07-01'), {
    quantity: 4, institution_value: 20000, cost_basis: 15000, institution_price: 1.0,
  });
  assert.deepEqual(historyRow(db, target, '2026-07-02'), {
    quantity: 6, institution_value: 30000, cost_basis: 25000, institution_price: 1.0,
  });
  db.close();
});
