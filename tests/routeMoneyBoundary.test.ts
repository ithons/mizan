import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import Database from 'better-sqlite3';
import { localDaysFromToday, migratedTestDb } from './helpers/schema';
import { _setDbForTesting } from '../server/src/db/index';
import accountsRouter from '../server/src/routes/accounts';
import networthRouter from '../server/src/routes/networth';
import budgetsRouter from '../server/src/routes/budgets';

// The rest of the suite calls services directly and asserts in the cents domain, so the
// cents<->dollars conversion that actually happens at the ROUTE boundary (migrations 018/022
// are exactly about this) is never exercised end-to-end. This drives the real accounts
// router over HTTP against an in-memory DB and asserts a cents-stored balance comes back
// as dollars. A scaling regression in accountToDollars/dollarizeFields would fail here.

function setupDb(): Database.Database {
  const db = migratedTestDb();
  // Balances stored as integer cents (the DB contract).
  const insert = db.prepare(`INSERT INTO accounts
    (id, connection_type, account_name, type, current_balance, available_balance, credit_limit, is_liability, sort_order, created_at, updated_at)
    VALUES (?,'manual',?,?,?,?,?,?,?,?,?)`);
  insert.run('acc_check', 'Checking', 'checking', 430719, 430719, null, 0, 0, '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z');
  insert.run('acc_card', 'Sapphire', 'credit', 352919, null, 1000000, 1, 1, '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z');
  return db;
}

async function withServer(db: Database.Database, fn: (baseUrl: string) => Promise<void>): Promise<void> {
  _setDbForTesting(db);
  const app = express();
  app.use('/api/accounts', accountsRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no server address');
    await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
}

test('GET /api/accounts returns balances in dollars, not the stored cents', async () => {
  await withServer(setupDb(), async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/accounts`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };
    const byId = Object.fromEntries(body.data.map((a) => [a.id, a]));

    // 430719 cents -> 4307.19 dollars (not 430719, not 43071900)
    assert.equal(byId.acc_check.current_balance, 4307.19);
    assert.equal(byId.acc_check.available_balance, 4307.19);

    // 352919 cents -> 3529.19; credit_limit 1000000 cents -> 10000
    assert.equal(byId.acc_card.current_balance, 3529.19);
    assert.equal(byId.acc_card.credit_limit, 10000);

    // null money field survives the boundary as null, not 0 or NaN
    assert.equal(byId.acc_card.available_balance, null);

    // non-money fields untouched; booleans mapped
    assert.equal(byId.acc_card.is_liability, true);
    assert.equal(byId.acc_check.currency, 'USD');
  });
});

test('GET /api/networth/timeline returns totals and per-account values in dollars, and refuses a bad step', async () => {
  const db = setupDb();
  db.prepare(`INSERT INTO transactions (id, account_id, date, amount, merchant_name, original_name, pending, is_manual, source_type, created_at, updated_at)
    VALUES ('t1', 'acc_check', ?, 430719, 'Deposit', 'Deposit', 0, 1, 'manual', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z')`).run(localDaysFromToday(-3));
  _setDbForTesting(db);
  const app = express();
  app.use('/api/networth', networthRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no server address');
    const base = `http://127.0.0.1:${addr.port}/api/networth/timeline`;
    const body = (await (await fetch(`${base}?accounts=acc_check`)).json()) as { data: { points: Array<{ net_worth: number; by_account: Record<string, number> }> } };
    const last = body.data.points.at(-1)!;
    assert.equal(last.net_worth, 4307.19);
    assert.equal(last.by_account.acc_check, 4307.19);
    assert.equal((await fetch(`${base}?step=hour`)).status, 400);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
});

test('GET /api/budgets/month returns each budget ceiling in dollars', async () => {
  const db = setupDb();
  db.prepare(`INSERT INTO budgets (id, category_id, amount, period, rollover, rollover_balance, created_at, updated_at)
    VALUES ('bud_food', 'cat_food', 50000, 'monthly', 0, 0, '2026-01-01T12:00:00Z', '2026-01-01T12:00:00Z')`).run();
  _setDbForTesting(db);
  const app = express();
  app.use('/api/budgets', budgetsRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no server address');
    const body = (await (await fetch(`http://127.0.0.1:${addr.port}/api/budgets/month/2026/7`)).json()) as { data: Array<{ amount: number; available_amount: number }> };
    assert.deepEqual(body.data.map((b) => [b.amount, b.available_amount]), [[500, 500]]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
});

test('GET /api/accounts/card-review returns redeemed, fees and net in dollars', async () => {
  const db = setupDb();
  const tx = db.prepare(`INSERT INTO transactions (id, account_id, date, amount, original_name, category_id, created_at, updated_at)
    VALUES (?, 'acc_card', ?, ?, ?, ?, '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z')`);
  tx.run('t_fee', localDaysFromToday(-30), -9500, 'ANNUAL MEMBERSHIP FEE', 'cat_fees');
  tx.run('t_credit', localDaysFromToday(-10), 28381, 'STATEMENT CREDIT', 'cat_income_other');
  await withServer(db, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/accounts/card-review`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: { cards: Array<{ account_id: string; life: Record<string, number>; fees: Array<{ amount: number }> }> } };
    const card = body.data.cards.find((c) => c.account_id === 'acc_card');
    assert.ok(card);
    assert.deepEqual(card.life, { redeemed: 283.81, fees: 95, net: 188.81, spend: 0 });
    assert.equal(card.fees[0].amount, -95);
  });
});
