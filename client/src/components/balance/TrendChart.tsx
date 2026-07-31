import { useCallback, useId, useMemo, useRef, useState } from 'react';
import {
  eachDayOfInterval,
  eachMonthOfInterval,
  eachQuarterOfInterval,
  eachWeekOfInterval,
  eachYearOfInterval,
  format,
  parseISO,
} from 'date-fns';
import { formatWholeCurrency } from '../../lib/formatters';

const VIEW_W = 1000;
const VIEW_H = 140;
/** Breathing room inside the viewBox so a point at the domain edge is not welded to the frame. */
const PAD_Y = 8;
/** The first and last points carry an 8px ring; without this it overlaps the value labels. */
const PAD_X = 10;
/** The value ticks are money numerals and are never abbreviated, so they need real width. */
const GUTTER_PX = 62;
const AXIS_PX = 18;
const MS_PER_DAY = 86_400_000;

export interface TrendPoint {
  date: string;
  value: number;
  /**
   * True when the point is reconstructed rather than observed. Net-worth history before the
   * first real sync is estimated by undoing transactions off today's balances, which cannot
   * see what it has no record of: a credit card's payments, or any month the ledger does not
   * reach. In the stored series the last estimated month reads $3,868.92 against $1,068.29
   * measured 29 days later. Drawing that as the same solid line as a measured balance is the
   * chart asserting something it does not know.
   *
   *   SELECT date, net_worth/100.0, is_estimated FROM net_worth_snapshots ORDER BY date;
   *   -- 2026-06-01 3868.92 1 | 2026-06-30 1068.29 0
   */
  estimated?: boolean;
  /**
   * How many accounts this point counts, when the caller knows. Where it changes, consecutive
   * points are sums over different sets of accounts, so the segment between them is a change of
   * quantity as much as a change of money: the stored series steps 11 accounts to 14 across
   * 2026-07-23 to 2026-07-24. Omit it rather than guess.
   *
   * Omission is itself a state the chart has to handle rather than read as agreement. Migration
   * 044 recorded a count only on measured rows, so every estimated row in this database carries
   * NULL, and the 2026-06-01 estimate meets the 2026-06-30 measurement with a count on one end
   * only:
   *
   *   SELECT COUNT(*) FROM net_worth_snapshots WHERE is_estimated = 1 AND covered_accounts IS NULL;
   *   -- 5, which is every estimated row there is
   *
   * A segment with a count on neither end makes no coverage claim and is left alone; a segment
   * with a count on exactly one end knows only that it cannot compare them.
   */
  coverage?: number;
}

/**
 * A value observed on one of the series' own dates, drawn as a dot ON the line.
 *
 * An account's balance chart is reconstructed from its ledger, while net worth is read from
 * recorded balance sheets, and the two can legitimately land apart. Marking the recorded value
 * where it sits lets the reader see that rather than be told a number about it: earlier versions
 * of this screen computed the difference and printed it, which fired on ordinary days whose
 * inflow and outflow the snapshot was simply taken between.
 */
export interface TrendMark {
  date: string;
  value: number;
}

interface TrendChartProps {
  history: TrendPoint[];
  /** Observed values to dot on the line. A mark whose date is not in `history` is not drawn. */
  marks?: TrendMark[];
  height?: number;
  className?: string;
  /** Names the quantity in the accessible summary and in the coverage copy. */
  label?: string;
}

interface MarkPosition extends TrendMark {
  xPct: number;
  yPct: number;
}

/**
 * What a segment between two consecutive points is allowed to claim.
 *
 * `measured` joins two observations. `estimated` has at least one reconstructed end. `coverage`
 * is the case where the two ends are not known to be the same quantity at all, either because
 * the account counts differ or because only one end records a count, so it outranks the other
 * two. An unrecorded count is a reason to withhold the join, never a reason to assume it.
 */
export type TrendSegmentKind = 'measured' | 'estimated' | 'coverage';

export interface TrendSegment {
  kind: TrendSegmentKind;
  /** Inclusive index range in `history` that this run spans. */
  from: number;
  to: number;
  points: string;
}

/** One drawn stretch whose ends are not known to count the same accounts. */
export interface TrendCoverageSpan {
  /** Inclusive index range in `history`, matching the coverage segment actually rendered. */
  from: number;
  to: number;
  /** The counts this stretch walks through, in order, skipping points that record none. */
  counts: number[];
  /** True when a point inside the stretch records no count, so the change cannot be named. */
  incomplete: boolean;
}

