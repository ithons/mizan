/**
 * Linking and unlinking SimpleFIN over an unreadable credentials store.
 *
 * WHAT THIS FILE IS GUARDING. On 2026-10-01, after a move to a new laptop, the keychain key that
 * decrypts `credentials.json` did not travel. "Remove connection" answered 200, hid all nine SimpleFIN
 * accounts and removed nothing, because the unreadable store had no `simplefin` entry to delete. The
 * next setup claimed the one-time token from SimpleFIN, was then refused the save, and discarded the
 * access URL; every retry with that token got SimpleFIN's bare 403.
 *
 * Isolated with MIZAN_DIR_OVERRIDE before any import, as in `credentialsUnreadable.test.ts`, because
 * CREDENTIALS_PATH is fixed at module load and these tests write a deliberately undecryptable file.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'mizan-sfsetup-'));
process.env.MIZAN_DIR_OVERRIDE = SCRATCH;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const express = require('express') as typeof import('express');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const axios = (require('axios') as typeof import('axios')).default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { migratedTestDb, insertAccount } = require('./helpers/schema') as typeof import('./helpers/schema');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { _setDbForTesting } = require('../server/src/db/index') as typeof import('../server/src/db/index');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { errorHandler } = require('../server/src/middleware/errorHandler') as typeof import('../server/src/middleware/errorHandler');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const simplefinRouter = (require('../server/src/routes/simplefin') as typeof import('../server/src/routes/simplefin')).default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { isSyncActive } = require('../server/src/services/syncManager') as typeof import('../server/src/services/syncManager');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const creds = require('../server/src/services/credentials') as typeof import('../server/src/services/credentials');

const CREDS = path.join(SCRATCH, 'credentials.json');
const SETUP_TOKEN = Buffer.from('https://bridge.example.invalid/claim/abc').toString('base64');
// Port 1 refuses at once, so the post-setup sync the route fires fails fast instead of reaching out.
const ACCESS_URL = 'http://user:pw@127.0.0.1:1/simplefin';

function writeUndecryptable(): void {
  fs.writeFileSync(
    CREDS,
    JSON.stringify({ iv: '00'.repeat(12), authTag: '11'.repeat(16), ciphertext: '2222' }),
    { mode: 0o600 }
  );
  creds._resetCredentialsCacheForTesting();
}

function clearFile(): void {
  if (fs.existsSync(CREDS)) fs.unlinkSync(CREDS);
  creds._resetCredentialsCacheForTesting();
}

interface Reply {
  status: number;
  body: { data?: unknown; error?: string };
}

async function call(method: string, route: string, body?: unknown): Promise<Reply> {
  const app = express();
  app.use(express.json());
  app.use('/api/simplefin', simplefinRouter);
  app.use(errorHandler);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no server address');
    const res = await fetch(`http://127.0.0.1:${addr.port}${route}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Reply['body'] };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function syncSettled(): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (isSyncActive()) {
    if (Date.now() > deadline) throw new Error('post-setup sync never settled');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function hiddenSimplefinCount(db: ReturnType<typeof migratedTestDb>): number {
  return (db.prepare(
    "SELECT COUNT(*) AS n FROM accounts WHERE connection_type = 'simplefin' AND is_hidden = 1"
  ).get() as { n: number }).n;
}

test('HEALTHY: a fresh install claims the token once and stores the access URL', async (t) => {
  clearFile();
  const db = migratedTestDb();
  _setDbForTesting(db);
  const post = t.mock.method(axios, 'post', async () => ({ data: ACCESS_URL }));

  const reply = await call('POST', '/api/simplefin/setup', { setupToken: SETUP_TOKEN });
  await syncSettled();

  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.equal(post.mock.callCount(), 1);
  assert.equal(creds.loadCredentials().simplefin?.accessUrl, ACCESS_URL);
});

test('setup over an unreadable store refuses before spending the token', async (t) => {
  writeUndecryptable();
  const before = fs.readFileSync(CREDS, 'utf8');
  _setDbForTesting(migratedTestDb());
  const post = t.mock.method(axios, 'post', async () => ({ data: ACCESS_URL }));

  const reply = await call('POST', '/api/simplefin/setup', { setupToken: SETUP_TOKEN });

  assert.equal(post.mock.callCount(), 0, 'the one-time token was claimed and then thrown away');
  assert.notEqual(reply.status, 200);
  assert.match(reply.body.error ?? '', /could not be decrypted/);
  assert.equal(fs.readFileSync(CREDS, 'utf8'), before);
});

test('an already-claimed token says so instead of a bare 403', async (t) => {
  clearFile();
  _setDbForTesting(migratedTestDb());
  t.mock.method(axios, 'post', async () => {
    throw new axios.AxiosError('Request failed with status code 403', 'ERR_BAD_REQUEST', undefined, undefined, {
      status: 403, statusText: 'Forbidden', headers: {}, config: { headers: new axios.AxiosHeaders() }, data: 'Forbidden',
    });
  });

  const reply = await call('POST', '/api/simplefin/setup', { setupToken: SETUP_TOKEN });

  assert.equal(reply.status, 403);
  assert.match(reply.body.error ?? '', /already been claimed/);
});

test('HEALTHY: removing a readable connection clears the URL and hides its accounts', async () => {
  clearFile();
  creds.saveCredentials({ simplefin: { accessUrl: ACCESS_URL } });
  const db = migratedTestDb();
  _setDbForTesting(db);
  insertAccount(db, { id: 'a1', connection_type: 'simplefin' });

  const reply = await call('DELETE', '/api/simplefin/connection');

  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.equal(creds.loadCredentials().simplefin?.accessUrl, undefined);
  assert.equal(hiddenSimplefinCount(db), 1);
});

test('removing over an unreadable store refuses and hides nothing', async () => {
  writeUndecryptable();
  const db = migratedTestDb();
  _setDbForTesting(db);
  insertAccount(db, { id: 'a1', connection_type: 'simplefin' });

  const reply = await call('DELETE', '/api/simplefin/connection');

  assert.notEqual(reply.status, 200, 'reported a removal that removed nothing');
  assert.equal(hiddenSimplefinCount(db), 0);
});

test.after(() => {
  mock.restoreAll();
  fs.rmSync(SCRATCH, { recursive: true, force: true });
});
