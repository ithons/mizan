import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { migratedTestDb } from './helpers/schema';

// /api/ai/providers and the provider-key PUT/DELETE responses are typed on the client as
// `AdvisorProviderStatus[]`, which carries `credential_source`. The server used to build its
// own inline shape with `source` instead, so the first screen rendering from those responses
// would have read every provider as "no credential found". This drives the real router and
// asserts the wire shape is the shared one, and the same one /api/ai/settings already sends.

// A scratch MIZAN_DIR, set before credentials.ts loads, so the DELETE below cannot reach the
// owner's credential store. Env keys beat the store in `resolveCredential`, which makes the
// statuses hermetic on any machine.
const MIZAN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mizan-provider-status-'));
process.env.MIZAN_DIR_OVERRIDE = MIZAN_DIR;
const ENV_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY'] as const;

async function withEnvKeys(fn: () => Promise<void>): Promise<void> {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) process.env[k] = 'test-key-never-used';
  try {
    await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function withServer(fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const { _setDbForTesting } = await import('../server/src/db/index');
  const { default: aiRouter } = await import('../server/src/routes/ai');
  const db = migratedTestDb();
  _setDbForTesting(db);
  const app = express();
  app.use(express.json());
  app.use('/api/ai', aiRouter);
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

test.after(() => fs.rmSync(MIZAN_DIR, { recursive: true, force: true }));

test('GET /api/ai/providers sends the shared AdvisorProviderStatus shape', async () => {
  await withEnvKeys(() =>
    withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/ai/providers`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { data: { providers: Array<Record<string, unknown>> } };
      assert.equal(body.data.providers.length, 3);
      for (const p of body.data.providers) {
        assert.deepEqual(Object.keys(p).sort(), ['configured', 'credential_source', 'id']);
        assert.equal(p.credential_source, 'env', `${String(p.id)} misreports an env key`);
        assert.equal(p.configured, true);
      }

      const settings = (await (await fetch(`${baseUrl}/api/ai/settings`)).json()) as {
        data: { available: { providers: unknown[] } };
      };
      assert.deepEqual(body.data.providers, settings.data.available.providers);
    })
  );
});

test('DELETE of a key the environment still supplies says so instead of reporting success', async () => {
  await withEnvKeys(() =>
    withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/ai/providers/openai/key`, { method: 'DELETE' });
      assert.equal(res.status, 409);
      const body = (await res.json()) as { error: string };
      assert.match(body.error, /still configured from the environment/);
    })
  );
});
