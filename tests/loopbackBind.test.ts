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

test('SECURITY: the beyond-loopback warning is not gated on a mode neither npm script sets', () => {
  const src = codeWithoutComments(readFileSync(join(ROOT, 'server/src/index.ts'), 'utf8'));
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  // The premise, asserted rather than assumed: if a script ever starts setting NODE_ENV, the
  // reasoning behind this test changes and this is where a reader should find that out.
  for (const name of ['dev', 'start']) {
    assert.ok(
      !pkg.scripts[name].includes('NODE_ENV'),
      `npm run ${name} now sets NODE_ENV; revisit why IS_PROD gating was removed here`
    );
  }
  assert.ok(
    !/if\s*\(\s*IS_PROD\s*&&\s*!HOST_IS_LOOPBACK\s*\)/.test(src),
    'the "binding beyond loopback" warning is behind IS_PROD, which neither npm script sets, ' +
      'so it can never print on either documented command'
  );
});
