import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { _setReadOnlyDbPathForTesting, runMigrationsOn } from '../server/src/db/index';
import { runAdvisorTool } from '../server/src/services/advisorChatTools';

/**
 * run_sql_query is the only place model-authored SQL executes. Two properties have to hold at once:
 *
 *  - it cannot write (the connection is opened read-only, and the engine enforces that), and
 *  - it cannot hang the app, which is a single process that also serves the UI.
 *
 * The second is the one these tests are mostly about, because the mechanism is unusual: the query
 * runs in a child process that `spawnSync` SIGKILLs on a wall clock. Nothing in-process can do it.
 * better-sqlite3 binds neither `sqlite3_interrupt` nor `sqlite3_progress_handler`, a deadline
 * checked between rows never fires for a query that produces no rows, and a worker thread cannot be
 * preempted while it is blocked inside a native call.
 *
 * The half these tests exist to protect is the HEALTHY one: an ordinary query must come back with
 * exactly the rows the same SQL returns in-process, untruncated, unflagged, and fast.
 */

const TIMEOUT_MS = 1200;
let dbPath = '';
let inProcess: Database.Database;

// A real file (not :memory:) because the child opens the database by path, which is the whole
// point: the child gets its own read-only handle on the same file the app reads.
test.before(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizan-sql-'));
  dbPath = path.join(dir, 'test.db');
  const seed = new Database(dbPath);
  runMigrationsOn(seed);
  seed.prepare(`
    INSERT INTO accounts (id, connection_type, institution_name, account_name, type,
      current_balance, is_liability, is_hidden, is_manual, created_at, updated_at)
    VALUES ('acct_chk','manual','Bank','Checking','checking',250000,0,0,1,'2026-07-01','2026-07-01')
  `).run();
  const insert = seed.prepare(`
    INSERT INTO transactions (id, account_id, date, amount, original_name, source_type, created_at, updated_at)
    VALUES (?, 'acct_chk', ?, ?, ?, 'manual', '2026-07-01', '2026-07-01')
  `);
  for (let i = 1; i <= 40; i += 1) {
    insert.run(`txn_${i}`, `2026-07-${String((i % 28) + 1).padStart(2, '0')}`, -i * 100, `Merchant ${i}`);
  }
  seed.close();

  process.env.MIZAN_SQL_QUERY_TIMEOUT_MS = String(TIMEOUT_MS);
  _setReadOnlyDbPathForTesting(dbPath);
  inProcess = new Database(dbPath, { readonly: true });
});

test.after(() => {
  inProcess.close();
  delete process.env.MIZAN_SQL_QUERY_TIMEOUT_MS;
});

function query(sql: string, limit?: number): Record<string, unknown> {
  return runAdvisorTool(inProcess, 'run_sql_query', limit === undefined ? { sql } : { sql, limit }) as Record<
    string,
    unknown
  >;
}

// ─── The healthy case: an ordinary query is not affected in any way ───

test('an ordinary aggregate returns exactly what the same SQL returns in-process', () => {
  const sql = 'SELECT COUNT(*) AS n, SUM(amount) AS total FROM transactions';
  const expected = inProcess.prepare(sql).get() as { n: number; total: number };

  const result = query(sql);
  assert.equal(result.error, undefined, 'a healthy query must not report an error');
  assert.equal(result.timed_out, undefined, 'a healthy query must not be flagged as killed');
  assert.equal(result.truncated, false);
  assert.equal(result.row_count, 1);
  assert.deepEqual(result.rows, [{ n: expected.n, total: expected.total }]);
});

test('a healthy multi-row query returns every row, in order, untruncated', () => {
  const sql = 'SELECT id, date, amount FROM transactions ORDER BY id LIMIT 40';
  const expected = inProcess.prepare(sql).all();

  const result = query(sql, 100);
  assert.equal(result.error, undefined);
  assert.equal(result.truncated, false);
  assert.equal(result.row_count, 40);
  assert.deepEqual(result.rows, expected);
});

