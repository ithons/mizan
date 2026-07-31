import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { runAdvisorTool } from '../server/src/services/advisorChatTools';
import { _setReadOnlyDbPathForTesting, runMigrationsOn } from '../server/src/db/index';
import { migratedTestDb, insertAccount, insertTransaction } from './helpers/schema';

/**
 * These two tools are the pair that does not read the handed connection the ordinary way.
 *
 * `describe_schema` now does, which is the point of half this file: it used to call getReadOnlyDb()
 * and so described a different database from every other tool, and that is what forced this test to
 * open the owner's installed `.mizan/mizan.db`. A test that reads the owner's live data cannot be
 * run on another machine, cannot be reasoned about (its assertions depended on whatever had synced
 * that morning), and throws outright where that file does not exist.
 *
 * `run_sql_query` genuinely cannot take a connection: it runs out of process against a file path so
 * a runaway query can be killed on a wall clock. It is pointed at a migrated file database built
 * here instead, which is the same hermetic guarantee by a different route.
 */
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizan-sql-tool-'));
const sqlDbPath = path.join(workDir, 'test.db');

function buildFileDatabase(): void {
  const db = new Database(sqlDbPath);
  db.pragma('foreign_keys = ON');
  runMigrationsOn(db);

  const accountId = insertAccount(db, { account_name: 'Checking' });
  // Enough rows that the timing assertion below is measuring real work rather than an empty table.
  const insert = db.prepare(`
    INSERT INTO transactions (id, account_id, date, amount, merchant_name, original_name, category_id,
                              manually_categorized, review_status, pending, source_type, created_at, updated_at)
    VALUES (?, ?, '2026-07-01', -1234, 'Cafe', 'Cafe', 'cat_food', 0, 'open', 0, 'manual',
            '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')
  `);
  const seed = db.transaction(() => {
    for (let i = 0; i < 5000; i += 1) insert.run(`sql_txn_${i}`, accountId);
  });
  seed();
  db.close();
}

buildFileDatabase();
_setReadOnlyDbPathForTesting(sqlDbPath);

test.after(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

// ─── describe_schema ───

test('describe_schema returns the finance tables with their units, not a bare column dump', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const doc = runAdvisorTool(db, 'describe_schema', {}) as {
    version: number;
    tables: Array<{ table: string; purpose: string | null; detail: string; columns?: Array<{ name: string; unit?: string }> }>;
    predicates: { excluded_from_totals: string; report_scope_condition: string };
    time: { today_local: string };
  };

  const transactions = doc.tables.find((t) => t.table === 'transactions');
  assert.ok(transactions, 'expected a transactions table');
  assert.equal(transactions.detail, 'full');
  assert.ok(doc.tables.some((t) => t.table === 'accounts'), 'expected an accounts table');

  const amount = transactions.columns?.find((c) => c.name === 'amount');
  assert.ok(amount, 'columns should be listed');
  assert.match(amount.unit ?? '', /integer cents/, 'and each should carry what it MEANS');
  assert.ok(transactions.purpose, 'a documented table should say what it is for');

  assert.match(doc.predicates.excluded_from_totals, /transfer_status/);
  assert.match(doc.predicates.report_scope_condition, /excluded_report_categories/);
  assert.match(doc.time.today_local, /^\d{4}-\d{2}-\d{2}$/);
});

test('describe_schema describes the connection it was handed, not some other one', (t) => {
  const populated = migratedTestDb();
  const empty = migratedTestDb();
  t.after(() => {
    populated.close();
    empty.close();
  });

  const account = insertAccount(populated);
  insertTransaction(populated, { account_id: account, category_source: 'human' });
  insertTransaction(populated, { account_id: account, category_source: 'rule' });

  const fromPopulated = runAdvisorTool(populated, 'describe_schema', {}) as {
    enums: Record<string, { observed: Record<string, number> }>;
  };
  const fromEmpty = runAdvisorTool(empty, 'describe_schema', {}) as {
    enums: Record<string, { observed: Record<string, number> }>;
  };

  assert.deepEqual(fromPopulated.enums.category_source.observed, { human: 1, rule: 1 });
  assert.deepEqual(fromEmpty.enums.category_source.observed, {}, 'a second connection must report its own rows');
});

test('every enum value in the database has a documented meaning', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  // Ordinary rows across the enums that decide whether a transaction counts. An undocumented value
  // here means the dictionary has fallen behind a migration.
  const account = insertAccount(db, { type: 'credit', connection_type: 'simplefin' });
  insertTransaction(db, { account_id: account, category_id: 'cat_food', category_source: 'rule', source_type: 'simplefin' });
  db.prepare("UPDATE transactions SET transfer_status = 'dismissed', duplicate_status = 'candidate', review_status = 'reviewed'").run();

  const doc = runAdvisorTool(db, 'describe_schema', {}) as {
    enums: Record<string, { undocumented_values: string[] }>;
  };
  for (const [key, meaning] of Object.entries(doc.enums)) {
    assert.deepEqual(meaning.undocumented_values, [], `${key} carries a value schemaDoc cannot explain`);
  }
});

// ─── run_sql_query ───

test('run_sql_query runs a read-only SELECT', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());
  const r = runAdvisorTool(db, 'run_sql_query', { sql: 'SELECT 1 AS one, 2 AS two' }) as {
    row_count: number; rows: Array<Record<string, number>>;
  };
  assert.equal(r.row_count, 1);
  assert.equal(r.rows[0].one, 1);
});

test('run_sql_query REJECTS a write (the security boundary)', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());
  for (const sql of [
    "UPDATE accounts SET account_name = 'hacked'",
    'DELETE FROM transactions',
    "INSERT INTO categories (id, name) VALUES ('x', 'x')",
    'DROP TABLE accounts',
  ]) {
    const r = runAdvisorTool(db, 'run_sql_query', { sql }) as { error?: string };
    assert.ok(r.error, `expected write to be rejected: ${sql}`);
  }

  // And the file itself is untouched: a rejection that had already written would be worse than none.
  const check = new Database(sqlDbPath, { readonly: true });
  const rows = check.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number };
  const named = check.prepare("SELECT COUNT(*) AS n FROM accounts WHERE account_name = 'hacked'").get() as { n: number };
  check.close();
  assert.equal(rows.n, 5000);
  assert.equal(named.n, 0);
});

test('run_sql_query caps returned rows at the limit', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());
  const r = runAdvisorTool(db, 'run_sql_query', {
    sql: 'SELECT id FROM transactions', limit: 3,
  }) as { row_count: number; rows: unknown[]; truncated: boolean };
  assert.equal(r.row_count, 3);
  assert.equal(r.truncated, true);
  assert.equal(r.rows.length, r.row_count);
});

test('an ordinary query is not slowed into the kill budget', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const started = Date.now();
  const r = runAdvisorTool(db, 'run_sql_query', { sql: 'SELECT COUNT(*) AS n FROM transactions' }) as {
    error?: string; timed_out?: boolean; rows: Array<{ n: number }>;
  };
  const elapsed = Date.now() - started;

  assert.equal(r.error, undefined);
  assert.equal(r.timed_out, undefined);
  assert.equal(r.rows[0].n, 5000);
  assert.ok(elapsed < 2000, `a count over 5,000 rows took ${elapsed} ms, including the child process`);
});
