import { useMemo, useRef, useState } from 'react';
import { format, parseISO } from 'date-fns';
import { formatWholeCurrency } from '../../lib/formatters';

const VIEW_W = 1000;
const VIEW_H = 140;

export interface TrendPoint {
  date: string;
  value: number;
  /**
   * True when the point is reconstructed rather than observed. Net-worth history before the
   * first real sync is estimated by undoing transactions off today's balances, which cannot
   * see what it has no record of: a credit card's payments, or any month the ledger does not
   * reach. On real data the last estimated month read $4,049.84 against $1,068.29 measured
   * four weeks later. Drawing that as the same solid line as a measured balance is the chart
   * asserting something it does not know.
   */
  estimated?: boolean;
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
}

interface MarkPosition extends TrendMark {
  xPct: number;
  yPct: number;
}

interface TrendGeometry {
  points: string;
  ys: number[];
  /** Polyline for the measured run, and for the estimated run, each '' when absent. */
  measuredPoints: string;
  estimatedPoints: string;
  marks: MarkPosition[];
}

/** Map a value series into polyline points inside the fixed viewBox. Exported for tests. */
export function trendGeometry(history: TrendPoint[], marks: TrendMark[]): TrendGeometry {
  const empty: TrendGeometry = { points: '', ys: [], measuredPoints: '', estimatedPoints: '', marks: [] };
  if (history.length < 2) return empty;

  const values = history.map((p) => p.value);
  // Marks share the line's scale and widen it, so one sitting well off the line is drawn where it
  // actually is instead of being clipped to the edge of the plot.
  const min = Math.min(...values, ...marks.map((m) => m.value));
  const max = Math.max(...values, ...marks.map((m) => m.value));
  const span = max - min || 1;
  const step = VIEW_W / (history.length - 1);
  const y = (v: number): number => 128 - ((v - min) / span) * 116;
  const ys = values.map(y);
  const coord = (i: number): string => `${(i * step).toFixed(1)},${ys[i].toFixed(1)}`;
  const points = ys.map((_, i) => coord(i)).join(' ');

  const indexOfDate = new Map(history.map((p, i) => [p.date, i]));
  const placed: MarkPosition[] = [];
  for (const mark of marks) {
    const i = indexOfDate.get(mark.date);
    if (i === undefined) continue;
    placed.push({ ...mark, xPct: (i / (history.length - 1)) * 100, yPct: (y(mark.value) / VIEW_H) * 100 });
  }

  // Estimates only ever precede measurements in a snapshot series, so it splits at a single
  // boundary. The joining segment is drawn as estimated, so the transition from reconstructed to
  // observed reads as one continuous line without claiming the handover point was measured all
  // along. A ledger series has no estimated points at all and takes the first branch whole.
  const firstMeasured = history.findIndex((p) => !p.estimated);
  if (firstMeasured === 0) {
    return { ...empty, points, ys, measuredPoints: points, marks: placed };
  }
  if (firstMeasured === -1) {
    return { ...empty, points, ys, estimatedPoints: points, marks: placed };
  }

  const estimatedIdx = history.map((_, i) => i).filter((i) => i <= firstMeasured);
  const measuredIdx = history.map((_, i) => i).filter((i) => i >= firstMeasured);
  return {
    points,
    ys,
    estimatedPoints: estimatedIdx.map(coord).join(' '),
    measuredPoints: measuredIdx.length > 1 ? measuredIdx.map(coord).join(' ') : '',
    marks: placed,
  };
}

const NO_MARKS: TrendMark[] = [];

/**
 * The house line chart: sage stroke with a soft fill, draw-in animation, and a
 * crosshair readout on hover. Needs at least two points to render anything.
 */
export function TrendChart({ history, marks = NO_MARKS, height = 120, className = '' }: TrendChartProps) {
  const geometry = useMemo(() => trendGeometry(history, marks), [history, marks]);
  const { points, ys, measuredPoints, estimatedPoints } = geometry;
  const area = points ? `${points} ${VIEW_W},${VIEW_H} 0,${VIEW_H}` : '';
  const markByDate = useMemo(() => new Map(geometry.marks.map((m) => [m.date, m])), [geometry]);

  const chartRef = useRef<HTMLDivElement>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const onChartMove = (e: React.MouseEvent) => {
    if (history.length < 2 || !chartRef.current) return;
    const rect = chartRef.current.getBoundingClientRect();
    const frac = (e.clientX - rect.left) / rect.width;
    setHoverIdx(Math.min(history.length - 1, Math.max(0, Math.round(frac * (history.length - 1)))));
  };
  const hoverPoint = hoverIdx != null && history[hoverIdx] ? history[hoverIdx] : null;
  const hoverMark = hoverPoint ? markByDate.get(hoverPoint.date) ?? null : null;
  const hoverXPct = hoverIdx != null && history.length > 1 ? (hoverIdx / (history.length - 1)) * 100 : 0;
  const hoverYPct = hoverIdx != null && ys[hoverIdx] != null ? (ys[hoverIdx] / VIEW_H) * 100 : 0;

  if (!points) return null;

  return (
    <div ref={chartRef} className={`relative ${className}`} onMouseMove={onChartMove} onMouseLeave={() => setHoverIdx(null)}>
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        width="100%"
        height={height}
        preserveAspectRatio="none"
        className="block overflow-visible"
      >
        <polyline points={area} fill="var(--mz-sage-soft)" opacity="0.07" stroke="none" />
        {estimatedPoints && (
          <polyline
            points={estimatedPoints}
            fill="none"
            stroke="var(--mz-sage)"
            strokeWidth="1.5"
            strokeDasharray="5 5"
            opacity="0.5"
          />
        )}
        {measuredPoints && (
          <polyline points={measuredPoints} pathLength={1} className="mz-draw" fill="none" stroke="var(--mz-sage)" strokeWidth="2.5" />
        )}
      </svg>
      {/*
        Marks are HTML rather than SVG circles: the viewBox is stretched to the container with
        preserveAspectRatio="none", which would draw a circle as a wide ellipse.
      */}
      {geometry.marks.map((mark) => (
        <div
          key={mark.date}
          className="pointer-events-none absolute h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-sage"
          style={{ left: `${mark.xPct}%`, top: `${mark.yPct}%` }}
        />
      ))}
      {hoverPoint && (
        <>
          <div className="pointer-events-none absolute bottom-0 top-0 w-px bg-line-3" style={{ left: `${hoverXPct}%` }} />
          {/*
            The overlay is the same box the viewBox is stretched onto, so a y already expressed as a
            percentage of VIEW_H is the percentage down the box. Scaling it again by height/VIEW_H
            floated the crosshair dot off its own line, by 21% of the plot at height 110.
          */}
          <div
            className="pointer-events-none absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-sage bg-card"
            style={{ left: `${hoverXPct}%`, top: `${hoverYPct}%` }}
          />
          <div
            className={`pointer-events-none absolute -top-2 whitespace-nowrap rounded-lg border border-line-2 bg-card px-3 py-1.5 text-note ${
              hoverXPct > 55 ? '-translate-x-full' : ''
            }`}
            style={{ left: `${hoverXPct}%` }}
          >
            <span className="font-serif text-body tabular-nums text-ink">{formatWholeCurrency(hoverPoint.value)}</span>
            <span className="ml-2 text-muted-2">{format(parseISO(hoverPoint.date), 'MMM d, yyyy')}</span>
            {hoverPoint.estimated && <span className="ml-2 text-muted-2">· estimated</span>}
            {hoverMark && (
              <span className="ml-2 tabular-nums text-muted-2">· recorded {formatWholeCurrency(hoverMark.value)}</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
