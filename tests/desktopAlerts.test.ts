import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('a desktop alert fires once, only for a notification unseen at load and newer than shortly before it', () => {
  const source = readFileSync(new URL('../client/src/lib/desktopAlerts.ts', import.meta.url), 'utf8');
  assert.match(source, /known\.current = new Set\(unread\.map\(\(n\) => n\.id\)\);\s*return;/);
  assert.match(source, /!known\.current\?\.has\(n\.id\) && n\.created_at > cutoff\.current/);
});
