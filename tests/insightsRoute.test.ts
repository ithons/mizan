import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import type Database from 'better-sqlite3';
import { format, startOfMonth } from 'date-fns';
import { migratedTestDb, insertAccount, insertTransaction, TEST_NOW } from './helpers/schema';
import { _setDbForTesting } from '../server/src/db/index';
import insightsRouter from '../server/src/routes/insights';
import { getMonthlyBudgetsWithProjection } from '../server/src/services/budgetProjection';
import { LEGACY_TARGETS } from '../client/src/App';
import type { Insight } from '../shared/types';

/**
 * The insights route is the one surface in this app that renders a sentence per condition, and
 * three of its rows stated something the code had not established. Every test here drives the real
 * router over HTTP against a migrated database, because the defects were in the SQL and in the
 * copy, not in a helper either could be lifted into.
 */

const TODAY = new Date();
const MONTH_START = format(startOfMonth(TODAY), 'yyyy-MM-dd');

function dayThisMonth(day: number): string {
  return format(new Date(TODAY.getFullYear(), TODAY.getMonth(), day), 'yyyy-MM-dd');
}

async function insights(db: Database.Database): Promise<Insight[]> {
  _setDbForTesting(db);
  const app = express();
  app.use('/api/insights', insightsRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no server address');
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/insights`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: Insight[] };
    return body.data;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function budget(db: Database.Database, categoryId: string, amountCents: number): void {
  db.prepare(`
    INSERT INTO budgets (id, category_id, amount, period, rollover, rollover_balance, created_at, updated_at)
    VALUES (?, ?, ?, 'monthly', 0, 0, ?, ?)
  `).run(`bud_${categoryId}`, categoryId, amountCents, TEST_NOW, TEST_NOW);
}

// ─── The refunds defect, on the one path Phase 2 did not reach ────────────────
//
// `/plan` sums `-t.amount` over every row; this route summed `ABS(t.amount)` behind `t.amount < 0`,
// so a refund raised the figure it should have lowered. Measured 2026-07-31 against a copy of
// `.mizan/mizan.db` at migration 054: Shopping's July rows come to 102459 cents outflow-only
// against a 50000 cent budget, and this route rendered "Shopping is at 204.9% of its monthly
// budget" for a month whose Shopping credits exceeded its purchases by $1,028.63.

test('HEALTHY: a month whose refunds exceed its purchases raises no budget row', async () => {
  const db = migratedTestDb();
  const account = insertAccount(db, { type: 'checking', current_balance: 500000 });
  budget(db, 'cat_shop', 50_000);

  // The live July shape, to the cent: $1,024.59 of purchases against $2,053.22 of credits.
  insertTransaction(db, { account_id: account, date: dayThisMonth(3), amount: -102_459, category_id: 'cat_shop' });
  insertTransaction(db, { account_id: account, date: dayThisMonth(9), amount: 205_322, category_id: 'cat_shop' });

  const rows = await insights(db);
  assert.deepEqual(
    rows.filter((row) => row.id === 'budget-over' || row.id === 'budget-tight'),
    [],
    'a net-refund month is not an overspend and must say nothing'
  );

  // And the figure this route now reads is the one /plan reads, on the same rows.
  const planned = getMonthlyBudgetsWithProjection(db, TODAY.getFullYear(), TODAY.getMonth() + 1, TODAY);
  assert.equal(planned.find((b) => b.category_id === 'cat_shop')?.spent, -102_863);

  db.close();
});

test('a budget genuinely over plan is still reported, at the signed figure', async () => {
  const db = migratedTestDb();
  const account = insertAccount(db, { type: 'checking', current_balance: 500000 });
  budget(db, 'cat_shop', 50_000);

  insertTransaction(db, { account_id: account, date: dayThisMonth(3), amount: -102_459, category_id: 'cat_shop' });
  insertTransaction(db, { account_id: account, date: dayThisMonth(9), amount: 2_459, category_id: 'cat_shop' });

  const rows = await insights(db);
  const over = rows.find((row) => row.id === 'budget-over');
  assert.ok(over, 'a category $500 over its $500 budget must be reported');
  // 100000 spent of 50000 budgeted: 200.0%, not the 204.9% the outflow-only sum produced.
  assert.match(over.message, /200\.0% of its monthly budget/);
  assert.equal(over.metric, '$1,000 / $500');
  assert.equal(over.action_route, '/plan');

  db.close();
});

test('a refund inside an over-budget month nets the reported figure down', async () => {
  const db = migratedTestDb();
  const account = insertAccount(db, { type: 'checking', current_balance: 500000 });
  budget(db, 'cat_food', 50_000);
  insertTransaction(db, { account_id: account, date: dayThisMonth(2), amount: -80_000, category_id: 'cat_food' });

  const before = (await insights(db)).find((row) => row.id === 'budget-over');
  assert.match(before?.message ?? '', /160\.0%/);

  insertTransaction(db, { account_id: account, date: dayThisMonth(4), amount: 20_000, category_id: 'cat_food' });
  const after = (await insights(db)).find((row) => row.id === 'budget-over');
  assert.match(after?.message ?? '', /120\.0%/, 'a $200 refund must lower the percentage, not raise it');

  db.close();
});

// ─── The connection row states what the classifier decided ────────────────────

function simplefin(db: Database.Database, status: string): void {
  db.prepare(`
    INSERT INTO simplefin_connections (id, last_synced_at, status, created_at)
    VALUES ('sf_1', ?, ?, ?)
  `).run(`${MONTH_START}T00:00:00.000Z`, status, TEST_NOW);
}

test('a failed sync is reported as a retry, not as an expired login', async () => {
  const db = migratedTestDb();
  simplefin(db, 'sync_error');

  const rows = await insights(db);
  const row = rows.find((r) => r.id === 'sync-attention');
  assert.ok(row, 'a sync_error connection needs a row');
  // classifyStatus decided "retry, and reconnect only if it fails again". The old copy said the
  // connection "cannot sync until reconnected" for every non-active status, which is a cause
  // nothing here established.
  assert.equal(row.message, 'SimpleFIN: Retry this sync. If it fails again, reconnect the institution.');
  assert.doesNotMatch(row.message, /until reconnected/);

  db.close();
});

test('an expired login is reported as one, and the two states read differently', async () => {
  const db = migratedTestDb();
  simplefin(db, 'reauth_required');

  const row = (await insights(db)).find((r) => r.id === 'sync-attention');
  assert.match(row?.message ?? '', /needs a fresh login/);

  db.close();
});

test('a disconnected Coinbase connection is not counted as blocked', async () => {
  const db = migratedTestDb();
  // getSyncHealth drops these rows entirely; this route read coinbase_connections unfiltered and
  // counted one as a connection that "cannot sync", so the two surfaces disagreed about the row.
  db.prepare(`
    INSERT INTO coinbase_connections (id, coinbase_user_id, display_name, last_synced_at, status, created_at)
    VALUES ('cb_1', 'u1', 'Coinbase', ?, 'disconnected', ?)
  `).run(`${MONTH_START}T00:00:00.000Z`, TEST_NOW);

  const rows = await insights(db);
  assert.deepEqual(rows.filter((row) => row.id === 'sync-attention'), []);

  db.close();
});

test('HEALTHY: an active, freshly synced connection raises nothing about sync', async () => {
  const db = migratedTestDb();
  db.prepare(`
    INSERT INTO simplefin_connections (id, last_synced_at, status, created_at)
    VALUES ('sf_1', ?, 'active', ?)
  `).run(new Date().toISOString(), TEST_NOW);

  const rows = await insights(db);
  assert.deepEqual(rows.filter((row) => row.id.startsWith('sync-')), []);

  db.close();
});

// ─── A retired rule is not a live one ─────────────────────────────────────────

test('"Categorization is clean" counts only rules that still run', async () => {
  const db = migratedTestDb();
  const account = insertAccount(db, { type: 'checking', current_balance: 100000 });
  insertTransaction(db, { account_id: account, date: dayThisMonth(2), amount: -1000, category_id: 'cat_food' });

  const rule = db.prepare(`
    INSERT INTO merchant_rules (id, pattern, category_id, created_at, source, retired_at)
    VALUES (?, ?, 'cat_food', ?, 'human', ?)
  `);
  rule.run('r_live_1', 'Alpha', TEST_NOW, null);
  rule.run('r_live_2', 'Beta', TEST_NOW, null);
  rule.run('r_retired', 'Gamma', TEST_NOW, TEST_NOW);

  const row = (await insights(db)).find((r) => r.id === 'rules-working');
  assert.ok(row);
  assert.equal(row.message, 'All posted transactions are categorized and 2 merchant rules are live.');

  db.close();
});

test('one live rule reads with a singular verb', async () => {
  const db = migratedTestDb();
  const account = insertAccount(db, { type: 'checking', current_balance: 100000 });
  insertTransaction(db, { account_id: account, date: dayThisMonth(2), amount: -1000, category_id: 'cat_food' });
  db.prepare(`
    INSERT INTO merchant_rules (id, pattern, category_id, created_at, source, retired_at)
    VALUES ('r_only', 'Alpha', 'cat_food', ?, 'human', NULL)
  `).run(TEST_NOW);

  const row = (await insights(db)).find((r) => r.id === 'rules-working');
  assert.match(row?.message ?? '', /1 merchant rule is live\.$/);

  db.close();
});

// ─── Every action lands on a screen that exists ───────────────────────────────
//
// The nav holds at six routes and `LEGACY_TARGETS` in client/src/App.tsx keeps an old bookmark
// working. This route was emitting a mix: `/plan` on two budget rows beside `/transactions`,
// `/bills` and `/goals` on six others, and `anomalyInsights.ts` emitting `/reports`. The redirect
// meant nothing was broken, which is exactly why it could sit half converted. Both checks below
// are here because the served payload alone can only cover the rows a fixture happens to fire.

test('no served insight points at a route that only exists as a redirect', async () => {
  const db = migratedTestDb();
  const account = insertAccount(db, { type: 'checking', current_balance: 100000 });
  // Uncategorized rows, an over-plan budget and a live rule between them fire several row types.
  insertTransaction(db, { account_id: account, date: dayThisMonth(2), amount: -1000, category_id: null });
  insertTransaction(db, { account_id: account, date: dayThisMonth(3), amount: -60000, category_id: 'cat_shop' });
  budget(db, 'cat_shop', 10000);

  const rows = await insights(db);
  assert.ok(rows.length > 0, 'a fixture that fires nothing proves nothing');
  for (const row of rows) {
    if (!row.action_route) continue;
    assert.ok(
      !LEGACY_TARGETS.some((legacy) => legacy.from === row.action_route),
      `insight ${row.id} points at ${row.action_route}, which exists only as a redirect`
    );
  }

  db.close();
});

test('no insight source file writes a retired route into an action_route', () => {
  // The served payload can only cover the rows one fixture fires. These two files are where every
  // insight is authored, so reading the literals is the check that covers the rows it does not.
  const sources = [
    'server/src/routes/insights.ts',
    'server/src/services/anomalyInsights.ts',
  ];
  let found = 0;
  for (const relative of sources) {
    const text = readFileSync(join(process.cwd(), relative), 'utf8');
    for (const match of text.matchAll(/action_route: '([^']+)'/g)) {
      found++;
      assert.ok(
        !LEGACY_TARGETS.some((legacy) => legacy.from === match[1]),
        `${relative} writes action_route '${match[1]}', which exists only as a redirect`
      );
    }
  }
  assert.ok(found >= 10, `expected the insight routes to be read, found ${found}`);
});
