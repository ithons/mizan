import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import Database from 'better-sqlite3';
import { _setDbForTesting } from '../server/src/db/index';
import transactionsRouter from '../server/src/routes/transactions';
import { listTransactions, type TransactionListFilters } from '../server/src/services/transactions';
import { insertAccount, insertCategory, insertTransaction, migratedTestDb } from './helpers/schema';

/**
 * The predicates that let the review screen die.
 *
 * Uncategorized rows, duplicate candidates and transfer candidates were three tabs on a separate
 * screen, and all three are conditions on a column of `transactions`. They are filters here, so
 * the ledger can be the one list that answers all of them.
 *
 * These run against the REAL schema (`migratedTestDb`), because a filter naming a column is
 * exactly the kind of test a hand-written minimal schema cannot keep honest.
 */

function base(overrides: Partial<TransactionListFilters> = {}): TransactionListFilters {
  return {
    page: 1,
    limit: 50,
    sortBy: 'date',
    sortDir: 'desc',
    accountIds: [],
    categoryIds: [],
    ...overrides,
  };
}

function ids(result: { rows: Record<string, unknown>[] }): string[] {
  return result.rows.map((r) => String(r.id)).sort();
}

test('categorySource: each recorded author is selectable on its own', () => {
  const db = migratedTestDb();
  const account = insertAccount(db);
  const category = insertCategory(db, { name: 'Groceries' });
  insertTransaction(db, { id: 'mine', account_id: account, category_id: category, category_source: 'human' });
  insertTransaction(db, { id: 'model', account_id: account, category_id: category, category_source: 'ai' });
  insertTransaction(db, { id: 'ruled', account_id: account, category_id: category, category_source: 'rule' });

  assert.deepEqual(ids(listTransactions(db, base({ categorySources: ['human'] }))), ['mine']);
  assert.deepEqual(ids(listTransactions(db, base({ categorySources: ['ai', 'rule'] }))), ['model', 'ruled']);
});

test("categorySource: 'none' selects the pre-provenance rows, which a NULL cannot do from an IN list", () => {
  const db = migratedTestDb();
  const account = insertAccount(db);
  const category = insertCategory(db, { name: 'Groceries' });
  insertTransaction(db, { id: 'old', account_id: account, category_id: category, category_source: null });
  insertTransaction(db, { id: 'mine', account_id: account, category_id: category, category_source: 'human' });

  assert.deepEqual(ids(listTransactions(db, base({ categorySources: ['none'] }))), ['old']);
  // And mixed, because "everything I did not set" is a real question.
  assert.deepEqual(ids(listTransactions(db, base({ categorySources: ['none', 'ai'] }))), ['old']);
});

test('categorySource: a hand-edited row is found by its source, not by luck', () => {
  const db = migratedTestDb();
  const account = insertAccount(db);
  const category = insertCategory(db, { name: 'Groceries' });
  insertTransaction(db, {
    id: 'edited',
    account_id: account,
    category_id: category,
    category_source: 'human',
    manually_categorized: 1,
  });
  const rows = listTransactions(db, base({ categorySources: ['human'] })).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].manually_categorized, 1);
  assert.equal(rows[0].category_source, 'human');
});

test('duplicate and transfer candidacy are filters, which is all the review tabs ever were', () => {
  const db = migratedTestDb();
  const account = insertAccount(db);
  insertTransaction(db, { id: 'dup', account_id: account });
  insertTransaction(db, { id: 'xfer', account_id: account });
  insertTransaction(db, { id: 'settled', account_id: account });
  db.prepare("UPDATE transactions SET duplicate_status = 'candidate' WHERE id = 'dup'").run();
  db.prepare("UPDATE transactions SET transfer_status = 'candidate' WHERE id = 'xfer'").run();
  db.prepare("UPDATE transactions SET transfer_status = 'confirmed' WHERE id = 'settled'").run();

  assert.deepEqual(ids(listTransactions(db, base({ duplicateStatus: 'candidate' }))), ['dup']);
  assert.deepEqual(ids(listTransactions(db, base({ transferStatus: 'candidate' }))), ['xfer']);
  // A confirmed transfer is settled work, and asking for candidates must not return it.
  assert.deepEqual(ids(listTransactions(db, base({ transferStatus: 'confirmed' }))), ['settled']);
});

test('an id filter returns exactly those rows, in any order it is given', () => {
  const db = migratedTestDb();
  const account = insertAccount(db);
  insertTransaction(db, { id: 'a', account_id: account, date: '2026-07-01' });
  insertTransaction(db, { id: 'b', account_id: account, date: '2026-07-02' });
  insertTransaction(db, { id: 'c', account_id: account, date: '2026-07-03' });

  const result = listTransactions(db, base({ ids: ['c', 'a'] }));
  assert.deepEqual(ids(result), ['a', 'c']);
  assert.equal(result.total, 2);
});

test('an EMPTY id filter asks for zero rows, not for the whole ledger', () => {
  // The dangerous case. The "model suggests" chip sends the ids of every live proposal; when the
  // last one is accepted that list is empty, and collapsing an empty list to "no filter" would
  // answer "show me the 0 suggestions" with all 2,588 entries.
  const db = migratedTestDb();
  const account = insertAccount(db);
  insertTransaction(db, { id: 'a', account_id: account });
  insertTransaction(db, { id: 'b', account_id: account });

  const result = listTransactions(db, base({ ids: [] }));
  assert.deepEqual(result.rows, []);
  assert.equal(result.total, 0);
  // Undefined is how a caller says "no id filter", and it still means the whole set.
  assert.equal(listTransactions(db, base({ ids: undefined })).total, 2);
});

