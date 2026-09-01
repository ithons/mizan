import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import net from 'node:net';
import os from 'node:os';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { listenOnHost } from '../server/src/listen';

const ROOT = join(__dirname, '..');

/** First non-internal IPv4 address, or null on a machine with no network. */
function lanAddress(): string | null {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return null;
}

function connect(host: string, port: number, timeoutMs = 2000): Promise<'open' | 'refused'> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (r: 'open' | 'refused') => {
      socket.destroy();
      resolve(r);
    };
    socket.setTimeout(timeoutMs, () => done('refused'));
    socket.on('connect', () => done('open'));
    socket.on('error', () => done('refused'));
  });
}

async function listening(host: string): Promise<{ server: ReturnType<typeof listenOnHost>; port: number }> {
  const app = express();
  app.get('/probe', (_q, r) => r.json({ ok: true }));
  const server = await new Promise<ReturnType<typeof listenOnHost>>((resolve) => {
    const s = listenOnHost(app, 0, host, () => resolve(s));
  });
  return { server, port: (server.address() as AddressInfo).port };
}

test('SECURITY: the socket binds to the host it is given, and nothing else can reach it', async () => {
  const { server, port } = await listening('127.0.0.1');
  try {
    const addr = server.address() as AddressInfo;
    // The regression itself. `ViteExpress.listen` took no host, so this read '::' under both
    // documented commands and the ledger answered on every interface.
    assert.equal(addr.address, '127.0.0.1', `bound to ${addr.address}, not loopback`);

    assert.equal(await connect('127.0.0.1', port), 'open', 'the owner cannot reach their own app');

    const lan = lanAddress();
    if (lan) {
      assert.equal(
        await connect(lan, port),
        'refused',
        `reachable at ${lan}:${port}. A peer on this network can read and write the ledger, ` +
          'because localGuard is a browser-only defence and a forged Host header satisfies it.'
      );
    } else {
      // Stated rather than skipped silently: on a machine with no network this half proves nothing.
      console.log('[loopbackBind] no non-internal IPv4 interface; the LAN half of this test did not run');
    }
  } finally {
    server.close();
  }
});

test('SECURITY: a host other than loopback is honoured too, so the parameter is real', async () => {
  const { server } = await listening('0.0.0.0');
  try {
    // Proves the assertion above is about the argument and not about a hardcoded default.
    assert.equal((server.address() as AddressInfo).address, '0.0.0.0');
  } finally {
    server.close();
  }
});

/**
 * Comments in this repo quote the APIs they are warning about, and `index.ts` explains the defect
 * this file pins by naming `ViteExpress.listen`. Strip comments so the ban is on the call and not
 * on the sentence describing why the call is banned.
 */
function codeWithoutComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

test('SECURITY: nothing calls the host-less ViteExpress.listen', () => {
  const src = codeWithoutComments(readFileSync(join(ROOT, 'server/src/index.ts'), 'utf8'));
  // `ViteExpress.listen(app, port, cb)` has no host parameter and cannot be given one
  // (dist/main.d.ts). Using it at all reintroduces the bind on every interface, so the ban is on
  // the call, not on the resulting address, which no unit test can observe from inside.
  assert.ok(
    !/ViteExpress\s*\.\s*listen\s*\(/.test(src),
    'server/src/index.ts calls ViteExpress.listen, which binds every interface. Use ' +
      'listenOnHost(...) and attach Vite with ViteExpress.bind(app, server, cb).'
  );
  assert.match(src, /listenOnHost\s*\(/, 'index.ts no longer binds through listenOnHost');
});

test('SECURITY: the beyond-loopback warning is not gated on production mode', () => {
  const src = codeWithoutComments(readFileSync(join(ROOT, 'server/src/index.ts'), 'utf8'));
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  // The premise, asserted rather than assumed. When this warning was first ungated, NEITHER script
  // set NODE_ENV, so `IS_PROD` was dead and the line could not print at all. `npm start` sets it
  // now, but `npm run dev` deliberately does not, and dev is where this app actually runs. So the
  // warning must stay ungated for a different reason than the one it started with, and a reader
  // who changes `dev` should find that out here.
  assert.doesNotMatch(
    pkg.scripts.dev,
    /NODE_ENV=production/,
    'npm run dev now runs in production mode; revisit why IS_PROD gating was removed here'
  );
  assert.ok(
    !/if\s*\(\s*IS_PROD\s*&&\s*!HOST_IS_LOOPBACK\s*\)/.test(src),
    'the "binding beyond loopback" warning is behind IS_PROD, so it cannot print under ' +
      'npm run dev, which is the command that actually runs this app'
  );
});

/**
 * `npm start` actually enters production mode.
 *
 * `IS_PROD` is `NODE_ENV === 'production'` and the start script did not set it, so every branch
 * behind it was unreachable from either documented command: helmet's full defaults (the non-prod
 * branch passes `contentSecurityPolicy: false`), the production CORS policy, the CORS_ORIGIN
 * startup notices, and `express.static(dist/client)` with its SPA fallback. `npm run build` wrote
 * a client bundle that `npm start` then never served, because vite-express started a dev server
 * instead. README.md documents build-then-start as the way to run the built app.
 */
test('npm start sets NODE_ENV=production, so the production branches are reachable', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.match(
    pkg.scripts.start,
    /NODE_ENV=production/,
    'npm start does not enter production mode, so helmet CSP, the prod CORS policy and the built ' +
      'client are all dead code'
  );
  // dev must NOT set it: the whole point is that the two modes differ and both are reachable.
  assert.doesNotMatch(pkg.scripts.dev, /NODE_ENV=production/);
});

test('the production branch still binds to the same host as the dev branch', () => {
  const src = codeWithoutComments(readFileSync(join(ROOT, 'server/src/index.ts'), 'utf8'));
  // Arming IS_PROD must not reintroduce a second listen path with its own host handling. There is
  // exactly one call, and it takes HOST.
  const listens = src.match(/listenOnHost\s*\(/g) ?? [];
  assert.equal(listens.length, 1, 'more than one listen path; the host can diverge again');
  assert.match(src, /listenOnHost\(app,\s*PORT,\s*HOST/);
});
