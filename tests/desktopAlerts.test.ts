import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('a desktop alert fires only for a notification created after the page loaded, once', () => {
  const source = readFileSync(new URL('../client/src/lib/desktopAlerts.ts', import.meta.url), 'utf8');
  assert.match(source, /if \(n\.created_at <= loadedAt\.current \|\| alerted\.current\.has\(n\.id\)\) continue;/);
});
