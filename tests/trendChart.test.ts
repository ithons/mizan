import test from 'node:test';
import assert from 'node:assert/strict';
import { trendCaptions, trendGeometry, type TrendPoint } from '../client/src/components/balance/TrendChart';

/**
 * The only chart in this app, against the series it actually draws today.
 *
 * It used to lie in two independent ways. It autoscaled to its own minimum and maximum, so a $40
 * wobble and the $2,550.52 fall of 2026-07-13 to 2026-07-14 drew the identical picture and nothing
 * on screen said which was which. And its x-axis was an array index, so a 31-day step and a 1-day
 * step occupied the same width.
 *
 * STORED_NET_WORTH below is the whole of what the database holds, not a reconstruction of it:
 *
 *   SELECT date, net_worth, is_estimated, covered_accounts
 *     FROM net_worth_snapshots ORDER BY date;
 *   -- 20 rows: 5 estimated 2026-02-01..2026-06-01, every one with covered_accounts NULL,
 *   --          then 15 measured 2026-06-30..2026-07-30, 11 accounts through 2026-07-23 and
 *   --          14 from 2026-07-24.
 *
 * Reports asks for the whole series by default and Accounts asks for twelve months, so both draw
 * all twenty of these points. Nothing in this series is withheld: its widest gap is 31 days
 * against an 84-day join limit, so the break and isolated-point machinery is dormant here. The
 * fixtures that exercise it are marked as constructed, because they are.
 */

const STORED_NET_WORTH: Array<[date: string, dollars: number, estimated: boolean, coverage: number | null]> = [
  ['2026-02-01', -989.09, true, null],
  ['2026-03-01', -1061.49, true, null],
  ['2026-04-01', 4488.05, true, null],
  ['2026-05-01', 4106.57, true, null],
  ['2026-06-01', 3868.92, true, null],
  ['2026-06-30', 1068.29, false, 11],
  ['2026-07-01', 1079.39, false, 11],
  ['2026-07-03', 1523.55, false, 11],
  ['2026-07-05', 1321.33, false, 11],
  ['2026-07-09', 2466.81, false, 11],
  ['2026-07-13', 5569.12, false, 11],
  ['2026-07-14', 3018.6, false, 11],
  ['2026-07-15', 3067.96, false, 11],
  ['2026-07-16', 3599.88, false, 11],
  ['2026-07-23', 3095.94, false, 11],
  ['2026-07-24', 2749.39, false, 14],
  ['2026-07-27', 2778.47, false, 14],
  ['2026-07-28', 2782.67, false, 14],
  ['2026-07-29', 2081.45, false, 14],
  ['2026-07-30', 4202.86, false, 14],
];

function storedSeries(): TrendPoint[] {
  return STORED_NET_WORTH.map(([date, value, estimated, coverage]) => ({
    date,
    value,
    estimated,
    coverage: coverage ?? undefined,
  }));
}

const DAY_MS = 86_400_000;
const days = (from: string, to: string): number => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS;

// ─── The scale is calibrated, not relative ───────────────────────────────────

test('zero is inside the domain and printed, whatever the series does', () => {
  const geometry = trendGeometry(storedSeries(), []);

  const zero = geometry.valueTicks.find((tick) => tick.isZero);
  assert.ok(zero, 'the zero tick exists');
  assert.equal(zero.label, '$0');
  assert.ok(zero.yPct > 0 && zero.yPct < 100, `${zero.yPct}% is inside the plot`);
  // The stored domain is −$1,061.49 to $5,569.12, so a $5,000 step would print two marks and
  // calibrate nothing. The three-tick floor drops it to $2,500.
  assert.deepEqual(geometry.valueTicks.map((t) => t.label), ['$0', '$2,500', '$5,000']);
});

test('a series that never crosses zero is still drawn against zero', () => {
  // Chase Freedom Flex: a card, so every reading is negative. Zero is the top of the plot and the
  // debt hangs off it, rather than the card's own worst month becoming the floor.
  const history: TrendPoint[] = [
    { date: '2026-03-10', value: -283.81 },
    { date: '2026-04-10', value: -1853.47 },
    { date: '2026-05-10', value: -900.0 },
    { date: '2026-06-10', value: -400.0 },
  ];

  const geometry = trendGeometry(history, []);

  const zero = geometry.valueTicks.find((tick) => tick.isZero);
  assert.ok(zero);
  assert.ok(zero.yPct < 10, `zero sits at the top of the plot, at ${zero.yPct}%`);
  assert.equal(geometry.valueTicks.every((t) => t.value <= 0), true, 'no tick above a domain that has no data above zero');
});