/** A point with no drawn segment on either side, which a polyline cannot render at all. */
export interface TrendIsolate {
  date: string;
  index: number;
  xPct: number;
  yPct: number;
  estimated: boolean;
}

/** A stretch the trace does not cross, because nothing recorded says what happened inside it. */
export interface TrendBreak {
  fromDate: string;
  toDate: string;
  days: number;
}

export interface TrendValueTick {
  value: number;
  yPct: number;
  label: string;
  isZero: boolean;
}

export interface TrendTimeTick {
  xPct: number;
  label: string;
}

export interface TrendGeometry {
  segments: TrendSegment[];
  isolated: TrendIsolate[];
  /** Indices whose neighbour on at least one side is not joined to them. */
  terminals: number[];
  /** One polygon per drawn run, closed on the zero rule rather than on the frame. */
  fills: string[];
  /** Point positions in viewBox units. `xs` is time-proportional, never an array index. */
  xs: number[];
  ys: number[];
  zeroYPct: number;
  valueTicks: TrendValueTick[];
  timeTicks: TrendTimeTick[];
  breaks: TrendBreak[];
  /**
   * One entry per coverage stretch actually rendered, in render order. This is the array the
   * copy counts, so a sentence about "N stretches" cannot drift from the N polylines on screen.
   * The previous version counted point-to-point transitions instead, which the merge loop below
   * then collapses into one polyline per consecutive run, so the copy overcounted every run
   * longer than a single step and told the reader to look for stretches that were not there.
   * A coverage change falling inside an undrawn stretch is absent here for the same reason,
   * because no rendered segment carries it.
   */
  coverageSpans: TrendCoverageSpan[];
  marks: MarkPosition[];
  /**
   * The widest gap, in days, a segment may span and still be drawn. Null when the series holds
   * too few gaps to have a cadence at all, in which case nothing is withheld.
   */
  joinLimitDays: number | null;
  /** The widest gap the trace does cross, in days. Null when nothing is drawn. */
  maxDrawnGapDays: number | null;
}

const EMPTY_GEOMETRY: TrendGeometry = {
  segments: [],
  isolated: [],
  terminals: [],
  fills: [],
  xs: [],
  ys: [],
  zeroYPct: 100,
  valueTicks: [],
  timeTicks: [],
  breaks: [],
  coverageSpans: [],
  marks: [],
  joinLimitDays: null,
  maxDrawnGapDays: null,
};

const TICK_FACTORS = [1, 2, 2.5, 5, 10];

/**
 * The coarsest round step that still lands at least three ticks inside the domain.
 *
 * Picking a step from `span / 4` alone is not enough here, because a domain straddling zero
 * spends part of its span on each side and a step that divides the span four ways can land twice.
 * The stored net-worth domain runs −$1,061.49 to $5,569.12 (`SELECT MIN(net_worth), MAX(net_worth)
 * FROM net_worth_snapshots`, in cents), where a $5,000 step prints $0 and $5,000 and nothing else,
 * so the scale would be calibrated by two marks. Requiring three drops it to $2,500.
 */
