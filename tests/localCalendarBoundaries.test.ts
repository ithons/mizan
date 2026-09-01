import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { format, subMonths } from 'date-fns';

const ROOT = join(__dirname, '..');

/**
 * A cutoff compared against a stored date has to be built in the same calendar the date was.
 *
 * Every 'yyyy-MM-dd' in this database is LOCAL: `snapshot.ts` writes
 * `format(new Date(), 'yyyy-MM-dd')`, and `services/dates.ts` says so at the top of the file.
 * Two places built the other side of the comparison in UTC.
 */
function code(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

test('the arithmetic that was wrong: setMonth overflows, subMonths clamps', () => {
  // Not a test of our code, a test of the PREMISE, so a reader can see the defect without a
  // timezone to reproduce. `setMonth` on 31 August minus six months asks for 31 February.
  const augustEnd = new Date(2026, 7, 31, 12, 0, 0);

  const naive = new Date(augustEnd);
  naive.setMonth(naive.getMonth() - 6);
  assert.equal(format(naive, 'yyyy-MM-dd'), '2026-03-03', 'setMonth no longer overflows');

  assert.equal(format(subMonths(augustEnd, 6), 'yyyy-MM-dd'), '2026-02-28');

  // And the one-month case, which lost the entire window.
  const julyEnd = new Date(2026, 6, 31, 12, 0, 0);
  const naive1 = new Date(julyEnd);
  naive1.setMonth(naive1.getMonth() - 1);
  assert.equal(format(naive1, 'yyyy-MM-dd'), '2026-07-01', 'a one-month window covered no months');
  assert.equal(format(subMonths(julyEnd, 1), 'yyyy-MM-dd'), '2026-06-30');
});

test('a UTC instant and a local instant are different days in the evening', () => {
  // The other half. In America/New_York (UTC-4) an 8pm local timestamp is already tomorrow in UTC,
  // so `toISOString().split('T')[0]` names a day the local calendar has not reached.
  // 00:30 UTC on 1 September is 20:30 local on 31 August at UTC-4: UTC has rolled over and the
  // local calendar has not. This is the shape `new Date().toISOString()` produces every evening.
  const evening = new Date('2026-09-01T00:30:00.000Z');
  const utcDay = evening.toISOString().slice(0, 10);
  const localDay = format(evening, 'yyyy-MM-dd');

  if (evening.getTimezoneOffset() >= 30) {
    assert.equal(utcDay, '2026-09-01');
    assert.notEqual(localDay, utcDay, 'the two calendars did not diverge on a case built to diverge');
  } else {
    // Stated rather than skipped silently: east of UTC this instant does not straddle midnight,
    // and asserting divergence would fail for a reason that has nothing to do with the code.
    console.log(
      `[localCalendar] machine offset ${evening.getTimezoneOffset()}min; the divergence case did not run`
    );
  }
});

test('the net worth history cutoff is built in the local calendar', () => {
  const src = code('server/src/routes/networth.ts');
  assert.doesNotMatch(src, /cutoff\.setMonth/, 'the cutoff still overflows at month end');
  assert.doesNotMatch(
    src,
    /cutoff\.toISOString\(\)\.split/,
    'the cutoff is still built in UTC against a local stored date'
  );
  assert.match(src, /format\(subMonths\(new Date\(\), months\), 'yyyy-MM-dd'\)/);
});

test("a budget's first month is read in the same calendar as the month it is compared to", () => {
  const src = code('server/src/services/budgetProjection.ts');
  assert.doesNotMatch(
    src,
    /budget\.created_at\.slice\(0, 7\)/,
    'a UTC timestamp is still sliced and compared to a local month'
  );
  assert.match(src, /format\(parseISO\(budget\.created_at\), 'yyyy-MM'\)/);
});
