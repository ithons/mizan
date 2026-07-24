import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runAdvisorTool } from '../server/src/services/advisorChatTools';

// describe_schema and run_sql_query use the module-level read-only connection (getReadOnlyDb),
// not the passed db, so the passed handle is irrelevant for them — pass a throwaway.
const dummy = new Database(':memory:');

test('describe_schema lists the finance tables', () => {
  const r = runAdvisorTool(dummy, 'describe_schema', {}) as { schema: Record<string, string[]> };
  assert.ok(r.schema.transactions, 'expected a transactions table');
  assert.ok(r.schema.accounts, 'expected an accounts table');
  assert.ok(r.schema.transactions.some((c) => c.startsWith('amount ')), 'columns should be listed');
});

test('run_sql_query runs a read-only SELECT', () => {
  const r = runAdvisorTool(dummy, 'run_sql_query', { sql: 'SELECT 1 AS one, 2 AS two' }) as {
    row_count: number; rows: Array<Record<string, number>>;
  };
  assert.equal(r.row_count, 1);
  assert.equal(r.rows[0].one, 1);
});

test('run_sql_query REJECTS a write (the security boundary)', () => {
  for (const sql of [
    "UPDATE accounts SET account_name = 'hacked'",
    "DELETE FROM transactions",
    "INSERT INTO categories (id, name) VALUES ('x', 'x')",
    "DROP TABLE accounts",
  ]) {
    const r = runAdvisorTool(dummy, 'run_sql_query', { sql }) as { error?: string };
    assert.ok(r.error, `expected write to be rejected: ${sql}`);
  }
});

test('run_sql_query caps returned rows at the limit', () => {
  const r = runAdvisorTool(dummy, 'run_sql_query', {
    sql: 'SELECT name FROM sqlite_master', limit: 3,
  }) as { row_count: number; rows: unknown[] };
  assert.ok(r.row_count <= 3);
  assert.equal(r.rows.length, r.row_count);
});
