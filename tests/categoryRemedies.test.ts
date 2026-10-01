import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type Database from 'better-sqlite3';
import { _setDbForTesting } from '../server/src/db/index';
import categoriesRouter from '../server/src/routes/categories';
import { upsertMerchantRule } from '../server/src/services/rules';
import { CategoryRow, mergeTargetAllowed } from '../client/src/views/settings/CategoriesSection';
import type { Category } from '../shared/types';
import { TEST_NOW, insertAccount, insertCategory, insertTransaction, migratedTestDb } from './helpers/schema';

/**
 * A category delete refusal names a remedy, and the remedy has to be something the app offers.
 *
 * The 409s said "Merge it first", "Move or merge them first" and "repoint the rule(s) first" while
 * `categoriesApi.merge` had no caller anywhere in client/src and nothing could change a
 * subcategory's parent. A rule can be repointed from Settings, but its history already names the
 * category from the rule's creation, and that history blocks the delete on its own, so the advice
 * could be followed and never worked. Both categories the owner had made carried
 * transactions and rules, so neither could ever be deleted and the only advice given was
 * unreachable. Merge is offered on the row again; the other two were dropped from the copy.
 */

const ROOT = join(import.meta.dirname, '..');
const SECTION = 'client/src/views/settings/CategoriesSection.tsx';

function clientSources(): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name) && full !== join(ROOT, 'client/src/lib/api.ts')) {
        out.push({ path: full.slice(ROOT.length + 1), text: readFileSync(full, 'utf8') });
      }
    }
  };
  walk(join(ROOT, 'client/src'));
  return out;
}

