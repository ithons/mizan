import test from 'node:test';
import assert from 'node:assert/strict';
import { format, subDays } from 'date-fns';
import { readCalibration } from '../client/src/components/balance/BalanceScale';
import type {
  CategoryTrendReport,
  NetWorthAttribution,
  NetWorthSnapshot,
  ReportSummary,
  SafeToSpend,
  SpendingReport,
} from '../shared/types';
import {
  ATTRIBUTION,
  REVIEW,
  SAFE_TO_SPEND,
  SPENDING,
  SUMMARY,
  SYNC_HEALTH_OK,
  SYNC_HEALTH_PARTIAL,
  TRENDS,
  render,
} from './helpers/instrumentHarness';

/**
 * Rule 3 applied to colour: the palette must be silent on an ordinary healthy event.
 *
 * `.claude/plans/rebuild-part-3.md` Phase 13 makes this the bound on the whole graphic layer, and
 * names the fixture precisely: "On the healthy fixture (calibrated sheet, zero open review items,
 * zero faults, zero negative figures, zero refusals) a screen renders at most one chromatic
 * semantic family, and it is sage. Every `clay`, `gold`, `review-*` and `estimate` token on screen
 * must trace to a state the code checked ... Written as the healthy-case test, not the detection
 * test."
 *
 * It was never written. Four of the five Phase 5c tracks shipped something that fired on an
 * ordinary healthy event and no test failed, which is this shape exactly.
 *
 * THE FIXTURE IS ASSERTED HEALTHY BEFORE SILENCE IS ASSERTED, and by the code's own definitions
 * rather than by hand: `readCalibration` is the function the beam calls, and the `good` predicates
 * are the ones `Instrument` passes to `Delta`. Without that this test proves nothing. The first
 * draft of it reused the shipped fixture, whose sheet is dated 2026-07-30, and on 2026-09-01 the
 * screen correctly raised gold ("Recorded 33 days ago") and estimate (the beam's uncalibrated
 * fill). Those two paths are healthy-silent; the fixture was 33 days stale.
 *
 * SCOPE: this covers Instrument. The directional clay on Investments (an unrealized loss), Plan (a
 * short sheet) and Accounts (a balance owed) is conditional on a measured state and so falls under
 * the plan's own carve-out, but nothing asserts it. Five screens are unverified.
 */
const ALARM = ['clay', 'gold', 'estimate', 'review'] as const;

/** Every chromatic family the markup carries, sage included. */
function familiesIn(html: string): string[] {
  const found = new Set<string>();
  for (const family of [...ALARM, 'sage']) {
    if (new RegExp(`\\b(?:text|bg|border|fill|stroke)-${family}\\b`).test(html)) found.add(family);
    if (new RegExp(`\\b(?:text|bg|border|fill|stroke)-${family}-[\\w-]+`).test(html)) found.add(family);
  }
  return [...found].sort();
}

const day = (daysBack: number) => format(subDays(new Date(), daysBack), 'yyyy-MM-dd');

/**
 * A measured sheet dated relative to today, so the fixture does not go stale with the calendar.
 * Full coverage and `is_estimated: false`, which are two of `readCalibration`'s four conditions.
 */
function healthySheet(daysBack: number, netWorth: number): NetWorthSnapshot {
  const date = day(daysBack);
  return {
    id: `snap_${date}`,
    date,
    total_assets: netWorth + 1200,
    total_liabilities: 1200,
    net_worth: netWorth,
    liquid_assets: netWorth * 0.6,
    investment_assets: netWorth * 0.3,
    crypto_assets: netWorth * 0.1,
    is_estimated: false,
    covered_accounts: 14,
    total_accounts: 14,
    created_at: `${date}T12:00:00.000Z`,
  } as NetWorthSnapshot;
}

/** Rising, so no week-over-week reading is negative. Today's sheet last. */
const RECENT = [
  healthySheet(28, 8000),
  healthySheet(21, 8200),
  healthySheet(14, 8500),
  healthySheet(7, 8800),
  healthySheet(0, 9100),
];
const SNAPSHOT = RECENT[RECENT.length - 1];

