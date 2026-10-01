import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { LEGACY_TARGETS, canonicalRoute } from '../shared/routes';
import { citationKindForIssue } from '../server/src/services/advisorTools';

/**
 * The server names only screens that exist.
 *
 * Twelve screens became six and `LEGACY_TARGETS` kept every old bookmark landing, which is exactly
 * why the server could go on emitting `/bills`, `/review`, `/budget` and `/reports` for a month:
 * nothing broke. But the advisor's context told the model `Review transactions -> /review`, its
 * draft example taught it `/transactions`, and the data-quality panel linked to `/bills`. A model
 * that reads a route as a place sends the owner to a screen that is not there.
 */

const SERVER_SRC = join(import.meta.dirname, '..', 'server', 'src');
const RETIRED = LEGACY_TARGETS.map((t) => t.from);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

test('HEALTHY: a route that already names a screen passes through untouched', () => {
  for (const route of ['/', '/?window=this-month', '/ledger', '/ledger?uncategorized=1', '/plan', '/settings?section=data', '/accounts/abc']) {
    assert.equal(canonicalRoute(route), route);
  }
});

test('a retired route becomes exactly what its redirect would give', () => {
  assert.equal(canonicalRoute('/bills'), '/ledger');
  assert.equal(canonicalRoute('/review'), '/ledger?uncategorized=1');
  // The redirect for /review does not carry its search, so neither does this.
  assert.equal(canonicalRoute('/review?queue=rule_suggestions'), '/ledger?uncategorized=1');
  assert.equal(canonicalRoute('/transactions?search=Spotify'), '/ledger?search=Spotify');
  assert.equal(canonicalRoute('/goals'), '/plan');
  assert.equal(canonicalRoute('/reports'), '/?window=this-month');
});

test('no server source names a retired screen in a string', () => {
  const quoted = new RegExp(`['"\`](${RETIRED.map((r) => r.replace('/', '\\/')).join('|')})(['"\`?/])`);
  const offenders: string[] = [];
  for (const file of sourceFiles(SERVER_SRC)) {
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      const code = line.trimStart();
      if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return;
      // An Express router path is an API path under its mount, not a screen.
      if (/\brouter\.(get|post|put|patch|delete)\(/.test(line)) return;
      if (quoted.test(line)) offenders.push(`${file.slice(SERVER_SRC.length + 1)}:${i + 1}: ${code}`);
    });
  }
  assert.deepEqual(offenders, [], 'these lines name a retired screen; emit canonicalRoute() of it instead');
});

test('an issue keeps its citation kind when its link moves', () => {
  // The kind used to be read off the route, so moving /bills to /ledger would have recited this
  // as generic data quality.
  assert.equal(citationKindForIssue('cash-flow-review'), 'recurring');
  assert.equal(citationKindForIssue('stale-pending-transactions'), 'transaction');
  assert.equal(citationKindForIssue('sync-stale'), 'sync');
  assert.equal(citationKindForIssue('an-issue-nobody-mapped'), 'data_quality');
});
