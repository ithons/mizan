import { formatWholeCurrency } from '../../lib/formatters';
import { useSettledValue } from '../../lib/useSettledValue';

// Authored in viewBox units at roughly the size this renders at (~250px wide). Drawing it
// four times larger and scaling down thins every hairline to a fraction of a pixel, which is
// most of why the previous version looked flat.
const PIVOT_X = 160;
const PIVOT_Y = 78;
const HALF_BEAM = 104;
const STEM_DROP = 13;
const CORD_DROP = 62;
const PAN_RX = 30;
const PAN_RY = 6.5;
// Shallow on purpose. A dish much deeper than its rim is tall stops reading as an opening and
// merges with the cords above it into a single cone. Deep enough that a sliver of the outer
// wall shows below the rim, which is the only thing giving the pan volume.
const PAN_DEPTH = 12;
const BASE_Y = 212;
const MAX_TILT_DEG = 9;

// Beam half-thickness at the ends and at the control point that shapes the taper. A quadratic
// hits (end + 2*ctrl + end)/4 at its midpoint, so ctrl 8.8 puts 5.4 units of beam over the
// fulcrum and 1.3 at the tips.
const BEAM_END_HALF = 1.3;
const BEAM_CTRL_HALF = 8.8;

/**
 * Degrees the beam tilts for a given balance sheet. Positive dips the assets pan.
 *
 * Linear in debt's share of the whole sheet across the entire domain: no debt tips fully one
 * way, owing as much as you hold sits level, and every state in between is distinguishable.
 *
 * The previous formula multiplied that share by 12 and clamped the result to 7 degrees, so it
 * saturated at any share below 21% — a sheet with 5% debt and one with none at all drew exactly
 * the same picture, across the range most people actually live in.
 */
export function beamTiltDegrees(assets: number, owed: number): number {
  const total = assets + owed;
  if (total <= 0) return 0;
  return MAX_TILT_DEG * (1 - 2 * (owed / total));
}

interface BalanceScaleProps {
  assets: number;
  liabilities: number;
  className?: string;
}

/**
 * The signature figure: an equal-arm balance carrying assets against what is owed.
 *
 * Both pans are drawn identically, on purpose. A real balance does not colour-code its pans —
 * that is what makes the comparison worth trusting — and the surrounding page states the two
 * figures in words, so tinting one sage and one clay only had the interface pre-judging the
 * reading before the reader got to it.
 */