const HEALTHY_SAFE_TO_SPEND: SafeToSpend = { ...SAFE_TO_SPEND, free: 1250.4, allocated_goals: 0 };

/**
 * The shipped spending fixture carries a NEGATIVE Shopping month (July's Amazon and REI credits
 * outweighed its purchases). That is a real state and correctly draws attention, so it is filtered
 * out here rather than defended.
 */
const HEALTHY_SPENDING: SpendingReport = {
  ...SPENDING,
  categories: SPENDING.categories.filter((c) => c.amount > 0),
};

const HEALTHY_TRENDS: CategoryTrendReport = {
  ...TRENDS,
  series: TRENDS.series.map((s) => ({ ...s, values: s.values.map(Math.abs) })),
};

const HEALTHY_ATTRIBUTION: NetWorthAttribution = {
  ...ATTRIBUTION,
  start_net_worth: 8000,
  end_net_worth: 9100,
  delta: 1100,
  accounts: ATTRIBUTION.accounts.map((a) => ({
    ...a,
    start_balance: Math.abs(a.start_balance),
    end_balance: Math.abs(a.end_balance),
    delta: Math.abs(a.delta),
  })),
};

/** Income up, spending down, net up, rate up: every delta in the direction `Instrument` grades good. */
const HEALTHY_SUMMARY: ReportSummary = {
  ...SUMMARY,
  income: { current: 2715.4, previous: 2400.0, delta: 315.4, delta_percent: 13.14 },
  expenses: { current: 1112.99, previous: 1450.0, delta: -337.01, delta_percent: -23.24 },
  net: { current: 1602.41, previous: 950.0, delta: 652.41, delta_percent: 68.67 },
  savings_rate: { current: 59.01, previous: 39.58, delta: 19.43, delta_percent: 49.09 },
};

const HEALTHY = {
  safeToSpend: HEALTHY_SAFE_TO_SPEND,
  spending: HEALTHY_SPENDING,
  snapshot: SNAPSHOT,
  recent: RECENT,
  trends: HEALTHY_TRENDS,
  attribution: HEALTHY_ATTRIBUTION,
  summary: HEALTHY_SUMMARY,
  review: REVIEW,
  syncHealth: SYNC_HEALTH_OK,
} as const;

test('the fixture this test uses is healthy, by the code’s own definitions', () => {
  // Calibration is asserted through the function the beam calls, not by restating its four
  // conditions here. A hand-written restatement is free to drift from what the beam checks.
  const calibration = readCalibration({
    sheetDate: SNAPSHOT.date,
    today: day(0),
    isEstimated: SNAPSHOT.is_estimated,
    coveredAccounts: SNAPSHOT.covered_accounts ?? null,
    totalAccounts: SNAPSHOT.total_accounts ?? null,
    syncIncomplete: SYNC_HEALTH_OK.last_run?.incomplete ?? false,
  });
  assert.deepEqual(calibration.faults, [], 'the fixture sheet is not calibrated');

  assert.equal(REVIEW.total_open, 0, 'the review queue has something in it');
  assert.deepEqual(REVIEW.ai_drafts, [], 'there is an AI draft to answer');
  assert.equal(SYNC_HEALTH_OK.status, 'healthy');

  // Zero negative figures, on every series the screen reads.
  assert.ok(HEALTHY_SAFE_TO_SPEND.free > 0, 'the sheet is short, so clay would be correct');
  assert.equal(HEALTHY_SAFE_TO_SPEND.allocated_goals, 0, 'a goal earmark is a claim on the pool');
  assert.ok(HEALTHY_SPENDING.categories.length > 0, 'an empty month is not the healthy case either');
  assert.ok(HEALTHY_SPENDING.categories.every((c) => c.amount > 0), 'a category is in net refund');
  assert.ok(HEALTHY_TRENDS.series.every((s) => s.values.every((v) => v >= 0)), 'a trend month is negative');
  assert.ok(HEALTHY_ATTRIBUTION.accounts.every((a) => a.delta >= 0), 'an account moved down');
  assert.ok(
    RECENT.every((s, i) => i === 0 || s.net_worth > RECENT[i - 1].net_worth),
    'the series falls somewhere, which is a measured negative change'
  );

  // The four summary deltas, graded by the same predicates Instrument hands to `Delta`.
  assert.ok(HEALTHY_SUMMARY.income.delta > 0, 'income fell');
  assert.ok(HEALTHY_SUMMARY.expenses.delta < 0, 'spending rose');
  assert.ok(HEALTHY_SUMMARY.net.delta > 0, 'net fell');
  // `savings_rate` is the one nullable metric: a rate of "kept out of nothing" has no value, and
  // null is a third state rather than a small number. Asserted present before it is compared.
  assert.notEqual(HEALTHY_SUMMARY.savings_rate.delta, null, 'the rate kept has no reading at all');
  assert.ok((HEALTHY_SUMMARY.savings_rate.delta ?? 0) > 0, 'the rate kept fell');
});

