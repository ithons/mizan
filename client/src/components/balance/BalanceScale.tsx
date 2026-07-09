import { formatWholeCurrency } from '../../lib/formatters';
import { useEasedValue } from '../../lib/useEasedValue';

const PIVOT_X = 310;
const PIVOT_Y = 80;
const HALF_BEAM = 193;
const HANGER_SPREAD = 55;
const HANGER_DROP = 72;
const PAN_HALF_WIDTH = 61;
const MAX_TILT_DEG = 7;

interface BalanceScaleProps {
  assets: number;
  liabilities: number;
  className?: string;
}

/**
 * The signature brand moment: a balance scale that breathes and tilts with the
 * real ratio of assets (sage pan, left) to owed (clay pan, right). Pans hang
 * plumb from the beam ends, so the beam angle is computed, not transformed.
 */
export function BalanceScale({ assets, liabilities, className = '' }: BalanceScaleProps) {
  const owed = Math.abs(liabilities);
  const total = assets + owed;
  const targetTilt = total > 0 ? Math.max(-MAX_TILT_DEG, Math.min(MAX_TILT_DEG, ((assets - owed) / total) * 12)) : 0;
  const tilt = useEasedValue(targetTilt, 1200);

  const rad = (tilt * Math.PI) / 180;
  // Positive tilt = assets side heavier = left end dips.
  const leftX = PIVOT_X - HALF_BEAM * Math.cos(rad);
  const leftY = PIVOT_Y + HALF_BEAM * Math.sin(rad);
  const rightX = PIVOT_X + HALF_BEAM * Math.cos(rad);
  const rightY = PIVOT_Y - HALF_BEAM * Math.sin(rad);
  const leftPanY = leftY + HANGER_DROP;
  const rightPanY = rightY + HANGER_DROP;

  const pan = (cx: number, panY: number) =>
    `M${cx - PAN_HALF_WIDTH} ${panY} Q${cx} ${panY + 54} ${cx + PAN_HALF_WIDTH} ${panY}`;

  return (
    <svg
      viewBox="0 42 620 252"
      className={className}
      role="img"
      aria-label={`Balance scale: assets ${formatWholeCurrency(assets)}, owed ${formatWholeCurrency(owed)}`}
    >
      {/* Breathe on an inner group: SVG-internal transforms never extend page
          layout/scroll bounds, so the ambient motion can't wobble the viewport. */}
      <g
        style={{
          animation: 'mz-breathe 8s ease-in-out infinite',
          transformOrigin: `${PIVOT_X}px ${PIVOT_Y - 42}px`,
          transformBox: 'view-box',
        }}
      >
      {/* stand */}
      <line x1={PIVOT_X} y1={PIVOT_Y} x2={PIVOT_X} y2="250" stroke="var(--mz-beam)" strokeWidth="4" strokeLinecap="round" />
      <path d="M258 250 Q310 236 362 250" fill="none" stroke="var(--mz-beam)" strokeWidth="4" strokeLinecap="round" />
      <circle cx={PIVOT_X} cy={PIVOT_Y} r="6" fill="var(--mz-sage-soft)" />
      {/* beam */}
      <line x1={leftX} y1={leftY} x2={rightX} y2={rightY} stroke="var(--mz-sage)" strokeWidth="5" strokeLinecap="round" />
      {/* assets pan */}
      <line x1={leftX} y1={leftY} x2={leftX - HANGER_SPREAD} y2={leftPanY} stroke="var(--mz-beam)" strokeWidth="2" />
      <line x1={leftX} y1={leftY} x2={leftX + HANGER_SPREAD} y2={leftPanY} stroke="var(--mz-beam)" strokeWidth="2" />
      <path
        d={pan(leftX, leftPanY)}
        fill="var(--mz-sage-soft)"
        fillOpacity="0.16"
        stroke="var(--mz-sage)"
        strokeWidth="3"
        strokeLinecap="round"
      />
      {/* owed pan */}
      <line x1={rightX} y1={rightY} x2={rightX - HANGER_SPREAD} y2={rightPanY} stroke="var(--mz-beam)" strokeWidth="2" />
      <line x1={rightX} y1={rightY} x2={rightX + HANGER_SPREAD} y2={rightPanY} stroke="var(--mz-beam)" strokeWidth="2" />
      <path
        d={pan(rightX, rightPanY)}
        fill="var(--mz-clay-scale)"
        fillOpacity="0.14"
        stroke="var(--mz-clay-scale)"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <text x={leftX} y={leftPanY + 80} textAnchor="middle" fontFamily="Instrument Sans" fontSize="11" letterSpacing="2" fill="var(--mz-muted)">
        ASSETS
      </text>
      <text x={leftX} y={leftPanY + 102} textAnchor="middle" fontFamily="Newsreader" fontSize="20" fill="var(--mz-ink)">
        {formatWholeCurrency(assets)}
      </text>
      <text x={rightX} y={rightPanY + 80} textAnchor="middle" fontFamily="Instrument Sans" fontSize="11" letterSpacing="2" fill="var(--mz-muted)">
        OWED
      </text>
      <text x={rightX} y={rightPanY + 102} textAnchor="middle" fontFamily="Newsreader" fontSize="20" fill="var(--mz-clay)">
        {formatWholeCurrency(owed)}
      </text>
      </g>
    </svg>
  );
}
