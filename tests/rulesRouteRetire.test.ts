import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import Database from 'better-sqlite3';
import { migratedTestDb, insertCategory } from './helpers/schema';
import { _setDbForTesting } from '../server/src/db/index';
import rulesRouter from '../server/src/routes/rules';
import { upsertMerchantRule } from '../server/src/services/rules';

/**
 * Deleting a rule from Settings retires it and leaves a record.
 *
 * `DELETE /api/rules/:id` ran `DELETE FROM merchant_rules`, so a rule the model had created and
 * the owner then removed vanished from everywhere the prompt could see while the AI's action
 * history kept counting the creation as applied: on the live ledger, 63 rule creations reported
 * applied and four of those rules gone with nothing saying so. Retiring writes a
 * `merchant_rule_revisions` row (the schema's `operation` CHECK has no 'delete'), the rules list
 * already hides retired rows, and the owner can put the rule back from the same screen, which a
 * delete could never offer.
 */
async function withServer(db: Database.Database, fn: (baseUrl: string) => Promise<void>): Promise<void> {
  _setDbForTesting(db);
  const app = express();
  app.use(express.json());
  app.use('/api/rules', rulesRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no server address');
    await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    _setDbForTesting(null);
    db.close();
  }
}

test('DELETE /api/rules/:id retires the rule and records that it did', async () => {
  const db = migratedTestDb();
  const category = insertCategory(db);
  const created = upsertMerchantRule(db, 'Qvist Nordheim', category, '2026-07-01T00:00:00.000Z', { source: 'ai' });
  assert.ok(created.ruleId);

  await withServer(db, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/rules/${created.ruleId}`, { method: 'DELETE' });
    assert.equal(res.status, 200);

    // The row survives, retired, so the AI's history still has something to point at.
    const row = db.prepare('SELECT retired_at FROM merchant_rules WHERE id = ?').get(created.ruleId) as
      | { retired_at: string | null }
      | undefined;
    assert.ok(row, 'the rule was hard-deleted');
    assert.ok(row.retired_at, 'the rule was not retired');

    // And the decision is recorded as the owner's, not the model's.
    const revision = db
      .prepare("SELECT operation, source FROM merchant_rule_revisions WHERE rule_id = ? ORDER BY rowid DESC LIMIT 1")
      .get(created.ruleId) as { operation: string; source: string };
    assert.deepEqual(revision, { operation: 'retire', source: 'human' });

    // The list the owner sees no longer carries it, exactly as before.
    const list = await fetch(`${baseUrl}/api/rules`);
    const body = (await list.json()) as { data: Array<{ id: string }> };
    assert.equal(body.data.some((r) => r.id === created.ruleId), false, 'a retired rule is still listed as live');
  });
});

test('HEALTHY: deleting an unknown rule is still a 404 and writes nothing', async () => {
  const db = migratedTestDb();
  await withServer(db, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/rules/no_such_rule`, { method: 'DELETE' });
    assert.equal(res.status, 404);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM merchant_rule_revisions').get() as { n: number }).n, 0);
  });
});

/**
 * PATCH moved a rule's category with a bare UPDATE: no revision, no updated_at, and an AI rule
 * kept claiming its action, so undo could revert the owner's edit and the revision log said nothing.
 */
test('PATCH /api/rules/:id records the recategorize as the owner\'s revision', async () => {
  const db = migratedTestDb();
  const from = insertCategory(db, { name: 'Coffee' });
  const to = insertCategory(db, { name: 'Groceries' });
  const ruleId = upsertMerchantRule(db, 'Blue Bottle', from, '2026-01-01T00:00:00.000Z', { source: 'ai', actionId: 'act_1' }).ruleId;

  await withServer(db, async (base) => {
    const res = await fetch(`${base}/api/rules/${ruleId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ category_id: to }),
    });
    assert.equal(res.status, 200);
    const rule = db.prepare('SELECT category_id, source, action_id FROM merchant_rules WHERE id = ?').get(ruleId);
    assert.deepEqual(rule, { category_id: to, source: 'human', action_id: null });
    const revision = db.prepare(
      "SELECT from_category_id, to_category_id, source FROM merchant_rule_revisions WHERE rule_id = ? AND operation = 'recategorize'"
    ).all(ruleId);
    assert.deepEqual(revision, [{ from_category_id: from, to_category_id: to, source: 'human' }]);
  });
});

test('HEALTHY: a PATCH that changes nothing writes no revision and leaves provenance alone', async () => {
  const db = migratedTestDb();
  const cat = insertCategory(db, { name: 'Coffee' });
  const ruleId = upsertMerchantRule(db, 'Blue Bottle', cat, '2026-01-01T00:00:00.000Z', { source: 'ai', actionId: 'act_1' }).ruleId;
  const before = (db.prepare('SELECT COUNT(*) AS n FROM merchant_rule_revisions').get() as { n: number }).n;

  await withServer(db, async (base) => {
    const res = await fetch(`${base}/api/rules/${ruleId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ category_id: cat, pattern: 'Blue Bottle' }),
    });
    assert.equal(res.status, 200);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM merchant_rule_revisions').get() as { n: number }).n, before);
    assert.deepEqual(db.prepare('SELECT source, action_id FROM merchant_rules WHERE id = ?').get(ruleId), { source: 'ai', action_id: 'act_1' });
  });
});

/** The id of a rule the call created or matched; a null here means the fixture itself is wrong. */
function ruleIdOf(result: { ruleId: string | null }): string {
  if (!result.ruleId) throw new Error('upsertMerchantRule returned no rule id');
  return result.ruleId;
}

test('PATCH refuses a retired rule and a pattern another live rule holds, instead of a 500', async () => {
  const db = migratedTestDb();
  const cat = insertCategory(db, { name: 'Coffee' });
  const a = ruleIdOf(upsertMerchantRule(db, 'Blue Bottle', cat, '2026-01-01T00:00:00.000Z', { source: 'human' }));
  const b = ruleIdOf(upsertMerchantRule(db, 'Starbucks', cat, '2026-01-01T00:00:00.000Z', { source: 'human' }));
  db.prepare("UPDATE merchant_rules SET retired_at = '2026-02-01T00:00:00.000Z' WHERE id = ?").run(a);

  await withServer(db, async (base) => {
    const patch = (id: string, body: unknown) => fetch(`${base}/api/rules/${id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal((await patch(a, { pattern: 'Blue Bottle Coffee' })).status, 409);
    const c = ruleIdOf(upsertMerchantRule(db, 'Peets', cat, '2026-01-01T00:00:00.000Z', { source: 'human' }));
    const collide = await patch(c, { pattern: 'starbucks' });
    assert.equal(collide.status, 409);
    assert.match(((await collide.json()) as { error: string }).error, /Another rule already matches/);
    assert.equal((db.prepare('SELECT pattern FROM merchant_rules WHERE id = ?').get(b) as { pattern: string }).pattern, 'Starbucks');
  });
});