test('filters combine rather than replace each other', () => {
  const db = migratedTestDb();
  const account = insertAccount(db);
  const other = insertAccount(db);
  const category = insertCategory(db, { name: 'Groceries' });
  insertTransaction(db, { id: 'keep', account_id: account, category_id: category, category_source: 'ai', date: '2026-07-10' });
  insertTransaction(db, { id: 'wrong-account', account_id: other, category_id: category, category_source: 'ai', date: '2026-07-10' });
  insertTransaction(db, { id: 'wrong-date', account_id: account, category_id: category, category_source: 'ai', date: '2026-06-10' });

  const result = listTransactions(
    db,
    base({ accountIds: [account], categorySources: ['ai'], startDate: '2026-07-01', endDate: '2026-07-31' })
  );
  assert.deepEqual(ids(result), ['keep']);
});

test('a row carries whether its category is an income category, so a credit is not read as income', () => {
  // Without this the screen cannot tell an Amazon credit from a paycheck: both are positive
  // amounts, and the old Transactions view painted both in the income colour. Driving the real
  // route over a read-only copy of the live database for July 2026 returns 129 rows, of which 11
  // are positive with category_is_income = 0 (the largest being Amazon at +$759.36) and 9 are
  // positive with category_is_income = 1.
  const db = migratedTestDb();
  const account = insertAccount(db);
  const shopping = insertCategory(db, { name: 'Shopping', is_income: 0 });
  const paycheck = insertCategory(db, { name: 'Paycheck', is_income: 1 });
  insertTransaction(db, { id: 'credit', account_id: account, category_id: shopping, amount: 75936 });
  insertTransaction(db, { id: 'pay', account_id: account, category_id: paycheck, amount: 54418 });
  insertTransaction(db, { id: 'unplaced', account_id: account, category_id: null, amount: 1000 });

  const rows = listTransactions(db, base()).rows;
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  assert.equal(byId.get('credit')?.category_is_income, 0);
  assert.equal(byId.get('pay')?.category_is_income, 1);
  // No category means no reading. NULL rather than 0, because 0 would assert "not income" about a
  // row nobody has placed anywhere.
  assert.equal(byId.get('unplaced')?.category_is_income, null);
});

// ─── The route boundary ───────────────────────────────────────────────────────

/**
 * The id filter over real HTTP, because the defect it carries is invisible to a service test.
 *
 * Express parses the query string with `qs`, and `qs` stops emitting an ARRAY for a repeated key
 * past `arrayLimit`, which defaults to 20. Beyond that it emits an index-keyed OBJECT. Calling
 * `listTransactions` directly never sees that, so only a request through the router can catch it.
 * Found by driving this router against a read-only copy of the live database with 21+ ids: the
 * whole object was wrapped as one element, the id cap did not fire, and better-sqlite3 threw
 * "Too few parameter values were provided" as a 500.
 */
async function driveList(db: Database.Database, query: string): Promise<{ status: number; body: unknown }> {
  const app = express();
  app.use('/api/transactions', transactionsRouter);
  const server = app.listen(0);
  try {
    const port = (server.address() as { port: number }).port;
    return await new Promise((resolve, reject) => {
      http
        .get({ port, path: `/api/transactions?${query}` }, (res) => {
          let raw = '';
          res.on('data', (chunk) => (raw += chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : null }));
        })
        .on('error', reject);
    });
  } finally {
    server.close();
    void db;
  }
}

test('21 ids is an array, not an object wrapped as one element', async () => {
  const db = migratedTestDb();
  _setDbForTesting(db);
  const account = insertAccount(db);
  const wanted: string[] = [];
  for (let i = 0; i < 21; i += 1) {
    const id = `row_${i}`;
    insertTransaction(db, { id, account_id: account });
    wanted.push(id);
  }
  insertTransaction(db, { id: 'not_wanted', account_id: account });

  const res = await driveList(db, wanted.map((id) => `id=${id}`).join('&'));
  assert.equal(res.status, 200);
  const body = res.body as { data: { data: Array<{ id: string }>; total: number } };
  assert.equal(body.data.total, 21);
  assert.equal(body.data.data.some((r) => r.id === 'not_wanted'), false);
});

test('past the ceiling the request is refused, never truncated', async () => {
  const db = migratedTestDb();
  _setDbForTesting(db);
  const tooMany = Array.from({ length: 201 }, (_, i) => `id=x${i}`).join('&');
  const res = await driveList(db, tooMany);
  assert.equal(res.status, 400);
  assert.match(String((res.body as { error: string }).error), /At most 200/);
});

test('an empty id param survives the route as an empty set, not as no filter', async () => {
  const db = migratedTestDb();
  _setDbForTesting(db);
  const account = insertAccount(db);
  insertTransaction(db, { account_id: account });
  insertTransaction(db, { account_id: account });

  const empty = await driveList(db, 'id=');
  assert.equal((empty.body as { data: { total: number } }).data.total, 0);
  const unfiltered = await driveList(db, 'limit=50');
  assert.equal((unfiltered.body as { data: { total: number } }).data.total, 2);
});