test('a healthy query is fast: the kill mechanism adds process startup, not seconds', () => {
  const started = Date.now();
  const result = query('SELECT 1 AS one');
  const elapsed = Date.now() - started;

  assert.equal(result.error, undefined);
  assert.deepEqual(result.rows, [{ one: 1 }]);
  assert.ok(elapsed < TIMEOUT_MS, `a trivial query took ${elapsed} ms, which is at or past the kill budget`);
});

test('an empty result is an empty result, not an error', () => {
  const result = query("SELECT id FROM transactions WHERE original_name = 'nothing at all'");
  assert.equal(result.error, undefined);
  assert.equal(result.row_count, 0);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.rows, []);
});

test('NULLs and text come back unchanged, so nothing is quietly coerced', () => {
  const sql = "SELECT NULL AS missing, 'text' AS word, 1.5 AS fraction";
  assert.deepEqual(query(sql).rows, inProcess.prepare(sql).all());
});

// ─── The row cap ───

test('the row cap truncates and says so', () => {
  const result = query('SELECT id FROM transactions ORDER BY id', 5);
  assert.equal(result.row_count, 5);
  assert.equal(result.truncated, true);
});

test('a result exactly at the cap is not falsely reported as truncated', () => {
  const result = query('SELECT id FROM transactions ORDER BY id LIMIT 5', 5);
  assert.equal(result.row_count, 5);
  assert.equal(result.truncated, false, 'exactly-at-the-limit is complete, not cut short');
});

// ─── The wall-clock kill ───

test('a query that would run forever is killed, and the message says what to do', () => {
  // Unbounded recursive CTE whose WHERE filters everything, so it produces NO rows. This is the
  // exact shape a between-rows deadline cannot catch: control never returns to JS.
  const runaway =
    'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) ' +
    'SELECT x FROM c WHERE x % 1000000000 = 0';

  const started = Date.now();
  const result = query(runaway);
  const elapsed = Date.now() - started;

  assert.equal(result.timed_out, true);
  assert.equal(result.timeout_ms, TIMEOUT_MS);
  assert.match(String(result.error), /was killed/);
  assert.match(String(result.error), /nothing was changed/);
  assert.match(String(result.suggestion), /Narrow it/);
  assert.equal(result.rows, undefined, 'a killed query must not hand back partial rows as if complete');
  assert.ok(elapsed < TIMEOUT_MS * 8, `the kill took ${elapsed} ms, which is not a wall clock`);
});

test('the app keeps working after a kill', () => {
  const result = query('SELECT COUNT(*) AS n FROM transactions');
  assert.equal(result.error, undefined);
  assert.deepEqual(result.rows, [{ n: 40 }]);
});

// ─── The write boundary, unchanged ───

test('writes are still refused, in every form', () => {
  for (const sql of [
    "UPDATE accounts SET account_name = 'hacked'",
    'DELETE FROM transactions',
    "INSERT INTO categories (id, name) VALUES ('x', 'x')",
    'DROP TABLE accounts',
    'CREATE TABLE evil (id TEXT)',
    'ALTER TABLE accounts RENAME TO gone',
  ]) {
    const result = query(sql);
    assert.ok(result.error, `expected a refusal for: ${sql}`);
    assert.equal(result.rows, undefined);
  }
  assert.equal((inProcess.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n, 40);
  assert.equal(
    (inProcess.prepare("SELECT account_name FROM accounts WHERE id = 'acct_chk'").get() as { account_name: string })
      .account_name,
    'Checking'
  );
});

test('a trailing statement after a semicolon is never compiled', () => {
  const result = query('SELECT 1 AS one; DROP TABLE accounts');
  // better-sqlite3 compiles only the first statement and rejects the leftover outright. Either
  // way the second statement must never run.
  if (!result.error) assert.deepEqual(result.rows, [{ one: 1 }]);
  assert.ok(inProcess.prepare("SELECT 1 FROM sqlite_master WHERE name = 'accounts'").get());
});

test('a broken query reports the SQL error rather than a generic failure', () => {
  const result = query('SELECT * FROM no_such_table');
  assert.match(String(result.error), /SQL error/);
  assert.match(String(result.error), /no_such_table/);
});

test('an empty sql argument is refused before anything is spawned', () => {
  assert.match(String(query('   ').error), /Provide a SQL SELECT statement/);
});
