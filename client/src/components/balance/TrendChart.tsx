import { useMemo, useRef, useState } from 'react';
import { format, parseISO } from 'date-fns';
import { formatWholeCurrency } from '../../lib/formatters';

const VIEW_W = 1000;
const VIEW_H = 140;

interface TrendChartProps {
  history: Array<{ date: string; value: number }>;
  height?: number;
  className?: string;
}

/** Map a value series into polyline points inside the fixed viewBox. */
function trendGeometry(history: Array<{ date: string; value: number }>): { points: string; ys: number[] } {
  if (history.length < 2) return { points: '', ys: [] };
  const values = history.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = VIEW_W / (history.length - 1);
  const ys = values.map((v) => 128 - ((v - min) / span) * 116);
  const points = ys.map((y, i) => `${(i * step).toFixed(1)},${y.toFixed(1)}`).join(' ');
  return { points, ys };
}

/**
 * The house line chart: sage stroke with a soft fill, draw-in animation, and a
 * crosshair readout on hover. Needs at least two points to render anything.
 */
export function TrendChart({ history, height = 120, className = '' }: TrendChartProps) {
  const { points, ys } = useMemo(() => trendGeometry(history), [history]);
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
        <polyline points={points} pathLength={1} className="mz-draw" fill="none" stroke="var(--mz-sage)" strokeWidth="2.5" />
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
          </div>
        </>
      )}
    </div>
  );
}
