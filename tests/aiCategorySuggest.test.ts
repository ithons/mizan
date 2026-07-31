import test from 'node:test';
import assert from 'node:assert/strict';
import { migratedTestDb } from './helpers/schema';
import { suggestCategoriesForMerchants, MAX_SUGGEST_MERCHANTS } from '../server/src/services/aiCategorySuggest';

// The classifier reads its model assignment from `app_preferences`, because the owner can point
// this job at a different provider than the advisor uses. An absent table would be a thrown
// "no such table", not a fall back to the default, so the real schema is what proves the path.
const setupDb = migratedTestDb;

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
