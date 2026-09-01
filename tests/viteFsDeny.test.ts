import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');

/**
 * The data directory is not servable by the dev file server.
 *
 * In dev, vite-express mounts Vite's middleware at '/' after the API routers, and
 * `localOriginGuard` is mounted on '/api' only, so a `/@fs/<abs path>` request passes through
 * none of this app's own middleware. Vite's `serveRawFsMiddleware` serves anything under
 * `fs.allow` (the workspace root, which contains `.mizan/`), and its default `fs.deny` covers
 * `.env`, `*.pem` and `.git` but not this. `.mizan/mizan.db` is the entire ledger in one file.
 *
 * Driven for real against the running dev server while writing this:
 *   /@fs/<repo>/package.json               -> 200
 *   /@fs/<repo>/.mizan-scratch/mizan.db    -> 403
 *   /@fs/<repo>/.mizan-scratch/credentials.json -> 403
 * The first line is why the other two matter: arbitrary repo files really are reachable.
 */
test('vite.config.ts denies the data directory to the file server', () => {
  const config = readFileSync(join(ROOT, 'vite.config.ts'), 'utf8');
  assert.match(config, /fs:\s*\{/, 'no server.fs config at all');
  assert.match(config, /'\*\*\/\.mizan\/\*\*'/, '.mizan/ is servable over /@fs');
  assert.match(config, /'\*\*\/\.mizan-\*\/\*\*'/, 'a scratch data directory is servable over /@fs');
  // Vite's own defaults are not inherited when `deny` is set, so they have to be carried forward.
  for (const pattern of ["'.env'", "'.env.*'", "'*.{crt,pem}'", "'**/.git/**'"]) {
    assert.ok(config.includes(pattern), `overriding fs.deny dropped Vite's default ${pattern}`);
  }
});

test('every data directory the app can use is covered by the deny list', () => {
  const config = readFileSync(join(ROOT, 'vite.config.ts'), 'utf8');
  const dbIndex = readFileSync(join(ROOT, 'server/src/db/index.ts'), 'utf8');
  // MIZAN_DIR is either `.mizan` or whatever MIZAN_DIR_OVERRIDE names. The convention for a scratch
  // directory is `.mizan-*`, which .gitignore also carries; if that convention changes, the deny
  // list and the ignore file both have to change with it, and this is where a reader finds out.
  assert.match(dbIndex, /MIZAN_DIR_OVERRIDE/, 'the override was removed; revisit the deny patterns');
  assert.match(dbIndex, /path\.join\(process\.cwd\(\), '\.mizan'\)/);
  assert.ok(config.includes('.mizan-*'), 'the scratch convention is not denied');
});
