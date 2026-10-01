import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import type Database from 'better-sqlite3';
import { _setDbForTesting } from '../server/src/db/index';
import categoriesRouter from '../server/src/routes/categories';
import { insertCategory, migratedTestDb } from './helpers/schema';

/**
 * A rename or recolour the server refused used to vanish.
 *
 * `editMutation` had no onError and main.tsx installs only a QueryCache handler, so a rejected
 * PATCH toasted nothing; the row closed edit mode before the server answered, then snapped back
 * to the old name. Clearing the name and pressing Enter was the easy way to get there, because
 * `UpdateCategorySchema` requires `min(1)`. The client cannot be driven without a DOM here, so the
 * row's half is pinned on its source and the server's half over HTTP.
 */

const ROOT = join(import.meta.dirname, '..');
const SECTION = 'client/src/views/settings/CategoriesSection.tsx';

async function patch(db: Database.Database, id: string, body: unknown): Promise<number> {
  _setDbForTesting(db);
  const app = express();
  app.use(express.json());
  app.use('/api/categories', categoriesRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no server address');
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/categories/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    await res.json();
    return res.status;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('every category mutation reports its own failure', () => {
  const src = readFileSync(join(ROOT, SECTION), 'utf8');
  const blocks = src.split('useMutation(').slice(1);
  assert.ok(blocks.length >= 3);
  for (const block of blocks) {
    const body = block.slice(0, block.indexOf('\n  });'));
    assert.match(body, /onError:/, `a mutation in ${SECTION} has no onError, so a rejected write is silent:\n${body}`);
  }
});

test('the row leaves edit mode only when the save landed, and will not send an empty name', () => {
  const src = readFileSync(join(ROOT, SECTION), 'utf8');
  const save = src.slice(src.indexOf('const handleSave'), src.indexOf('const smallField'));
  assert.match(save, /if \(await onEdit\(/, 'edit mode closes before the server has answered');
  assert.match(save, /if \(nameMissing\) return;/, 'an empty name is sent to a server that will refuse it');
});

test('HEALTHY: a real name still saves; an empty one is the 400 the client used to swallow', async (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const id = insertCategory(db, { name: 'Toll' });
  assert.equal(await patch(db, id, { name: '' }), 400);
  assert.equal(await patch(db, id, { name: 'Tolls' }), 200);
  assert.equal((db.prepare('SELECT name FROM categories WHERE id = ?').get(id) as { name: string }).name, 'Tolls');
});
