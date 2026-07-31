import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import Database from 'better-sqlite3';
import { migratedTestDb } from './helpers/schema';
import { _setDbForTesting } from '../server/src/db/index';
import accountsRouter from '../server/src/routes/accounts';

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
