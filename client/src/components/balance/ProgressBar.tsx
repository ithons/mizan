/**
 * Fill colours, measured against `track` rather than picked to match the text ramp.
 *
 * A bar fill is a UI component under WCAG 1.4.11 and needs 3:1 against its adjacent colour, which
 * here is the track it sits in and not the page. The three tones this shipped with did not have it
 * on the palette it shipped on, and `SignedBar` below had already hit the same wall and fixed it
 * with `muted`/`sage-deep`. Those two figures are not restated here: the triplets that produced
 * them are gone from index.css, so nothing in the repo can reproduce them.
 *
 * On the tokens as they now stand the original tones would clear, narrowly: `sage` is 3.18:1 light
 * and 3.14:1 dark against `track`, `clay-scale` 5.73:1 and 5.98:1. The map is still the darkest
 * member of each family, and the reason is now the one that does not depend on the palette: it is
 * the tone the money numerals already use, so the bar and the figure beside it agree. sage-deep is
 * what a positive figure is set in (3.91:1 / 4.01:1 on track) and clay is what a negative one is
 * set in (9.86:1 / 9.73:1). `gold` stays, it is the only caution token, and it clears at 3.52:1
 * light and 4.02:1 dark. Every ratio here is re-derived from the shipped tokens by
 * tests/plan.test.ts, which reads this map rather than a list of names typed next to it.
 */
const tones = {
  sage: 'bg-sage-deep',
  gold: 'bg-gold',
  clay: 'bg-clay',
} as const;

export type ProgressTone = keyof typeof tones;

/** Bar color by budget health: sage under budget, gold near/at the limit, clay over. */
export function healthTone(spent: number, budget: number): ProgressTone {
  if (budget <= 0) return 'sage';
  const ratio = spent / budget;
  if (ratio > 1) return 'clay';
  if (ratio >= 0.85) return 'gold';
  return 'sage';
}

interface ProgressBarProps {
  /** 0..1 fraction; values are clamped. */
  fraction: number;
  tone?: ProgressTone;
  height?: 6 | 8 | 10;
  className?: string;
}

export function ProgressBar({ fraction, tone = 'sage', height = 6, className = '' }: ProgressBarProps) {
  const pct = Math.min(100, Math.max(0, fraction * 100));
  return (
    /* Track is `bg-track`, not `bg-line`, because the unfilled portion has to be visible or the bar
       reads as a floating dash of unknown extent rather than a measurement.
       OPEN FINDING, do not read this as settled: on the current palette `track` no longer buys that.
       Re-derived from index.css, `track` against the grounds this bar renders on measures
       paper 1.32 light / 1.55 dark, card 1.32 / 1.40, card-alt 1.26 / 1.31, well 1.19 / 1.28 and
       rail 1.22 / 1.46, against `line`'s 1.30 / 1.39 on paper. The fill-to-track edge still clears
       3:1 in every tone (see the map above), so the VALUE is readable; the bar's own outer extent
       is not. That is a token question, not a component one, and it is deliberately not being
       patched here by swapping the class. */
    <div
      className={`overflow-hidden rounded-full bg-track ${className}`}
      style={{ height }}
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className={`h-full rounded-full transition-[width] duration-300 ease-out ${tones[tone]}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

/**
 * Order a signed magnitude list so the biggest thing is first and a credit is not mistaken for a
 * small expense.
 *
 * A category total can be negative now: July 2026 Shopping is -$1,203.63 because that month's
 * Amazon and REI credits exceed its purchases. Sorting such a list by amount descending puts the
 * single largest movement of money LAST, under a heading that says "top spending". Sorting by
 * absolute value instead interleaves a $1,203.63 credit into the middle of the spend ranking as
 * though it were spend.
 *
 * Neither is right, because they are two lists. Spending ranks by amount; credits are a different
 * kind of row and follow, ranked by their own size.
 */
export function bySignedMagnitude(a: number, b: number): number {
  if (a >= 0 && b < 0) return -1;
  if (a < 0 && b >= 0) return 1;
  return a >= 0 ? b - a : a - b;
}

export interface SignedBarScale {
  /** Largest absolute value in the set. Every bar is drawn against this, never against its own. */
  extent: number;
  /** True when at least one member of the set is negative, so the zero rule leaves the left edge. */
  diverging: boolean;
}

/**
 * The scale for one list of signed values. Computed once per list, because the zero rule has to
 * land in the same place on every row or the bars are not comparable to each other.
 */
export function signedBarScale(values: number[]): SignedBarScale {
  return {
    extent: Math.max(1, ...values.map(Math.abs)),
    diverging: values.some((v) => v < 0),
  };
}

interface SignedBarProps extends SignedBarScale {
  value: number;
  height?: 6 | 8 | 10;
  className?: string;
}

/**
 * Diverging bar with a printed zero.
 *
 * `ProgressBar` clamps to 0..1, which is correct for a fraction of a budget and silently wrong for
 * a signed total: a -$1,203.63 category clamped to zero width renders identically to a category
 * that spent nothing, and "spent nothing" is a claim the data does not make. This draws from a
 * zero rule instead, so the direction is visible and the extent is comparable across the set.
 *
 * The zero rule sits where zero actually falls given the set's own range, so a list with no
 * credits in it puts zero flush left and reads exactly like the plain bar it replaces.
 */
export function SignedBar({ value, extent, diverging, height = 6, className = '' }: SignedBarProps) {
  const span = Math.max(1, extent);
  // Zero sits flush left while every value in the set points the same way, and moves to the
  // midpoint the moment one does not, so both directions get identical runway.
  const zeroPct = diverging ? 50 : 0;
  const widthPct = Math.min(1, Math.abs(value) / span) * (diverging ? 50 : 100);
  const negative = value < 0;

  return (
    /* Colour encodes the exception, not the rule. Every bar in a spending list pointing the same
       accent colour spends colour on nothing; the ordinary direction is structural `muted` and the
       accent is kept for the direction that is unusual, which is money coming back.
       Measured against `track` in both themes, because a mark needs 3:1. Re-derived from the
       shipped tokens: muted 5.74/6.19, sage-deep 3.91/4.01 and ink-soft 11.46/9.81 all clear it,
       and ink-soft is the widest margin of the three, which is why the zero rule is set in it. The
       rule is deliberately the most visible thing in the component: it is what makes this a
       measurement rather than a blob. `sage-soft` is the member of the family a lighter fill would
       reach for and it is the one that cannot be used, at 1.63/2.05. */
    <div className={`relative rounded-full bg-track ${className}`} style={{ height }}>
      <div
        className={`absolute top-0 h-full transition-all duration-300 ease-out ${
          negative ? 'rounded-l-full bg-sage-deep' : 'rounded-r-full bg-muted'
        }`}
        style={{
          width: `${widthPct}%`,
          left: negative ? `${zeroPct - widthPct}%` : `${zeroPct}%`,
        }}
      />
      {diverging && <div className="absolute inset-y-0 left-1/2 w-px bg-ink-soft" aria-hidden />}
    </div>
  );
}
