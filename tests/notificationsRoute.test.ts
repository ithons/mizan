import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import type Database from 'better-sqlite3';
import { migratedTestDb, insertAccount, insertTransaction, localToday } from './helpers/schema';
import { _setDbForTesting } from '../server/src/db/index';
import notificationsRouter from '../server/src/routes/notifications';

async function withServer(db: Database.Database, fn: (base: string) => Promise<void>): Promise<void> {
  _setDbForTesting(db);
  const app = express();
  app.use(express.json());
  app.use('/api/notifications', notificationsRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no server address');
    await fn(`http://127.0.0.1:${addr.port}/api/notifications`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
}

const json = (body: unknown, method = 'POST') => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

function count(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM notifications').get() as { n: number }).n;
}

test('rule money crosses the route in dollars and is stored in cents', async () => {
  const db = migratedTestDb();
  db.prepare('DELETE FROM notification_rules').run();
  await withServer(db, async (base) => {
    const created = await fetch(`${base}/rules`, json({ kind: 'large_transaction', params: { min_amount: 500, account_id: null, lookback_days: 7 } }));
    assert.equal(created.status, 201);
    const rule = (await created.json() as { data: { id: string; params: { min_amount: number } } }).data;
    assert.equal(rule.params.min_amount, 500);
    const stored = db.prepare('SELECT params FROM notification_rules WHERE id = ?').get(rule.id) as { params: string };
    assert.equal(JSON.parse(stored.params).min_amount, 50000);

    const patched = await fetch(`${base}/rules/${rule.id}`, json({ params: { min_amount: 12.34, account_id: null, lookback_days: 3 } }, 'PATCH'));
    assert.equal((await patched.json() as { data: { params: { min_amount: number } } }).data.params.min_amount, 12.34);
    const restored = db.prepare('SELECT params FROM notification_rules WHERE id = ?').get(rule.id) as { params: string };
    assert.equal(JSON.parse(restored.params).min_amount, 1234);

    const listed = await fetch(`${base}/rules`);
    assert.equal((await listed.json() as { data: Array<{ params: { min_amount: number } }> }).data[0].params.min_amount, 12.34);
  });
});

test('notification payload money is dollars over the API, and GET never writes', async () => {
  const db = migratedTestDb();
  db.prepare('DELETE FROM notification_rules').run();
  const account = insertAccount(db);
  insertTransaction(db, { account_id: account, amount: -60075, date: localToday(), merchant_name: 'Apple' });
  await withServer(db, async (base) => {
    await fetch(`${base}/rules`, json({ kind: 'large_transaction', params: { min_amount: 500, account_id: null, lookback_days: 7 } }));
    await fetch(base);
    await fetch(`${base}/unread-count`);
    await fetch(`${base}/rules`);
    assert.equal(count(db), 0);

    const evaluated = await fetch(`${base}/evaluate`, { method: 'POST' });
    const summary = (await evaluated.json() as { data: { created: Array<{ payload: { amount: number } }> } }).data;
    assert.equal(summary.created[0].payload.amount, 600.75);

    const list = (await (await fetch(base)).json() as { data: Array<{ id: string; payload: { amount: number }; title: string }> }).data;
    assert.equal(list[0].payload.amount, 600.75);
    assert.match(list[0].title, /\$600\.75/);
    assert.equal(((await (await fetch(`${base}/unread-count`)).json()) as { data: { count: number } }).data.count, 1);

    const read = await fetch(`${base}/read`, json({ ids: 'all' }));
    assert.equal((await read.json() as { data: { marked: number } }).data.marked, 1);
    assert.equal((await fetch(`${base}/${list[0].id}/dismiss`, { method: 'POST' })).status, 200);
    assert.equal((await fetch(`${base}/${list[0].id}/dismiss`, { method: 'POST' })).status, 404);
  });
});

test('bad rule input is a 400, an unknown rule a 404', async () => {
  const db = migratedTestDb();
  await withServer(db, async (base) => {
    assert.equal((await fetch(`${base}/rules`, json({ kind: 'nope', params: {} }))).status, 400);
    assert.equal((await fetch(`${base}/rules`, json({ kind: 'bill_due', params: { days_ahead: -1 } }))).status, 400);
    assert.equal((await fetch(`${base}/rules/missing`, json({ enabled: false }, 'PATCH'))).status, 404);
    assert.equal((await fetch(`${base}/rules/missing`, { method: 'DELETE' })).status, 404);
    const toggled = await fetch(`${base}/rules/nrule_bill_due_3`, json({ enabled: false }, 'PATCH'));
    assert.equal((await toggled.json() as { data: { enabled: boolean } }).data.enabled, false);
  });
});