test('a $40 wobble and the stored series own $2,550.52 fall no longer draw the same picture', () => {
  const [, peak] = STORED_NET_WORTH[10];
  const [, trough] = STORED_NET_WORTH[11];
  assert.equal(Number((peak - trough).toFixed(2)), 2550.52, '2026-07-13 to 2026-07-14 is the steepest drawn step');

  const wobble = trendGeometry(
    [
      { date: '2026-07-01', value: peak },
      { date: '2026-07-08', value: peak + 40 },
      { date: '2026-07-15', value: peak },
    ],
    []
  );
  const fall = trendGeometry(
    [
      { date: '2026-07-01', value: peak },
      { date: '2026-07-08', value: trough },
      { date: '2026-07-15', value: peak },
    ],
    []
  );

  const travel = (ys: number[]): number => Math.max(...ys) - Math.min(...ys);
  // Both used to fill the plot, because each was scaled to its own extremes.
  assert.ok(travel(wobble.ys) < 4, `the wobble moves ${travel(wobble.ys).toFixed(1)} of 124 plot units`);
  assert.ok(travel(fall.ys) > 50, `the fall moves ${travel(fall.ys).toFixed(1)} of 124 plot units`);
  assert.ok(travel(fall.ys) / travel(wobble.ys) > 20, 'the ratio is the ratio of the money');
});

// ─── x is time, not position in an array ─────────────────────────────────────

test('the x axis is proportional to time, so a 31-day step is not the same width as a 1-day step', () => {
  const geometry = trendGeometry(storedSeries(), []);
  const pct = geometry.xs.map((x) => (x / 1000) * 100);

  // The plot is inset by 1% at each end so the terminal rings clear the value labels.
  assert.equal(pct[0], 1);
  assert.equal(pct[pct.length - 1], 99);

  const monthStep = pct[4] - pct[3];
  const dayStep = pct[6] - pct[5];
  assert.equal(days('2026-05-01', '2026-06-01'), 31);
  assert.equal(days('2026-06-30', '2026-07-01'), 1);
  assert.equal(Math.round(monthStep / dayStep), 31, 'width is in the same ratio as the time');

  // On an index axis every one of the 19 steps was 1/19 of the width, or 5.26%.
  const indexStep = (1 / (geometry.xs.length - 1)) * 100;
  assert.ok(monthStep / indexStep > 3, 'the widest step draws more than three index-steps wide');
  assert.ok(dayStep / indexStep < 0.2, 'a one-day step draws under a fifth of an index-step');
});

test('every point keeps its own date, so the axis labels land on real calendar boundaries', () => {
  const geometry = trendGeometry(storedSeries(), []);

  assert.deepEqual(geometry.timeTicks.map((t) => t.label), ['Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul']);
  const spacings = geometry.timeTicks.slice(1).map((t, i) => t.xPct - geometry.timeTicks[i].xPct);
  // Months are near-equal in width because they are near-equal in days, which is the whole point.
  // The 1.64-point spread across these five is the 28-to-31-day spread of the months themselves,
  // plus the hour the March tick loses to the clock change.
  assert.ok(Math.max(...spacings) - Math.min(...spacings) < 2, 'month ticks are evenly spaced in time');
});

// ─── What the screen withholds, and what it does not ─────────────────────────

test('the stored series has no gap wide enough to withhold, so the whole line is drawn', () => {
  const geometry = trendGeometry(storedSeries(), []);

  const gaps = STORED_NET_WORTH.slice(1).map(([date], i) => days(STORED_NET_WORTH[i][0], date));
  assert.equal(Math.max(...gaps), 31, 'the widest gap in the database is 31 days');

  assert.equal(geometry.joinLimitDays, 84);
  assert.equal(geometry.maxDrawnGapDays, 31);
  assert.deepEqual(geometry.breaks, []);
  assert.deepEqual(geometry.isolated, []);
  assert.deepEqual(geometry.terminals, []);
  assert.equal(geometry.fills.length, 1, 'one unbroken run, so one fill');
  assert.equal(
    trendCaptions(geometry).filter((c) => c.startsWith('Nothing is drawn')).length,
    0,
    'the copy claims no withheld stretch, because there is none'
  );
});

