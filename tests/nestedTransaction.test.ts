import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

// aiWorker wraps its draft loop in db.transaction() and, inside it, calls
// confirmAdvisorDraft which opens its own db.transaction() (a SAVEPOINT). When an
// auto-applied draft throws, the worker catches it and continues. This pins the
// better-sqlite3 semantics that make that safe: a caught failure in the inner
// transaction rolls back only its own savepoint, not the enclosing transaction.
// Deliberately NOT migratedTestDb(): `t` is not a stand-in for any production table. The subject
// is better-sqlite3's savepoint behaviour, and a one-column scratch table is the whole fixture.
test('a caught failure in a nested transaction rolls back only the inner savepoint', () => {
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE t (id INTEGER)');
    const insert = db.prepare('INSERT INTO t (id) VALUES (?)');

    const inner = db.transaction((fail: boolean) => {
      insert.run(2);
      if (fail) throw new Error('auto-apply failed');
    });

    const outer = db.transaction(() => {
      insert.run(1);
      try { inner(true); } catch { /* swallowed, like the worker's auto-apply catch */ }
      insert.run(3);
    });
    outer();

    const ids = (db.prepare('SELECT id FROM t ORDER BY id').all() as Array<{ id: number }>).map((r) => r.id);
    assert.deepEqual(ids, [1, 3]); // the inner insert (2) rolled back; the outer commits 1 and 3
  } finally {
    db.close();
  }
});