function tickStep(lo: number, hi: number): number {
  const span = hi - lo;
  if (!(span > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(span));
  const candidates: number[] = [];
  for (const scale of [magnitude, magnitude / 10, magnitude / 100]) {
    for (const factor of TICK_FACTORS) candidates.push(factor * scale);
  }
  candidates.sort((a, b) => b - a);
  const count = (step: number): number => Math.floor(hi / step) - Math.ceil(lo / step) + 1;
  return candidates.find((step) => count(step) >= 3) ?? candidates[0];
}

/**
 * The gap beyond which a segment stops being interpolation and becomes invention.
 *
 * Three times the series' own 75th-percentile spacing. The percentile rather than the median
 * because these series are routinely bimodal: the stored net-worth series is five monthly
 * estimates followed by fifteen sync-cadence readings, so its gaps run 28 to 31 days at one end
 * and 1 to 7 days at the other, and its median gap is 2 days. A median-based limit would shatter
 * the monthly half into isolated points. The upper quartile lands in the coarse cadence, which is
 * the spacing the series actually has to justify.
 *
 * On the stored series that gives 84 days against a widest gap of 31, so nothing is withheld and
 * the whole line is drawn. The rule bites only once history reaches back past the app's own
 * cadence, which is what scripts/backfill/rebuild.ts extends it to.
 *
 * Under four gaps there is no cadence to measure, so nothing is withheld.
 */
function joinLimit(gaps: number[]): number | null {
  if (gaps.length < 4) return null;
  const sorted = [...gaps].sort((a, b) => a - b);
  const rank = Math.max(0, Math.ceil(0.75 * sorted.length) - 1);
  return sorted[rank] * 3;
}

type TimeUnit = 'day' | 'week' | 'month' | 'quarter' | 'year';

const UNIT_TICKS: Record<TimeUnit, (interval: { start: Date; end: Date }) => Date[]> = {
  day: eachDayOfInterval,
  week: (interval) => eachWeekOfInterval(interval, { weekStartsOn: 1 }),
  month: eachMonthOfInterval,
  quarter: eachQuarterOfInterval,
  year: eachYearOfInterval,
};

/** The year rides only on January, so nine quarterly labels still fit on one line. */
const UNIT_LABEL: Record<TimeUnit, (d: Date) => string> = {
  day: (d) => format(d, 'MMM d'),
  week: (d) => format(d, 'MMM d'),
  month: (d) => format(d, d.getMonth() === 0 ? 'MMM yyyy' : 'MMM'),
  quarter: (d) => format(d, d.getMonth() === 0 ? 'MMM yyyy' : 'MMM'),
  year: (d) => format(d, 'yyyy'),
};

const MAX_TIME_TICKS = 9;

/** The finest calendar unit whose boundaries fit on the axis. */
function timeTicks(first: Date, last: Date, x: (t: number) => number): TrendTimeTick[] {
  for (const unit of ['day', 'week', 'month', 'quarter', 'year'] as TimeUnit[]) {
    const inside = UNIT_TICKS[unit]({ start: first, end: last }).filter(
      (d) => d.getTime() >= first.getTime() && d.getTime() <= last.getTime()
    );
    if (inside.length >= 2 && inside.length <= MAX_TIME_TICKS) {
      return inside.map((d) => ({ xPct: (x(d.getTime()) / VIEW_W) * 100, label: UNIT_LABEL[unit](d) }));
    }
  }
  return [first, last].map((d) => ({ xPct: (x(d.getTime()) / VIEW_W) * 100, label: format(d, 'MMM d, yyyy') }));
}

/**
 * Map a value series into a calibrated, time-proportional plot. Exported for tests.
 *
 * Two things this deliberately does not do. It does not scale to the series' own extremes, so a
 * $40 wobble and the stored series' $2,550.52 fall of 2026-07-13 to 2026-07-14 no longer draw the
 * same picture: zero is always inside the domain and always printed, and every reading is a
 * distance from it. And it does not space points by array index, so the 31 days between the
 * stored series' widest drawn step occupy 31 times the width of its 1-day steps rather than the
 * same width.
 *
 * It also makes no assumption about where reconstructed points sit. An earlier version split the
 * series at a single estimated/measured boundary; `backfillSnapshots` writes an estimated row for
 * any past month with no measured snapshot, so a fortnight with the app switched off puts an
 * estimate after a measurement and the series splits twice. Every segment is classified by its
 * own two ends instead.
 *
 * @throws RangeError when `history` is not strictly increasing in parseable dates. Every caller
 * feeds it a `ORDER BY date ASC` result over a UNIQUE date column, and the alternative to raising
 * is a geometry that looks plausible and is not: an unsorted series collapses `timeSpan` to zero
 * or negative and stacks every point on one x, and a repeated date mints duplicate React keys.
 */
export function trendGeometry(history: TrendPoint[], marks: TrendMark[]): TrendGeometry {
  if (history.length < 2) return EMPTY_GEOMETRY;

  const times = history.map((p) => parseISO(p.date).getTime());
  for (let i = 0; i < times.length; i++) {
    if (Number.isNaN(times[i])) throw new RangeError(`trendGeometry: unparseable date "${history[i].date}" at index ${i}`);
    if (i > 0 && times[i] <= times[i - 1]) {
      throw new RangeError(
        `trendGeometry: dates must strictly increase, but "${history[i].date}" at index ${i} does not follow "${history[i - 1].date}"`
      );
    }
  }
  const first = times[0];
  const last = times[times.length - 1];
  const timeSpan = last - first;
  const plotW = VIEW_W - PAD_X * 2;
  // timeSpan is positive by the contract checked above, so there is no degenerate branch here.
  const x = (t: number): number => PAD_X + ((t - first) / timeSpan) * plotW;
  const xs = times.map(x);

  // Marks share the line's scale and widen it, so one sitting well off the line is drawn where it
  // actually is instead of being clipped to the edge of the plot. Zero is in the domain whatever
  // the data does, because that is what makes the scale calibrated rather than relative.
  const values = [...history.map((p) => p.value), ...marks.map((m) => m.value), 0];
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (lo === hi) {
    lo -= 1;
    hi += 1;
  }
  const y = (v: number): number => VIEW_H - PAD_Y - ((v - lo) / (hi - lo)) * (VIEW_H - PAD_Y * 2);
  const ys = history.map((p) => y(p.value));
  const zeroY = y(0);

  const step = tickStep(lo, hi);
  const valueTicks: TrendValueTick[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step / 1000; v += step) {
    // Guard the float dust that `+= step` accumulates, so a tick reads $0 rather than −$0.
    const value = Math.abs(v) < step / 1000 ? 0 : v;
    valueTicks.push({
      value,
      yPct: (y(value) / VIEW_H) * 100,
      label: formatWholeCurrency(value),
      isZero: value === 0,
    });
  }

  const gaps: number[] = [];
  for (let i = 1; i < times.length; i++) gaps.push((times[i] - times[i - 1]) / MS_PER_DAY);
  const limit = joinLimit(gaps);

  const coord = (i: number): string => `${xs[i].toFixed(1)},${ys[i].toFixed(1)}`;

  const kinds: Array<TrendSegmentKind | null> = [];
  const breaks: TrendBreak[] = [];
  const drawnGaps: number[] = [];
  for (let i = 0; i < history.length - 1; i++) {
    const gap = gaps[i];
    if (limit !== null && gap > limit) {
      kinds.push(null);
      breaks.push({ fromDate: history[i].date, toDate: history[i + 1].date, days: Math.round(gap) });
      continue;
    }
    drawnGaps.push(gap);
    const a = history[i];
    const b = history[i + 1];
    // Silence on both ends is silence; silence on one end is not agreement with the other.
    const bothSilent = a.coverage === undefined && b.coverage === undefined;
    const comparable = bothSilent || a.coverage === b.coverage;
    if (!comparable) {
      kinds.push('coverage');
    } else if (a.estimated || b.estimated) {
      kinds.push('estimated');
    } else {
      kinds.push('measured');
    }
  }

  // A drawn run is a maximal stretch of points with no break inside it. Fills close on zero once
  // per run; strokes then split that run again wherever the segment kind changes.
  const drawnRuns: Array<[number, number]> = [];
  let openRun: number | null = null;
  for (let i = 0; i < kinds.length; i++) {
    if (kinds[i] === null) {
      if (openRun !== null) drawnRuns.push([openRun, i]);
      openRun = null;
      continue;
    }
    if (openRun === null) openRun = i;
  }
  if (openRun !== null) drawnRuns.push([openRun, kinds.length]);

  const segments: TrendSegment[] = [];
  const fills: string[] = [];
  for (const [runFrom, runTo] of drawnRuns) {
    const run: string[] = [];
    for (let i = runFrom; i <= runTo; i++) run.push(coord(i));
    fills.push(
      `${run.join(' ')} ${xs[runTo].toFixed(1)},${zeroY.toFixed(1)} ${xs[runFrom].toFixed(1)},${zeroY.toFixed(1)}`
    );

    let from = runFrom;
    while (from < runTo) {
      let to = from;
      while (to + 1 < runTo && kinds[to + 1] === kinds[from]) to++;
      const points: string[] = [];
      for (let i = from; i <= to + 1; i++) points.push(coord(i));
      segments.push({ kind: kinds[from] as TrendSegmentKind, from, to: to + 1, points: points.join(' ') });
      from = to + 1;
    }
  }

  // A point the trace never reaches has to be drawn on its own or it silently disappears, which
  // would trade one false claim for another: a reading isolated by a long gap is still a reading
  // the ledger justified. The stored series has none today (widest gap 31 days against an 84-day
  // limit), and gets one as soon as history reaches back past the app's own daily cadence.
  const isolated: TrendIsolate[] = [];
  const terminals: number[] = [];
  for (let i = 0; i < history.length; i++) {
    const before = i > 0 ? kinds[i - 1] : null;
    const after = i < kinds.length ? kinds[i] : null;
    const joinedBefore = i > 0 && before !== null;
    const joinedAfter = i < kinds.length && after !== null;
    if (!joinedBefore && !joinedAfter) {
      isolated.push({
        date: history[i].date,
        index: i,
        xPct: (xs[i] / VIEW_W) * 100,
        yPct: (ys[i] / VIEW_H) * 100,
        estimated: Boolean(history[i].estimated),
      });
      terminals.push(i);
    } else if (!joinedBefore || !joinedAfter) {
      const atEdge = (i === 0 && joinedAfter) || (i === history.length - 1 && joinedBefore);
      if (!atEdge) terminals.push(i);
    }
  }

  const indexOfDate = new Map(history.map((p, i) => [p.date, i]));
  const placed: MarkPosition[] = [];
  for (const mark of marks) {
    const i = indexOfDate.get(mark.date);
    if (i === undefined) continue;
    placed.push({ ...mark, xPct: (xs[i] / VIEW_W) * 100, yPct: (y(mark.value) / VIEW_H) * 100 });
  }

  const coverageSpans: TrendCoverageSpan[] = segments
    .filter((segment) => segment.kind === 'coverage')
    .map((segment) => {
      const counts: number[] = [];
      let incomplete = false;
      for (let i = segment.from; i <= segment.to; i++) {
        const count = history[i].coverage;
        if (count === undefined) incomplete = true;
        else if (counts[counts.length - 1] !== count) counts.push(count);
      }
      return { from: segment.from, to: segment.to, counts, incomplete };
    });

  return {
    segments,
    isolated,
    terminals,
    fills,
    xs,
    ys,
    zeroYPct: (zeroY / VIEW_H) * 100,
    valueTicks,
    timeTicks: timeTicks(new Date(first), new Date(last), x),
    breaks,
    coverageSpans,
    marks: placed,
    joinLimitDays: limit,
    maxDrawnGapDays: drawnGaps.length > 0 ? Math.round(Math.max(...drawnGaps)) : null,
  };
}

const NO_MARKS: TrendMark[] = [];

/**
 * Three strokes that have to be told apart at the size they are actually drawn.
 *
 * The viewBox is 1000 units wide and stretches onto the container, measured at 750px of plot in
 * the 860px column Reports gives it, so a dash is drawn at about 0.75 of its written length.
 * coverage and estimated used to share `--mz-estimate` and differ by dash pitch alone: the old
 * 1.5-unit coverage dash lands at 1.1px, one anti-aliased dot, so the two read as the same grey
 * dashed line and a coverage break looked like a quieter reconstruction. It is not quieter, it is
 * a different claim, so it now differs in hue, weight and rhythm at once.
 *
 * `gold` rather than `clay`, because clay is the negative-money colour on every other surface in
 * this app and a coverage break is not a judgement about the money. Both strokes are graphics,
 * which WCAG 1.4.11 puts at 3:1. Measured from the palette triplets, on paper / on card:
 *   gold      light 4.57 / 5.67   dark 7.40 / 6.22
 *   estimate  light 6.56 / 8.14   dark 8.13 / 6.83
 */
const STROKE: Record<TrendSegmentKind, { color: string; width: number; dash?: string; cap: 'butt' | 'round'; key: string }> = {
  measured: { color: 'var(--mz-sage)', width: 2.6, cap: 'butt', key: 'recorded' },
  estimated: { color: 'var(--mz-estimate)', width: 2, dash: '6 5', cap: 'butt', key: 'reconstructed' },
  // Round caps grow each mark by the stroke width, so the gaps are written wide enough to survive
  // it: the 1-unit mark draws as a 4-unit dot and the 6-unit gaps close to 3.
  coverage: { color: 'var(--mz-gold)', width: 3, dash: '9 6 1 6', cap: 'round', key: 'ends not comparable' },
};

const KEY_ORDER: TrendSegmentKind[] = ['measured', 'estimated', 'coverage'];

/**
 * The key names the strokes that are actually on screen, and appears only when there is more than
 * one. A single-stroke chart has nothing to disambiguate and the title already names the series.
 */
function StrokeKey({ kinds }: { kinds: TrendSegmentKind[] }) {
  if (kinds.length < 2) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {KEY_ORDER.filter((k) => kinds.includes(k)).map((kind) => (
        <span key={kind} className="flex items-center gap-1.5 text-rule text-muted-2">
          <svg width="16" height="6" viewBox="0 0 16 6" aria-hidden="true" className="flex-shrink-0">
            <line
              x1="0"
              y1="3"
              x2="16"
              y2="3"
              stroke={STROKE[kind].color}
              strokeWidth={STROKE[kind].width}
              strokeDasharray={STROKE[kind].dash}
              strokeLinecap={STROKE[kind].cap}
            />
          </svg>
          {STROKE[kind].key}
        </span>
      ))}
    </div>
  );
}

