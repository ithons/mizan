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

interface TrendChartProps {
  history: TrendPoint[];
  height?: number;
  className?: string;
}

interface TrendGeometry {
  points: string;
  ys: number[];
  /** Polyline for the measured run, and for the estimated run, each '' when absent. */
  measuredPoints: string;
  estimatedPoints: string;
}

/** Map a value series into polyline points inside the fixed viewBox. */
function trendGeometry(history: TrendPoint[]): TrendGeometry {
  const empty: TrendGeometry = { points: '', ys: [], measuredPoints: '', estimatedPoints: '' };
  if (history.length < 2) return empty;

  const values = history.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = VIEW_W / (history.length - 1);
  const ys = values.map((v) => 128 - ((v - min) / span) * 116);
  const coord = (i: number): string => `${(i * step).toFixed(1)},${ys[i].toFixed(1)}`;
  const points = ys.map((_, i) => coord(i)).join(' ');

  // Snapshots arrive oldest-first and estimates only ever precede measurements, so the series
  // splits at a single boundary. The joining segment is drawn as estimated, so the transition
  // from reconstructed to observed reads as one continuous line without claiming the handover
  // point was measured all along.
  const firstMeasured = history.findIndex((p) => !p.estimated);
  if (firstMeasured <= 0) {
    return { ...empty, points, ys, measuredPoints: points };
  }

  const estimatedIdx = history.map((_, i) => i).filter((i) => i <= firstMeasured);
  const measuredIdx = history.map((_, i) => i).filter((i) => i >= firstMeasured);
  return {
    points,
    ys,
    estimatedPoints: estimatedIdx.map(coord).join(' '),
    measuredPoints: measuredIdx.length > 1 ? measuredIdx.map(coord).join(' ') : '',
  };
}

/**
 * The house line chart: sage stroke with a soft fill, draw-in animation, and a
 * crosshair readout on hover. Needs at least two points to render anything.
 */
export function TrendChart({ history, height = 120, className = '' }: TrendChartProps) {
  const { points, ys, measuredPoints, estimatedPoints } = useMemo(() => trendGeometry(history), [history]);
  const area = points ? `${points} ${VIEW_W},${VIEW_H} 0,${VIEW_H}` : '';

  const chartRef = useRef<HTMLDivElement>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const onChartMove = (e: React.MouseEvent) => {
    if (history.length < 2 || !chartRef.current) return;
    const rect = chartRef.current.getBoundingClientRect();
    const frac = (e.clientX - rect.left) / rect.width;
    setHoverIdx(Math.min(history.length - 1, Math.max(0, Math.round(frac * (history.length - 1)))));
  };
  const hoverPoint = hoverIdx != null && history[hoverIdx] ? history[hoverIdx] : null;
  const hoverXPct = hoverIdx != null && history.length > 1 ? (hoverIdx / (history.length - 1)) * 100 : 0;
  const hoverYPct = hoverIdx != null && ys[hoverIdx] != null ? (ys[hoverIdx] / VIEW_H) * 100 : 0;

  if (!points) return null;

  return (
    <div ref={chartRef} className={`relative ${className}`} onMouseMove={onChartMove} onMouseLeave={() => setHoverIdx(null)}>
      <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} width="100%" height={height} preserveAspectRatio="none" className="overflow-visible">
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
      {hoverPoint && (
        <>
          <div className="pointer-events-none absolute bottom-0 top-0 w-px bg-line-3" style={{ left: `${hoverXPct}%` }} />
          <div
            className="pointer-events-none absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-sage bg-card"
            style={{ left: `${hoverXPct}%`, top: `${(hoverYPct * height) / VIEW_H}%` }}
          />
          <div
            className={`pointer-events-none absolute -top-2 whitespace-nowrap rounded-lg border border-line-2 bg-card px-3 py-1.5 text-xs ${
              hoverXPct > 55 ? '-translate-x-full' : ''
            }`}
            style={{ left: `${hoverXPct}%` }}
          >
            <span className="font-serif text-[13px] tabular-nums text-ink">{formatWholeCurrency(hoverPoint.value)}</span>
            <span className="ml-2 text-muted-2">{format(parseISO(hoverPoint.date), 'MMM d, yyyy')}</span>
            {hoverPoint.estimated && <span className="ml-2 text-muted-2">· estimated</span>}
          </div>
        </>
      )}
    </div>
  );
}