export function BalanceScale({ assets, liabilities, className = '' }: BalanceScaleProps) {
  const owed = Math.abs(liabilities);
  const tilt = useSettledValue(beamTiltDegrees(assets, owed));

  const rad = (tilt * Math.PI) / 180;
  const leftX = PIVOT_X - HALF_BEAM * Math.cos(rad);
  const leftY = PIVOT_Y + HALF_BEAM * Math.sin(rad);
  const rightX = PIVOT_X + HALF_BEAM * Math.cos(rad);
  const rightY = PIVOT_Y - HALF_BEAM * Math.sin(rad);

  // Unit normal to the beam, so the taper stays perpendicular as it swings.
  const nx = Math.sin(rad);
  const ny = Math.cos(rad);
  const edge = (h: number): string =>
    `${(leftX + nx * h).toFixed(2)} ${(leftY + ny * h).toFixed(2)}`;
  const beamPath =
    `M${edge(BEAM_END_HALF)}` +
    ` Q${(PIVOT_X + nx * BEAM_CTRL_HALF).toFixed(2)} ${(PIVOT_Y + ny * BEAM_CTRL_HALF).toFixed(2)}` +
    ` ${(rightX + nx * BEAM_END_HALF).toFixed(2)} ${(rightY + ny * BEAM_END_HALF).toFixed(2)}` +
    ` L${(rightX - nx * BEAM_END_HALF).toFixed(2)} ${(rightY - ny * BEAM_END_HALF).toFixed(2)}` +
    ` Q${(PIVOT_X - nx * BEAM_CTRL_HALF).toFixed(2)} ${(PIVOT_Y - ny * BEAM_CTRL_HALF).toFixed(2)}` +
    ` ${edge(-BEAM_END_HALF)} Z`;

  // Pans hang plumb from the beam ends, so the suspension is computed rather than rotated.
  const pans = [leftX, rightX].map((cx, i) => ({
    cx,
    rimY: (i === 0 ? leftY : rightY) + CORD_DROP,
    knobX: cx,
    knobY: i === 0 ? leftY : rightY,
  }));

  const label =
    assets + owed <= 0
      ? 'Balance scale: nothing on either pan yet'
      : `Balance scale: assets ${formatWholeCurrency(assets)} against ${formatWholeCurrency(owed)} owed`;

  return (
    <svg viewBox="0 40 320 196" className={className} role="img" aria-label={label}>
      {/* The one piece of shading in the figure. Flat fills read as a diagram of a scale; the
          dish is where a single gradient buys the most object-ness for the least noise.
          Pans are the same material as the beam on purpose — drawn in near-paper tones they
          read as wireframe cones hung off a solid bar, rather than as one instrument. */}
      <defs>
        <linearGradient id="mz-pan-wall" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--mz-ink-soft)" />
          <stop offset="100%" stopColor="var(--mz-ink)" />
        </linearGradient>
      </defs>

      <ellipse cx={PIVOT_X} cy={BASE_Y + 9} rx="50" ry="5" fill="var(--mz-faint)" opacity="0.28" />

      {/* Plinth: an elliptical top with a short wall, so the stand has somewhere to stand. */}
      <path
        d={`M${PIVOT_X - 40} ${BASE_Y} L${PIVOT_X - 40} ${BASE_Y + 5} A40 7.5 0 0 0 ${PIVOT_X + 40} ${BASE_Y + 5} L${PIVOT_X + 40} ${BASE_Y} Z`}
        fill="var(--mz-ink)"
      />
      <ellipse cx={PIVOT_X} cy={BASE_Y} rx="40" ry="7.5" fill="var(--mz-ink-soft)" />

      {/* A slender column rather than a post, with a collar under the bearing. That joint is
          most of what separates a turned upright from a rectangle; the same trick at the foot
          reads as a hole punched in the plinth, so the column just meets it. */}
      <path
        d={`M${PIVOT_X - 2.2} ${PIVOT_Y + 10} L${PIVOT_X + 2.2} ${PIVOT_Y + 10} L${PIVOT_X + 4.6} ${BASE_Y} L${PIVOT_X - 4.6} ${BASE_Y} Z`}
        fill="var(--mz-ink-soft)"
      />
      <ellipse cx={PIVOT_X} cy={PIVOT_Y + 11} rx="4.6" ry="1.7" fill="var(--mz-ink)" />

      {pans.map((p, i) => {
        // A stirrup between beam and cords. Without it the cords converge straight to the beam
        // end and the whole suspension reads as one solid cone rather than a hanging pan.
        const ringY = p.knobY + STEM_DROP;
        return (
          <g key={i}>
            <line x1={p.knobX} y1={p.knobY} x2={p.cx} y2={ringY} stroke="var(--mz-muted)" strokeWidth="1.1" />
            <circle cx={p.cx} cy={ringY} r="2.4" fill="none" stroke="var(--mz-muted)" strokeWidth="1.1" />
            <line x1={p.cx} y1={ringY + 2.4} x2={p.cx - PAN_RX} y2={p.rimY} stroke="var(--mz-muted)" strokeWidth="0.9" />
            <line x1={p.cx} y1={ringY + 2.4} x2={p.cx + PAN_RX} y2={p.rimY} stroke="var(--mz-muted)" strokeWidth="0.9" />
            {/* Outer wall of the dish, seen from slightly above, then the opening over it. */}
            <path
              d={`M${p.cx - PAN_RX} ${p.rimY} Q${p.cx} ${p.rimY + PAN_DEPTH * 2} ${p.cx + PAN_RX} ${p.rimY} Z`}
              fill="url(#mz-pan-wall)"
            />
            <ellipse
              cx={p.cx}
              cy={p.rimY}
              rx={PAN_RX}
              ry={PAN_RY}
              fill="var(--mz-beam)"
              stroke="var(--mz-ink)"
              strokeWidth="1.1"
            />
            {/* Front cord, over the dish, so one of the three reads as nearer than the pan. */}
            <line x1={p.cx} y1={ringY + 2.4} x2={p.cx} y2={p.rimY + PAN_RY} stroke="var(--mz-muted)" strokeWidth="0.9" />
          </g>
        );
      })}

      <path d={beamPath} fill="var(--mz-ink-soft)" />

      {/* Bearing seat: the beam rests on the pillar rather than being pinned through it. A
          taller wedge here reads as an arrowhead pointing at the beam, not as a pivot. */}
      <rect x={PIVOT_X - 8} y={PIVOT_Y + 5} width="16" height="5" rx="2.5" fill="var(--mz-ink)" />

      {pans.map((p, i) => (
        <circle key={i} cx={p.knobX} cy={p.knobY} r="2.6" fill="var(--mz-ink)" />
      ))}
    </svg>
  );
}