/**
 * The spacing below which two points are closer than a mouse can separate them, as a percentage
 * of the plot. Measured at 750px of plot in the Reports column, 1% is 7.5px and a hover target is
 * half that, since `nearest` splits the distance between neighbours. The stored net-worth series
 * runs 0.55% at its tightest, about 4px, and puts fifteen of its twenty points inside the last
 * 16.4% of the width. Arrow-key stepping is already exact; below this the reader has to be told
 * it exists, because the mouse no longer is.
 */
const CROWDED_STEP_PCT = 1;

/** Every sentence here is generated from what the geometry found, so none of it can overstate. */
export function trendCaptions(geometry: TrendGeometry): string[] {
  const lines: string[] = [];
  const { breaks, coverageSpans, maxDrawnGapDays, xs } = geometry;
  const elsewhere =
    maxDrawnGapDays === null ? '' : ` Every step this line does draw is at most ${maxDrawnGapDays} days wide.`;
  if (breaks.length === 1) {
    const [only] = breaks;
    lines.push(
      `Nothing is drawn between ${format(parseISO(only.fromDate), 'MMM d, yyyy')} and ` +
        `${format(parseISO(only.toDate), 'MMM d, yyyy')}: ${only.days} days with no reading in between.${elsewhere}`
    );
  } else if (breaks.length > 1) {
    lines.push(
      `Nothing is drawn across ${breaks.length} stretches with no reading in between, the widest ` +
        `${Math.max(...breaks.map((b) => b.days))} days.${elsewhere}`
    );
  }

  // Both sentences count `coverageSpans` entries, which are one-per-rendered-polyline by
  // construction, so the number in the copy is the number of stretches a reader can point at.
  const named = coverageSpans.filter((span) => !span.incomplete);
  const unnamed = coverageSpans.filter((span) => span.incomplete);
  if (named.length > 0) {
    const counts = named.flatMap((span) => span.counts);
    const one = named.length === 1;
    lines.push(
      `${named.length} ${one ? 'stretch is' : 'stretches are'} set apart because the number of accounts ` +
        `counted changes across ${one ? 'it' : 'them'}, between ${Math.min(...counts)} and ` +
        `${Math.max(...counts)}. The two ends of such a stretch are not the same quantity.`
    );
  }
  if (unnamed.length > 0) {
    const one = unnamed.length === 1;
    lines.push(
      `${unnamed.length} ${one ? 'stretch is' : 'stretches are'} set apart because only one end records how ` +
        `many accounts were counted, so whether that number changed across ${one ? 'it' : 'them'} is not known.`
    );
  }

  const steps: number[] = [];
  for (let i = 1; i < xs.length; i++) steps.push(((xs[i] - xs[i - 1]) / VIEW_W) * 100);
  const tightest = steps.length > 0 ? Math.min(...steps) : null;
  if (tightest !== null && tightest < CROWDED_STEP_PCT) {
    lines.push(
      `Points sit as close as ${tightest.toFixed(1)}% of the width apart here, so the arrow keys step ` +
        `through them one at a time.`
    );
  }
  return lines;
}

