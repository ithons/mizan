/**
 * syncSimplefin asks a second time when an account comes back from a long absence, and only then.
 *
 * The decision is unit-tested in simplefinReappearance.test.ts; this drives the real function with
 * the HTTP client stubbed, to pin the wiring: the window the first request asks for is the one
 * reappearance is judged against, the second request reaches back far enough, and the counts of
 * both passes are reported together.
 *
 * MIZAN_DIR_OVERRIDE is set before anything loads db/index.ts, because syncSimplefin reads the
 * credential store and this file writes one.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'mizan-sfrefetch-'));
process.env.MIZAN_DIR_OVERRIDE = SCRATCH;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const axios = (require('axios') as typeof import('axios')).default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { migratedTestDb, insertAccount } = require('./helpers/schema') as typeof import('./helpers/schema');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { _setDbForTesting } = require('../server/src/db/index') as typeof import('../server/src/db/index');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { saveCredentials } = require('../server/src/services/credentials') as typeof import('../server/src/services/credentials');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { syncSimplefin } = require('../server/src/services/simplefin') as typeof import('../server/src/services/simplefin');

const DAY = 86_400_000;
const daysAgo = (n: number): string => new Date(Date.now() - n * DAY).toISOString();

function response(): unknown {
  return {
    accounts: ['checking', 'card'].map((id) => ({
      id, name: id, currency: 'USD', balance: '100.00', org: { name: 'Bank' }, transactions: [],
    })),
  };
}

/** Records every start-date requested and answers each with the same two accounts. */
function stubClient(t: import('node:test').TestContext): number[] {
  const asked: number[] = [];
  t.mock.method(axios, 'create', () => ({
    get: async (url: string) => {
      const m = url.match(/start-date=(\d+)/);
      if (!m) throw new Error(`unexpected request ${url}`);
      asked.push(Number(m[1]));
      return { data: response() };
    },
  }));
  return asked;
}

function ledger(cardSeen: string) {
  const db = migratedTestDb();
  _setDbForTesting(db);
  saveCredentials({ simplefin: { accessUrl: 'https://user:pw@bridge.example.invalid/simplefin' } });
  db.prepare("INSERT INTO simplefin_connections (id, status, last_synced_at, created_at) VALUES ('simplefin_primary', 'active', ?, ?)")
    .run(daysAgo(1 / 24), daysAgo(400));
  for (const [providerId, seen] of [['checking', daysAgo(1 / 24)], ['card', cardSeen]]) {
    const id = insertAccount(db, { account_name: providerId, connection_type: 'simplefin', is_manual: 0 });
    db.prepare('UPDATE accounts SET simplefin_account_id = ?, provider_seen_at = ? WHERE id = ?').run(providerId, seen, id);
  }
  return db;
}

const daysBack = (startDateSeconds: number): number => Math.round((Date.now() - startDateSeconds * 1000) / DAY);

test('HEALTHY: an hourly sync makes exactly one request, over the ordinary window', async (t) => {
  ledger(daysAgo(1 / 24));
  const asked = stubClient(t);
  const result = await syncSimplefin();
  assert.deepEqual(asked.map(daysBack), [30]);
  assert.deepEqual(result.reappeared, []);
});

test('a card back from a 45-day absence gets one more request reaching past it', async (t) => {
  ledger(daysAgo(45));
  const asked = stubClient(t);
  const result = await syncSimplefin();
  const [first, second] = asked.map(daysBack);
  assert.equal(asked.length, 2);
  assert.equal(first, 30);
  // The absence plus the two-day margin; 48 when the 45 days have ticked past a whole day by now.
  assert.ok(second >= 47 && second <= 48, `the second request reached back ${second} days`);
  assert.deepEqual(result.reappeared.map((r) => r.accountName), ['card']);
  assert.equal(result.errors.filter((e) => /were not fetched/.test(e)).length, 0, 'the whole absence was within reach');
});

test('a card back from 120 days asks as far as SimpleFIN serves and names the rest, once', async (t) => {
  ledger(daysAgo(120));
  const asked = stubClient(t);
  const result = await syncSimplefin();
  assert.deepEqual(asked.map(daysBack), [30, 90]);
  assert.equal(result.errors.filter((e) => /^card was last returned by SimpleFIN/.test(e)).length, 1);

  // The pass stamped it, so the next hourly sync is ordinary again: no standing notice.
  const asked2 = stubClient(t);
  const next = await syncSimplefin();
  assert.deepEqual(asked2.map(daysBack), [30]);
  assert.equal(next.errors.filter((e) => /were not fetched/.test(e)).length, 0);
});

test('a follow-up that fails is given up once: the range is named, and the next sync is ordinary', async (t) => {
  const db = ledger(daysAgo(45));
  let calls = 0;
  t.mock.method(axios, 'create', () => ({
    get: async () => {
      calls++;
      if (calls === 2) throw new Error('socket hang up');
      return { data: response() };
    },
  }));
  const result = await syncSimplefin();
  assert.equal(calls, 2, 'a non-transient failure is not retried in place');
  const named = result.errors.filter((e) => /^card was absent from SimpleFIN from .* failed \(socket hang up\), so that range may be missing/.test(e));
  assert.equal(named.length, 1);
  const card = db.prepare("SELECT provider_seen_at AS s FROM accounts WHERE simplefin_account_id = 'card'").get() as { s: string };
  assert.ok(Date.now() - Date.parse(card.s) < DAY, 'the account was left open, so every hour would repeat the request');

  // No standing finding: the next pass makes one ordinary request and says nothing.
  const asked = stubClient(t);
  const next = await syncSimplefin();
  assert.deepEqual(asked.map(daysBack), [30]);
  assert.equal(next.errors.filter((e) => /absent from SimpleFIN|were not fetched/.test(e)).length, 0);
});

test('an account the wider response does not contain stays open, so its absence is asked for again', async (t) => {
  const db = ledger(daysAgo(45));
  let calls = 0;
  t.mock.method(axios, 'create', () => ({
    get: async () => {
      calls++;
      const ids = calls === 2 ? ['checking'] : ['checking', 'card'];
      return { data: { accounts: ids.map((id) => ({ id, name: id, currency: 'USD', balance: '100.00', org: { name: 'Bank' }, transactions: [] })) } };
    },
  }));
  await syncSimplefin();
  const card = db.prepare("SELECT provider_seen_at AS s FROM accounts WHERE simplefin_account_id = 'card'").get() as { s: string };
  assert.ok(Date.now() - Date.parse(card.s) > 44 * DAY, 'stamped although its absence was never taken');
});

test.after(() => {
  mock.restoreAll();
  fs.rmSync(SCRATCH, { recursive: true, force: true });
});