async function request(
  db: Database.Database,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; error?: string }> {
  _setDbForTesting(db);
  const app = express();
  app.use(express.json());
  app.use('/api/categories', categoriesRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no server address');
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/categories${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json()) as { error?: string };
    return { status: res.status, error: json.error };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** A category blocked by every kind of reference the refusal copy names a remedy for. */
function blockedByEverything(db: Database.Database): string {
  const accountId = insertAccount(db);
  const id = insertCategory(db, { name: 'Toll' });
  insertCategory(db, { name: 'Bridge', parent_id: id });
  insertTransaction(db, { account_id: accountId, category_id: id });
  upsertMerchantRule(db, 'E-ZPass', id, TEST_NOW, { source: 'human' });
  db.prepare(`
    INSERT INTO budgets (id, category_id, amount, period, rollover, rollover_balance, created_at, updated_at)
    VALUES ('bud_toll', ?, 5000, 'monthly', 0, 0, ?, ?)
  `).run(id, TEST_NOW, TEST_NOW);
  return id;
}

/**
 * Each remedy the refusal may name, and the client call that performs it. A phrase the refusal
 * uses that is not in this table is a remedy nobody checked is reachable.
 */
const REMEDIES: Array<{ phrase: RegExp; fetcher: string }> = [
  { phrase: /Merge it instead/, fetcher: 'categoriesApi.merge' },
  // A subcategory's own row carries the trash button.
  { phrase: /or delete them first/, fetcher: 'categoriesApi.delete' },
  { phrase: /delete the budget first/, fetcher: 'budgetsApi.delete' },
  { phrase: /clear the declined suggestions? in Settings/, fetcher: 'aiApi.restoreDeclined' },
];

test('a delete refusal names no remedy the app does not offer', async (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const refusal = await request(db, 'DELETE', `/${blockedByEverything(db)}`);
  assert.equal(refusal.status, 409);
  const error = refusal.error ?? '';
  assert.doesNotMatch(error, /repoint (the|those) rules?/i, 'a repointed rule\'s history still names this category, and that history blocks the delete too');
  assert.doesNotMatch(error, /\bMove\b/, 'nothing in the client can change a subcategory\'s parent');
  assert.doesNotMatch(error, /Merge it first/, 'a merge deletes the source, so there is no delete after it');
  for (const { phrase } of REMEDIES.slice(0, 3)) assert.match(error, phrase);
  // Strip every remedy the table vouches for; what is left must name no other action.
  const unvouched = REMEDIES.reduce((rest, { phrase }) => rest.replace(new RegExp(phrase, 'g'), ''), error);
  assert.doesNotMatch(unvouched, /\b(Merge|Move|repoint|delete the|clear the)\b[^.]*first/i);
});

test('every remedy the refusal copy names has a caller in the client', () => {
  const sources = clientSources();
  for (const { fetcher } of REMEDIES) {
    const callers = sources.filter((f) => f.text.includes(fetcher)).map((f) => f.path);
    assert.ok(callers.length > 0, `${fetcher} is named as a remedy and nothing in client/src calls it`);
  }
  const mergeCallers = sources.filter((f) => f.text.includes('categoriesApi.merge')).map((f) => f.path);
  assert.deepEqual(mergeCallers, [SECTION], 'merge is offered where the delete is refused');
});

function row(overrides: Partial<Category>): string {
  const category: Category = {
    id: 'cat_toll',
    name: 'Toll',
    icon: null,
    color: '#207029',
    parent_id: null,
    is_income: false,
    is_system: false,
    is_investment: false,
    sort_order: 0,
    children: [],
    ...overrides,
  };
  return renderToStaticMarkup(
    createElement(CategoryRow, {
      category,
      onEdit: async () => true,
      onDelete: () => undefined,
      onMerge: () => undefined,
      onAddChild: () => undefined,
      depth: 0,
    })
  );
}

test('a category the owner made offers merge on its row', () => {
  assert.match(row({}), /title="Merge into another category"/);
});

test('HEALTHY: a system category offers no merge, because the server refuses to merge one', () => {
  assert.doesNotMatch(row({ is_system: true }), /Merge into another category/);
});

test('HEALTHY: the merge the row offers goes through, so the remedy is real', async (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const source = blockedByEverything(db);
  const target = insertCategory(db, { name: 'Transport' });
  const merged = await request(db, 'POST', `/${source}/merge`, { targetId: target });
  assert.equal(merged.status, 200);
  assert.equal(db.prepare('SELECT 1 FROM categories WHERE id = ?').get(source), undefined);
});

function category(id: string, overrides: Partial<Category> = {}): Category {
  return {
    id,
    name: id,
    parent_id: null,
    is_income: false,
    is_system: false,
    is_investment: false,
    sort_order: 0,
    children: [],
    ...overrides,
  };
}

test('a category with subcategories cannot be merged into a subcategory, which would nest them out of sight', () => {
  const source = category('toll', { children: [category('bridge', { parent_id: 'toll' })] });
  assert.equal(mergeTargetAllowed(source, category('parking', { parent_id: 'transport' })), false);
  assert.equal(mergeTargetAllowed(source, category('transport')), true);
  assert.equal(mergeTargetAllowed(source, source), false);
});

test('HEALTHY: a category with no subcategories can merge into any other, subcategory or not', () => {
  const source = category('fines');
  assert.equal(mergeTargetAllowed(source, category('parking', { parent_id: 'transport' })), true);
  assert.equal(mergeTargetAllowed(source, category('transport')), true);
});

test('repointing a rule away from a category does not unblock the delete: its history still names the category', async (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());
  const toll = insertCategory(db, { name: 'Toll' });
  const travel = insertCategory(db, { name: 'Road travel' });
  upsertMerchantRule(db, 'E-ZPass', toll, TEST_NOW, { source: 'human' });

  // What Settings does when the owner re-enters the pattern under another category.
  assert.equal(upsertMerchantRule(db, 'E-ZPass', travel, TEST_NOW, { source: 'human' }).status, 'recategorized');
  const pointing = db.prepare('SELECT COUNT(*) AS n FROM merchant_rules WHERE category_id = ?').get(toll) as { n: number };
  assert.equal(pointing.n, 0, 'the repoint did not move the rule');

  const history = db.prepare(
    'SELECT COUNT(*) AS n FROM merchant_rule_revisions WHERE from_category_id = ? OR to_category_id = ?'
  ).get(toll, toll) as { n: number };
  assert.ok(history.n > 0, 'nothing in the rule history names the category');

  const refusal = await request(db, 'DELETE', `/${toll}`);
  assert.equal(refusal.status, 409);
  assert.match(refusal.error ?? '', /change history/);
});
