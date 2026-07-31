import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { suggestCategoriesForMerchants, MAX_SUGGEST_MERCHANTS } from '../server/src/services/aiCategorySuggest';

function setupDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE categories (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT,
      is_income INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0
    );
    -- The classifier reads its model assignment from preferences now, because the owner can
    -- point this job at a different provider than the advisor uses. An absent table would be
    -- a thrown "no such table", not a fall back to the default.
    CREATE TABLE app_preferences (
      key TEXT PRIMARY KEY, value TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);
  db.prepare("INSERT INTO categories (id,name,is_income) VALUES ('cat_food_groceries','Groceries',0)").run();
  return db;
}

test('returns no suggestions when no API key is configured (never throws)', async (t) => {
  const db = setupDb();
  t.after(() => db.close());
  const previous = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  t.after(() => {
    if (previous !== undefined) process.env.ANTHROPIC_API_KEY = previous;
  });

  assert.deepEqual(await suggestCategoriesForMerchants(db, ['COSTCO WHSE #0333']), []);
});

test('an empty merchant list short-circuits without calling the model', async (t) => {
  const db = setupDb();
  t.after(() => db.close());
  // No API key needed: the empty/whitespace filter runs before the client is used.
  const previous = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-key-not-used';
  t.after(() => {
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previous;
  });

  assert.deepEqual(await suggestCategoriesForMerchants(db, []), []);
  assert.deepEqual(await suggestCategoriesForMerchants(db, ['   ', '']), []);
});

test('the batch cap is exported so client and server stay in sync', () => {
  // The client slices its request to this same number; if they drift, the model's reply gets
  // truncated mid-JSON and suggestions silently go missing.
  assert.equal(MAX_SUGGEST_MERCHANTS, 60);
});
