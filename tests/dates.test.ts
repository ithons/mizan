import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { epochSecondsToLocalDate, isoToLocalDate } from '../server/src/services/dates';

// The ingest normalizes provider instants to the server's LOCAL calendar day, matching the
// local "today"/month boundaries used everywhere else. These tests construct instants in
// local time (new Date(y, m, d, ...)) so they hold regardless of the machine's timezone.

test('epochSecondsToLocalDate returns the local calendar day of the instant', () => {
  const localNoon = new Date(2026, 2, 15, 12, 0, 0); // 2026-03-15 12:00 local
  assert.equal(epochSecondsToLocalDate(localNoon.getTime() / 1000), '2026-03-15');
});

test('a late-evening local instant stays on its local day (does not drift to the next UTC day)', () => {
  // Under the old UTC rule this would roll to 2026-03-16 in any timezone behind UTC.
  const lateLocal = new Date(2026, 2, 15, 23, 30, 0); // 2026-03-15 23:30 local
  assert.equal(epochSecondsToLocalDate(lateLocal.getTime() / 1000), '2026-03-15');
});

test('isoToLocalDate agrees with epochSecondsToLocalDate for the same instant', () => {
  const d = new Date(2026, 6, 13, 9, 15, 0);
  assert.equal(isoToLocalDate(d.toISOString()), epochSecondsToLocalDate(d.getTime() / 1000));
});

/**
 * NO FIXTURE READS SQLITE'S CLOCK, BECAUSE IT IS NOT THE CLOCK THE SERVICES READ.
 *
 * Every window in this codebase is local: `aiContext.ts` takes `startOfMonth(new Date())`,
 * `advisorTools.ts` takes `format(now, 'yyyy-MM')`, `dates.ts` normalizes provider instants to the
 * local calendar day. SQLite's `date('now')` is UTC. A fixture that calls it is therefore asserting
 * across two clocks that disagree for part of every day, and the disagreement is invisible on the
 * days it does not bite. It has bitten twice:
 *
 *   - 2026-07-31 20:20 local: `get_budgets returns budget vs this-month actual` wrote its row at
 *     `date('now')` = 2026-08-01 while the budget window was July, so `spent` came back 0.
 *   - 2026-08-01: five tests in `aiContextSections.test.ts` built month-to-date rows with a
 *     days-ago offset, landed them all in July, and asserted against an empty string.
 *
 * The second is the same fault in a different disguise: a date the fixture did not derive from the
 * clock the assertion is about. `dayInThisMonth`, `localToday` and `localDaysFromToday` in
 * `tests/helpers/schema.ts` are the local-calendar answers, and this test is what stops a third.
 */
const SQLITE_CLOCK =
  /\b(?:date|datetime|julianday|strftime|unixepoch)\s*\((?=[^)]*'now')|\bCURRENT_TIMESTAMP\b|\bCURRENT_DATE\b/;

/** Comments are removed first: the prose above, and in several fixtures, names the call on purpose. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function testSources(): Array<{ file: string; source: string }> {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) files.push(full);
    }
  };
  walk(root);
  return files.sort().map((file) => ({
    file: path.relative(root, file),
    source: fs.readFileSync(file, 'utf8'),
  }));
}

/**
 * This file is the one exclusion, because the positive control below has to write the very lines
 * the guard looks for. It is not a hiding place: the assertion under it proves this file cannot
 * open a database at all, so there is no fixture here for the exclusion to conceal.
 */
const GUARD_FILE = 'dates.test.ts';

test('the guard exclusion covers no fixture, so it cannot hide one', () => {
  const self = testSources().find(({ file }) => file === GUARD_FILE);
  assert.ok(self, 'the guard file is inside the walked tree');
  assert.doesNotMatch(
    self.source,
    /^\s*import[\s\S]*?from '(?:better-sqlite3|\.\/helpers\/schema)'/m,
    'a file that can open a database is a file that can hold a fixture, and must be guarded'
  );
});

test('no test fixture takes a date from SQLite instead of from the local calendar', () => {
  const sources = testSources().filter(({ file }) => file !== GUARD_FILE);
  assert.ok(sources.length > 100, 'the walk found the test tree');

  const offenders: string[] = [];
  for (const { file, source } of sources) {
    stripComments(source).split('\n').forEach((line, index) => {
      if (SQLITE_CLOCK.test(line)) offenders.push(`${file}:${index + 1}: ${line.trim()}`);
    });
  }

  assert.deepEqual(
    offenders,
    [],
    `A fixture is reading SQLite's UTC clock. Bind the date from tests/helpers/schema.ts instead:\n` +
      `  localToday()            today, local\n` +
      `  localDaysFromToday(n)   a signed day offset, local\n` +
      `  dayInThisMonth(day)     a day inside the current local month, never in the future\n` +
      offenders.join('\n')
  );
});

test('the fixture-clock guard actually fires, on each form it claims to catch', () => {
  const caught = [
    `VALUES ('n1', date('now'), 300000)`,
    `VALUES ('r1', date('now','+5 days'), 1)`,
    `VALUES ('t1', datetime('now'), 1)`,
    `WHERE month = strftime('%Y-%m','now')`,
    `created_at DEFAULT CURRENT_TIMESTAMP`,
  ];
  for (const line of caught) {
    assert.ok(SQLITE_CLOCK.test(line), `should be caught: ${line}`);
  }

  // Silent on the ordinary healthy line. A local-calendar bind, an ISO literal, a service that
  // takes an injected `now`, and this file's own prose about the call are all fine.
  const allowed = [
    `db.prepare(sql).run(localToday());`,
    `VALUES ('n1', ?, 300000)`,
    `const TEST_NOW = '2026-07-30T12:00:00.000Z';`,
    `getMonthlyBudgetsWithProjection(db, year, month, now)`,
    `assert.match(doc.time.warning, /date\\('now'\\) is UTC/);`,
  ];
  for (const line of allowed) {
    assert.ok(!SQLITE_CLOCK.test(line), `should be silent: ${line}`);
  }
});