test('a reach the ledger cannot justify is not drawn across, and its far point is not deleted', () => {
  // CONSTRUCTED, not stored. scripts/backfill/rebuild.ts is the only caller of backfillSnapshots
  // outside tests, and running it extends history back past the app's own cadence. This is that
  // shape: one much older reading in front of the twenty rows the database actually holds.
  const extended: TrendPoint[] = [{ date: '2024-07-01', value: 591.0, estimated: true, coverage: 6 }, ...storedSeries()];

  const geometry = trendGeometry(extended, []);

  assert.equal(geometry.joinLimitDays, 84);
  assert.equal(days('2024-07-01', '2026-02-01'), 580);
  assert.deepEqual(geometry.breaks, [{ fromDate: '2024-07-01', toDate: '2026-02-01', days: 580 }]);
  assert.equal(Math.min(...geometry.segments.map((s) => s.from)), 1, 'no drawn segment reaches across it');
  assert.equal(geometry.maxDrawnGapDays, 31);

  // Breaking the trace must not delete the far point: that would trade one false claim for another.
  assert.deepEqual(geometry.isolated.map((p) => p.date), ['2024-07-01']);
  assert.equal(geometry.isolated[0].estimated, true);
  assert.equal(geometry.isolated[0].xPct, 1, 'it sits at the inset left edge, not off it');
  // Both ends of the undrawn stretch are ringed, so the line visibly stops rather than starting late.
  assert.deepEqual(geometry.terminals, [0, 1]);

  // The 6-to-11 coverage step falls inside the undrawn stretch, so nothing claims it as a drawn one.
  assert.equal(geometry.coverageSpans.some((span) => span.counts.includes(6)), false);
});

test('a monthly series with no outlier gap is not broken anywhere', () => {
  // The healthy case. A rule that fires here would shatter the ordinary series, which is what a
  // median-based limit does on a series that is monthly at one end and daily at the other.
  const monthly: TrendPoint[] = [
    '2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01', '2026-05-01',
    '2026-06-01', '2026-07-01', '2026-08-01', '2026-09-01', '2026-10-01',
  ].map((date, i) => ({ date, value: 1000 + i * 25, estimated: true }));

  const geometry = trendGeometry(monthly, []);

  assert.deepEqual(geometry.breaks, []);
  assert.deepEqual(geometry.isolated, []);
  assert.deepEqual(geometry.terminals, []);
  assert.deepEqual(trendCaptions(geometry).filter((c) => c.startsWith('Nothing is drawn')), []);
});

test('a daily ledger series is not broken by its own one-day cadence', () => {
  const daily: TrendPoint[] = [];
  for (let day = 1; day <= 29; day++) daily.push({ date: `2026-06-${String(day).padStart(2, '0')}`, value: day * 10 });

  const geometry = trendGeometry(daily, []);

  assert.equal(geometry.joinLimitDays, 3);
  assert.deepEqual(geometry.breaks, []);
  assert.deepEqual(geometry.segments.map((s) => s.kind), ['measured']);
});

test('a series with too few gaps to have a cadence withholds nothing', () => {
  const geometry = trendGeometry(
    [
      { date: '2024-01-01', value: 100 },
      { date: '2026-01-01', value: 200 },
    ],
    []
  );

  assert.equal(geometry.joinLimitDays, null);
  assert.deepEqual(geometry.breaks, []);
  assert.equal(geometry.segments.length, 1);
});

// ─── Coverage: the two ends are not always the same quantity ─────────────────

test('the stored series is drawn as five stretches, two of them not comparable end to end', () => {
  const geometry = trendGeometry(storedSeries(), []);

  assert.deepEqual(geometry.segments.map((s) => [s.kind, s.from, s.to]), [
    ['estimated', 0, 4],
    ['coverage', 4, 5],
    ['measured', 5, 14],
    ['coverage', 14, 15],
    ['measured', 15, 19],
  ]);
  assert.deepEqual(geometry.coverageSpans, [
    { from: 4, to: 5, counts: [11], incomplete: true },
    { from: 14, to: 15, counts: [11, 14], incomplete: false },
  ]);
});

test('an account count on one end only is a reason to withhold the join, not to assume agreement', () => {
  // Migration 044 populated covered_accounts only WHERE is_estimated = 0, so the 2026-06-01
  // estimate carries NULL and meets the 2026-06-30 measurement's 11 with nothing to compare. The
  // net worth falls $2,800.63 across that step, and the chart may not imply the two totals are
  // sums over the same accounts.
  const [, before] = STORED_NET_WORTH[4];
  const [, after] = STORED_NET_WORTH[5];
  assert.equal(Number((before - after).toFixed(2)), 2800.63);

  const geometry = trendGeometry(
    [
      { date: '2026-06-01', value: before, estimated: true },
      { date: '2026-06-30', value: after, estimated: false, coverage: 11 },
    ],
    []
  );

  assert.deepEqual(geometry.segments.map((s) => s.kind), ['coverage']);
  assert.deepEqual(geometry.coverageSpans, [{ from: 0, to: 1, counts: [11], incomplete: true }]);
});

