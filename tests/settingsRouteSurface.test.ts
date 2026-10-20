/**
 * Routes under /api/settings that wrote state without the checks their real homes apply.
 * Each preference has its own validated path, so a generic writer could only reinsert a key
 * migration 054 retired or overwrite one the server owns.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import type Database from 'better-sqlite3';
import { _setDbForTesting } from '../server/src/db/index';
import settingsRouter from '../server/src/routes/settings';
import { RETIRED_PREFERENCE_KEYS } from '../server/src/services/preferences';
import { migratedTestDb } from './helpers/schema';

async function withRouter<T>(
  db: Database.Database,
  run: (call: (path: string, init?: RequestInit) => Promise<number>) => Promise<T>
): Promise<T> {
  _setDbForTesting(db);
  const app = express();
  app.use(express.json());
  app.use('/api/settings', settingsRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no server address');
    const call = async (path: string, init?: RequestInit): Promise<number> => {
      const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
        ...init,
        headers: { 'Content-Type': 'application/json', ...init?.headers },
      });
      await res.arrayBuffer();
      return res.status;
    };
    return await run(call);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function preferenceKeys(db: Database.Database): string[] {
  return (db.prepare('SELECT key FROM app_preferences ORDER BY key').all() as Array<{ key: string }>).map((r) => r.key);
}

test('no generic preference writer: a retired key cannot be put back through /api/settings', async () => {
  const db = migratedTestDb();
  const before = preferenceKeys(db);
  await withRouter(db, async (call) => {
    for (const key of RETIRED_PREFERENCE_KEYS) {
      const status = await call(`/api/settings/preferences/${key}`, {
        method: 'PUT',
        body: JSON.stringify({ value: true }),
      });
      assert.equal(status, 404);
    }
    assert.equal(await call('/api/settings/preferences/net_worth_reconstruction_mark'), 404);
  });
  assert.deepEqual(preferenceKeys(db), before);
  db.close();
});

test('HEALTHY: the settings routes that have callers still answer', async () => {
  const db = migratedTestDb();
  await withRouter(db, async (call) => {
    assert.equal(await call('/api/settings/import-runs'), 200);
  });
  db.close();
});