/**
 * The house line chart: one series against a printed zero, on a time-proportional axis.
 *
 * The fill runs between the trace and zero rather than to the bottom of the frame, and takes its
 * side's colour, because for every quantity drawn here the sign is the reading: net worth, an
 * account balance and a card balance can each sit either side of zero and those are different
 * states, not the same state with a minus sign.
 */
export function TrendChart({ history, marks = NO_MARKS, height = 120, className = '', label = 'this series' }: TrendChartProps) {
  const geometry = useMemo(() => trendGeometry(history, marks), [history, marks]);
  const { segments, fills, isolated, terminals, valueTicks, timeTicks: xTicks, zeroYPct, xs, ys } = geometry;
  // React's own ids carry colons, which are legal in an HTML id and illegal in the CSS fragment
  // selector `url(#…)` resolves through. Two charts on one screen must still not share a clip.
  const clipId = useId().replace(/[^\w-]/g, '');
  const markByDate = useMemo(() => new Map(geometry.marks.map((m) => [m.date, m])), [geometry]);
  const notes = useMemo(() => trendCaptions(geometry), [geometry]);
  const kindsPresent = useMemo(() => [...new Set(segments.map((s) => s.kind))], [segments]);

  const plotRef = useRef<HTMLDivElement>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const nearest = useCallback(
    (fraction: number): number => {
      const target = fraction * VIEW_W;
      let best = 0;
      for (let i = 1; i < xs.length; i++) {
        if (Math.abs(xs[i] - target) < Math.abs(xs[best] - target)) best = i;
      }
      return best;
    },
    [xs]
  );

  const onMove = (e: React.MouseEvent): void => {
    if (xs.length < 2 || !plotRef.current) return;
    const rect = plotRef.current.getBoundingClientRect();
    setHoverIdx(nearest((e.clientX - rect.left) / rect.width));
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (xs.length < 2) return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const from = hoverIdx ?? (e.key === 'ArrowRight' ? -1 : xs.length);
    setHoverIdx(Math.min(xs.length - 1, Math.max(0, from + (e.key === 'ArrowRight' ? 1 : -1))));
  };

  const hoverPoint = hoverIdx != null && history[hoverIdx] ? history[hoverIdx] : null;
  const hoverMark = hoverPoint ? markByDate.get(hoverPoint.date) ?? null : null;
  const hoverXPct = hoverIdx != null && xs[hoverIdx] != null ? (xs[hoverIdx] / VIEW_W) * 100 : 0;
  const hoverYPct = hoverIdx != null && ys[hoverIdx] != null ? (ys[hoverIdx] / VIEW_H) * 100 : 0;

  if (segments.length === 0 && isolated.length === 0) return null;

  const summary =
    `${label} from ${format(parseISO(history[0].date), 'MMM d, yyyy')} to ` +
    `${format(parseISO(history[history.length - 1].date), 'MMM d, yyyy')}, ` +
    `${formatWholeCurrency(Math.min(...history.map((p) => p.value)))} to ` +
    `${formatWholeCurrency(Math.max(...history.map((p) => p.value)))}, drawn against zero.`;

  return (
    <div className={className}>
      <div className="relative" style={{ paddingLeft: GUTTER_PX }}>
        <div className="pointer-events-none absolute left-0 top-0" style={{ width: GUTTER_PX, height }}>
          {valueTicks.map((tick) => (
            <div
              key={tick.value}
              // Money numerals, so `muted` rather than `muted-2`: 5.67:1 on paper against 4.52:1,
              // and the datum wears full ink because every other reading is a distance from it.
              className={`absolute right-2 -translate-y-1/2 whitespace-nowrap text-rule tabular-nums ${
                tick.isZero ? 'text-ink' : 'text-muted'
              }`}
              style={{ top: `${tick.yPct}%` }}
            >
              {tick.label}
            </div>
          ))}
        </div>

        <div
          ref={plotRef}
          className="relative rounded-sm"
          style={{ height }}
          role="img"
          aria-label={summary}
          tabIndex={0}
          onMouseMove={onMove}
          onMouseLeave={() => setHoverIdx(null)}
          onKeyDown={onKeyDown}
          onBlur={() => setHoverIdx(null)}
        >
          <svg
            viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
            width="100%"
            height={height}
            preserveAspectRatio="none"
            className="block overflow-visible"
            aria-hidden="true"
            focusable="false"
          >
            <defs>
              <clipPath id={`${clipId}-above`}>
                <rect x="0" y="0" width={VIEW_W} height={Math.max(0, (zeroYPct / 100) * VIEW_H)} />
              </clipPath>
              <clipPath id={`${clipId}-below`}>
                <rect
                  x="0"
                  y={(zeroYPct / 100) * VIEW_H}
                  width={VIEW_W}
                  height={Math.max(0, VIEW_H - (zeroYPct / 100) * VIEW_H)}
                />
              </clipPath>
            </defs>

            {valueTicks
              .filter((tick) => !tick.isZero)
              .map((tick) => (
                <line
                  key={tick.value}
                  x1="0"
                  x2={VIEW_W}
                  y1={(tick.yPct / 100) * VIEW_H}
                  y2={(tick.yPct / 100) * VIEW_H}
                  stroke="var(--mz-line-3)"
                  strokeWidth="1.5"
                  strokeDasharray="2 5"
                />
              ))}

            {fills.map((polygon) => (
              <g key={polygon}>
                <polygon points={polygon} fill="var(--mz-sage)" opacity="0.10" clipPath={`url(#${clipId}-above)`} />
                <polygon points={polygon} fill="var(--mz-clay)" opacity="0.09" clipPath={`url(#${clipId}-below)`} />
              </g>
            ))}

            <line
              x1="0"
              x2={VIEW_W}
              y1={(zeroYPct / 100) * VIEW_H}
              y2={(zeroYPct / 100) * VIEW_H}
              // `faint` and not `line-3`: the zero rule is the datum the whole scale rests on, so
              // it has to clear 3:1 as a meaningful graphic. line-3 is 1.54:1 on light paper and
              // dot is 2.10:1; faint is 3.26:1 light and 4.10:1 dark, and is already the token
              // documented as deliberately non-text.
              stroke="var(--mz-faint)"
              strokeWidth="2.2"
            />

            {segments.map((segment) => {
              const stroke = STROKE[segment.kind];
              return (
                <polyline
                  key={`${segment.kind}-${segment.from}`}
                  points={segment.points}
                  pathLength={segment.kind === 'measured' ? 1 : undefined}
                  className={segment.kind === 'measured' ? 'mz-draw' : undefined}
                  fill="none"
                  stroke={stroke.color}
                  strokeWidth={stroke.width}
                  strokeDasharray={stroke.dash}
                  strokeLinecap={stroke.cap}
                  strokeLinejoin="round"
                />
              );
            })}
          </svg>

          {/*
            Dots and rings are HTML rather than SVG circles: the viewBox is stretched to the
            container with preserveAspectRatio="none", which would draw a circle as a wide ellipse.
          */}
          {geometry.marks.map((mark) => (
            <div
              key={mark.date}
              className="pointer-events-none absolute h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-sage"
              style={{ left: `${mark.xPct}%`, top: `${mark.yPct}%` }}
            />
          ))}
          {/* A ring says the trace stops here. Every end of an undrawn stretch carries one. */}
          {terminals.map((i) => (
            <div
              key={history[i].date}
              className={`pointer-events-none absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 bg-paper ${
                history[i].estimated ? 'border-estimate' : 'border-sage'
              }`}
              style={{ left: `${(xs[i] / VIEW_W) * 100}%`, top: `${(ys[i] / VIEW_H) * 100}%` }}
            />
          ))}

          {hoverPoint && (
            <>
              <div className="pointer-events-none absolute bottom-0 top-0 w-px bg-line-3" style={{ left: `${hoverXPct}%` }} />
              {/*
                The overlay is the same box the viewBox is stretched onto, so a y already expressed
                as a percentage of VIEW_H is the percentage down the box. Scaling it again by
                height/VIEW_H floated the crosshair dot off its own line, by 21% of the plot at
                height 110.
              */}
              <div
                className={`pointer-events-none absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 bg-card ${
                  hoverPoint.estimated ? 'border-estimate' : 'border-sage'
                }`}
                style={{ left: `${hoverXPct}%`, top: `${hoverYPct}%` }}
              />
              <div
                className={`pointer-events-none absolute -top-2 z-10 whitespace-nowrap rounded-lg border border-line-2 bg-card px-3 py-1.5 text-note shadow-e2 ${
                  hoverXPct > 55 ? '-translate-x-full' : ''
                }`}
                style={{ left: `${hoverXPct}%` }}
              >
                <span className="font-serif text-body tabular-nums text-ink">{formatWholeCurrency(hoverPoint.value)}</span>
                <span className="ml-2 text-muted-2">{format(parseISO(hoverPoint.date), 'MMM d, yyyy')}</span>
                {hoverPoint.estimated && <span className="ml-2 text-muted-2">· reconstructed</span>}
                {hoverPoint.coverage !== undefined && (
                  <span className="ml-2 tabular-nums text-muted-2">· {hoverPoint.coverage} accounts</span>
                )}
                {hoverMark && (
                  <span className="ml-2 tabular-nums text-muted-2">· recorded {formatWholeCurrency(hoverMark.value)}</span>
                )}
              </div>
            </>
          )}
        </div>

        <div className="relative" style={{ height: AXIS_PX }}>
          {xTicks.map((tick) => (
            <div
              key={tick.xPct}
              className="absolute top-1 -translate-x-1/2 whitespace-nowrap text-rule text-muted-2"
              style={{ left: `${tick.xPct}%` }}
            >
              {tick.label}
            </div>
          ))}
        </div>
      </div>

      {(kindsPresent.length > 1 || notes.length > 0) && (
        <div className="mt-1.5 space-y-1" style={{ paddingLeft: GUTTER_PX }}>
          <StrokeKey kinds={kindsPresent} />
          {notes.map((note) => (
            <p key={note} className="text-rule leading-normal text-muted-2">
              {note}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
