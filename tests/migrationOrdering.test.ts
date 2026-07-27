import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// runMigrations() sorts by full filename, so two files sharing an NNN_ prefix have incidental
// relative order: it falls out of whatever comes next alphabetically. That is fine until two
// such migrations touch the same table, at which point the schema you get depends on a
// filename. It has already happened once here (two 037_ files, written minutes apart).
//
// A test rather than a startup check: the failure mode is authoring-time, and a developer
// adding the second 037_ should hear about it before it reaches a database.

const MIGRATIONS_DIR = path.join(process.cwd(), 'server/src/db/migrations');

function migrationFiles(): string[] {
  return fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
}

test('every migration filename starts with a three-digit number and an underscore', () => {
  for (const file of migrationFiles()) {
    assert.match(file, /^\d{3}_[a-z0-9_]+\.sql$/, `${file} does not match NNN_snake_case.sql`);
  }
});

test('no two migrations share a number prefix', () => {
  const byPrefix = new Map<string, string[]>();
  for (const file of migrationFiles()) {
    const prefix = file.slice(0, 3);
    byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), file]);
  }

  const collisions = [...byPrefix.entries()].filter(([, files]) => files.length > 1);
  assert.deepEqual(
    collisions,
    [],
    `Duplicate migration numbers: ${collisions.map(([n, f]) => `${n} -> ${f.join(', ')}`).join('; ')}`
  );
});

test('migration numbers have no gaps, so a missing file is visible', () => {
  const numbers = migrationFiles().map((f) => Number(f.slice(0, 3)));
  // 038 is deliberately absent: it was renumbered to 040 after the 037 collision, and its
  // schema_migrations row was removed with it. Recording the exception here rather than
  // weakening the check, so a genuinely lost migration still fails this.
  const KNOWN_GAPS = new Set([38]);
  const missing: number[] = [];
  for (let n = numbers[0]; n < numbers[numbers.length - 1]; n++) {
    if (!numbers.includes(n) && !KNOWN_GAPS.has(n)) missing.push(n);
  }
  assert.deepEqual(missing, [], `Missing migration numbers: ${missing.join(', ')}`);
});