test('coverage outranks provenance, because it is the stronger disagreement', () => {
  // Both ends reconstructed and the counts differ: the stretch reads as a change of quantity, which
  // is the claim that matters, rather than as an ordinary reconstruction.
  const geometry = trendGeometry(
    [
      { date: '2026-01-01', value: 10, estimated: true, coverage: 8 },
      { date: '2026-02-01', value: 20, estimated: true, coverage: 10 },
    ],
    []
  );

  assert.deepEqual(geometry.segments.map((s) => s.kind), ['coverage']);
});

test('a series that declares no coverage makes no coverage claim', () => {
  // The investments chart is served date, value and estimated only. Silence there is correct.
  const geometry = trendGeometry(
    [
      { date: '2026-01-01', value: 10, estimated: true },
      { date: '2026-02-01', value: 20, estimated: false },
    ],
    []
  );

  assert.deepEqual(geometry.coverageSpans, []);
  assert.deepEqual(trendCaptions(geometry), []);
});

// ─── The copy counts what the reader can count ───────────────────────────────

/** Every integer the coverage sentences state, so they can be checked against the polylines. */
function statedCoverageCounts(captions: string[]): number[] {
  return captions
    .filter((line) => line.includes('set apart'))
    .map((line) => Number(/^(\d+) stretch(?:es)? (?:is|are) set apart/.exec(line)?.[1]));
}

test('the number of stretches the copy claims is the number of stretches drawn', () => {
  for (const [name, history] of [
    ['stored', storedSeries()],
    [
      // Four consecutive steps that each change the count merge into ONE polyline. The old copy
      // counted point-to-point transitions and printed 4 where the reader could point at 1.
      'merged run',
      [8, 9, 10, 11, 12].map((coverage, i) => ({
        date: `2026-07-0${i + 1}`,
        value: 1000 + i * 10,
        estimated: false,
        coverage,
      })),
    ],
  ] as Array<[string, TrendPoint[]]>) {
    const geometry = trendGeometry(history, []);
    const drawn = geometry.segments.filter((s) => s.kind === 'coverage').length;
    const stated = statedCoverageCounts(trendCaptions(geometry));

    assert.ok(stated.length > 0, `${name}: the copy says something about coverage`);
    assert.equal(
      stated.reduce((total, n) => total + n, 0),
      drawn,
      `${name}: the copy claims ${stated.join('+')} stretches against ${drawn} drawn`
    );
    assert.equal(geometry.coverageSpans.length, drawn, `${name}: one span per drawn polyline`);
  }
});

test('the captions cite figures the geometry measured, and say nothing otherwise', () => {
  const captions = trendCaptions(trendGeometry(storedSeries(), []));

  assert.deepEqual(captions, [
    '1 stretch is set apart because the number of accounts counted changes across it, between 11 and 14. ' +
      'The two ends of such a stretch are not the same quantity.',
    '1 stretch is set apart because only one end records how many accounts were counted, so whether that ' +
      'number changed across it is not known.',
    'Points sit as close as 0.5% of the width apart here, so the arrow keys step through them one at a time.',
  ]);

  // 11, 14 and 0.5% are all in the series; none is a threshold dressed up as an observation.
  const counts = new Set(STORED_NET_WORTH.map(([, , , coverage]) => coverage).filter((c) => c !== null));
  assert.deepEqual([...counts].sort((a, b) => a - b), [11, 14]);
  const span = days('2026-02-01', '2026-07-30');
  assert.equal(Number(((1 / span) * 98).toFixed(1)), 0.5, 'one day is 0.5% of a 98%-wide plot spanning 179 days');
});

test('a clean measured series gets no captions at all', () => {
  const clean: TrendPoint[] = ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04', '2026-07-05'].map(
    (date, i) => ({ date, value: 1000 + i, estimated: false, coverage: 14 })
  );

  assert.deepEqual(trendCaptions(trendGeometry(clean, [])), []);
});