test('a healthy sheet renders at most one chromatic family, and it is sage', () => {
  const families = familiesIn(render('this-month', HEALTHY));
  const raised = families.filter((f) => f !== 'sage');
  assert.deepEqual(
    raised,
    [],
    `a healthy sheet raised ${raised.join(', ')}. Every chromatic token on screen must trace to a ` +
      'state the code checked, and this fixture holds no such state.'
  );
});

test('and it is not silent because it cannot speak: a short sheet raises clay', () => {
  // The other half. A test that only asserts silence also passes on a screen that renders nothing,
  // which is how a detector with a broken input reads as healthy.
  const html = render('this-month', { ...HEALTHY, safeToSpend: { ...HEALTHY_SAFE_TO_SPEND, free: -462.96 } });
  assert.ok(familiesIn(html).includes('clay'), 'a sheet that is short says nothing about it');
});

test('an uncalibrated sheet raises gold and estimate, and a calibrated one raises neither', () => {
  // Both sides name their families. `notDeepEqual` would also pass if degradation merely added
  // sage somewhere, which would say nothing about whether degradation is visible.
  //
  // Two faults are exercised, one per branch of `readCalibration`: a sheet the calendar has moved
  // past, and a run that committed some stages and not others. `syncHealthFailed` is deliberately
  // NOT used here. The calibration input is a boolean, so a health query in its error state reads
  // exactly like a run that finished; the harness carries that case for `instrumentSyncFeed`, and
  // borrowing it here would assert degradation through the one signal that does not carry it.
  const stale = familiesIn(render('this-month', { ...HEALTHY, snapshot: healthySheet(33, 9100) }));
  const partial = familiesIn(render('this-month', { ...HEALTHY, syncHealth: SYNC_HEALTH_PARTIAL }));
  const healthy = familiesIn(render('this-month', HEALTHY));

  for (const [name, families] of [['stale', stale], ['partial', partial]] as const) {
    assert.ok(families.includes('estimate'), `the beam stays calibrated on a ${name} sheet`);
    assert.ok(families.includes('gold'), `a ${name} sheet is not qualified in the degraded voice`);
  }
  assert.ok(!healthy.includes('estimate'), 'the calibrated sheet draws the uncalibrated fill anyway');
  assert.ok(!healthy.includes('gold'), 'the calibrated sheet qualifies itself anyway');
});

test('an open review queue raises its own ink, and an empty one does not', () => {
  const queued = render('this-month', {
    ...HEALTHY,
    review: { ...REVIEW, total_open: 3, queues: [{ id: 'uncategorized', label: 'Uncategorized', count: 3, severity: 'attention' }] } as never,
  });
  assert.ok(familiesIn(queued).includes('clay'), 'three rows waiting and the screen says nothing');
});