test('the crowding line appears only where the mouse cannot separate two points', () => {
  const crowded = (history: TrendPoint[]): boolean =>
    trendCaptions(trendGeometry(history, [])).some((line) => line.startsWith('Points sit as close as'));

  // Fifteen of the stored twenty points land in the final 16.4% of the width, as close as 0.5%
  // apart, which is about 4px on the 798px plot Reports gives the chart.
  assert.equal(crowded(storedSeries()), true);
  const pct = trendGeometry(storedSeries(), []).xs.map((x) => (x / 1000) * 100);
  assert.equal(pct.filter((p) => p >= 82.5).length, 15);
  assert.equal(Number((99 - pct[5]).toFixed(1)), 16.4);

  // Five evenly spaced points are 24.5% apart and need no such instruction.
  assert.equal(
    crowded(['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04', '2026-07-05'].map((date, i) => ({ date, value: i }))),
    false
  );
});

// ─── The fill is signed, because the sign is the reading ─────────────────────

test('the fill closes on the zero rule rather than on the bottom of the frame', () => {
  const geometry = trendGeometry(storedSeries(), []);

  const zeroY = (geometry.zeroYPct / 100) * 140;
  assert.equal(geometry.fills.length, 1);
  const vertices = geometry.fills[0].split(' ');
  const closing = vertices.slice(-2).map((v) => Number(v.split(',')[1]));
  assert.deepEqual(closing.map((y) => y.toFixed(1)), [zeroY.toFixed(1), zeroY.toFixed(1)]);
  assert.ok(zeroY < 140 - 8, 'zero is not the bottom of the frame for a series that goes negative');
});

test('an all-positive series still closes its fill on zero, near the frame', () => {
  const geometry = trendGeometry(
    [
      { date: '2026-07-01', value: 100 },
      { date: '2026-07-02', value: 300 },
    ],
    []
  );

  assert.equal(geometry.zeroYPct.toFixed(2), '94.29');
});

// ─── Marks keep working on the new scale ─────────────────────────────────────

test('a recorded balance is placed on the same calibrated scale as the line', () => {
  const history: TrendPoint[] = [
    { date: '2026-06-30', value: -2182.15 },
    { date: '2026-07-13', value: -1000.0 },
    { date: '2026-07-29', value: -563.26 },
  ];

  // Discover's shape: the recorded balance on 2026-06-30 sits $1,126.52 above the reconstruction.
  const geometry = trendGeometry(history, [{ date: '2026-06-30', value: -1055.63 }]);

  const mark = geometry.marks[0];
  assert.equal(mark.xPct, geometry.xs[0] / 10, 'the mark sits on its own date');
  assert.ok(mark.yPct < (geometry.ys[0] / 140) * 100, 'a balance above the line is drawn above the line');
  assert.ok(mark.yPct > 0 && mark.yPct < 100, `${mark.yPct} is inside the plot`);
});

test('a mark beyond the line widens the domain instead of being clipped', () => {
  const history: TrendPoint[] = [
    { date: '2026-07-01', value: 500 },
    { date: '2026-07-02', value: 520 },
  ];

  const withMark = trendGeometry(history, [{ date: '2026-07-02', value: -520 }]);

  assert.ok(withMark.marks[0].yPct < 100, 'the mark is inside the plot');
  assert.ok(withMark.zeroYPct > 0 && withMark.zeroYPct < 100, 'zero stays inside a domain that now straddles it');
});

// ─── The input contract fails loudly ─────────────────────────────────────────

test('an out-of-order series raises instead of collapsing every point onto one x', () => {
  const shuffled = [storedSeries()[5], storedSeries()[0], ...storedSeries().slice(1, 5)];

  assert.throws(
    () => trendGeometry(shuffled, []),
    (err: unknown) =>
      err instanceof RangeError && /dates must strictly increase.*2026-02-01.*index 1.*2026-06-30/.test(err.message)
  );
});

test('a repeated date raises rather than minting a duplicate key', () => {
  assert.throws(
    () =>
      trendGeometry(
        [
          { date: '2026-07-01', value: 10 },
          { date: '2026-07-01', value: 20 },
          { date: '2026-07-02', value: 30 },
        ],
        []
      ),
    (err: unknown) => err instanceof RangeError && /strictly increase/.test(err.message)
  );
});

test('an unparseable date raises rather than returning a plausible empty chart', () => {
  assert.throws(
    () =>
      trendGeometry(
        [
          { date: '2026-07-01', value: 10 },
          { date: 'not a date', value: 20 },
        ],
        []
      ),
    (err: unknown) => err instanceof RangeError && /unparseable date "not a date" at index 1/.test(err.message)
  );
});

test('a series too short to draw is still not an error', () => {
  assert.deepEqual(trendGeometry([{ date: 'not a date', value: 10 }], []).segments, []);
});
