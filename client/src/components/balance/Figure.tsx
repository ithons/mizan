import type { ReactNode } from 'react';

/**
 * The money numeral.
 *
 * Before this existed the type scale was declared and then not used: 380 of 424 step usages, 89.6%,
 * sat inside the 11.5-15px band (micro/note/body/body-lg), and on every screen the word naming the
 * figure was set LARGER than the figure (`text-display` 28px title over a `text-figure` 22px
 * number). Nothing was the subject of anything.
 *
 * Counted over client/src at commit c458d83, matching `text-<step>` for the twelve steps in
 * tailwind.config.js with longest-alternative-first ordering so `text-body-lg` is not scored as
 * `text-body`. Distribution: note 140, body 130, body-lg 87, micro 23, rule 13, sub 9, figure 7,
 * display 7, title 4, display-lg 2, hero 1, hero-lg 1.
 *
 * The ladder here is the reading order, and the gaps in it are the point:
 *
 *   subject   44px  the one number the screen exists to show
 *   lead      28px  a supporting total, three or four to a screen
 *   group     22px  the headline of one item in a list
 *   row       15px  a figure inside a row, where the row is the unit
 *
 * `subject` and `lead` are set light because Newsreader's real axis is 200-800 and a 44px figure
 * at 400 is a slab; `group` and `row` stay at 400 because below ~22px a light serif goes thin.
 */
const scales = {
  subject: 'text-hero-lg font-light leading-none',
  lead: 'text-display font-light leading-none',
  group: 'text-figure leading-tight',
  row: 'text-body-lg',
} as const;

export type FigureScale = keyof typeof scales;

/**
 * What the two directions of a signed figure MEAN. Passing this is what turns a minus sign into
 * a state.
 *
 * Four of the five rendering hazards the correctness work created are the same hazard: a money
 * field that used to be one-directional now legitimately points both ways, and the two directions
 * are different states rather than one state with a sign. `free` is signed, so "short this month"
 * and "free to spend" are not the same reading. A card balance is signed, so "you owe $563.26"
 * and "Discover owes you $563.26" are not the same reading. Rendering either as a red number in
 * the slot where a black one used to sit says neither.
 *
 * So a caller that knows the figure is signed declares both words, and the component renders the
 * MAGNITUDE plus the word. A caller that does not pass `states` gets the sign printed, which is
 * correct for a figure whose direction carries no separate meaning (a delta, a net).
 */
export interface FigureStates {
  /** Reading when the value is >= 0, e.g. 'free to spend'. */
  positive: string;
  /** Reading when the value is < 0, e.g. 'short'. */
  negative: string;
  /** Reading when the value is exactly 0. Falls back to `positive`. */
  zero?: string;
}

const tones = {
  ink: 'text-ink',
  positive: 'text-sage-deep',
  negative: 'text-clay',
  /** A reverse-replayed figure is not a measured one. */
  estimate: 'text-estimate',
} as const;

export type FigureTone = keyof typeof tones;

interface FigureProps {
  /** Pre-formatted magnitude or value. Formatting stays with the caller; this owns type only. */
  children: ReactNode;
  scale?: FigureScale;
  tone?: FigureTone;
  /**
   * The signed value behind `children`, when the figure has two meanings. Supplying this with
   * `states` renders the state word beneath and picks the tone; the caller is then responsible
   * for passing the MAGNITUDE as `children`, since the word already carries the direction.
   */
  value?: number;
  states?: FigureStates;
  /** Quiet label above the figure. */
  label?: ReactNode;
  className?: string;
}

/** Which of `states` applies, given a signed value. Exported so callers can label their own copy. */
export function readState(value: number, states: FigureStates): string {
  if (value === 0) return states.zero ?? states.positive;
  return value > 0 ? states.positive : states.negative;
}

export function Figure({
  children,
  scale = 'lead',
  tone,
  value,
  states,
  label,
  className = '',
}: FigureProps) {
  const signed = value !== undefined && states !== undefined;
  const resolvedTone: FigureTone =
    tone ?? (signed ? (value >= 0 ? 'positive' : 'negative') : 'ink');

  return (
    <div className={className}>
      {label != null && (
        <div className="mb-1.5 text-micro font-semibold uppercase tracking-[0.16em] text-muted-2">{label}</div>
      )}
      <div className={`font-serif tabular-nums ${scales[scale]} ${tones[resolvedTone]}`}>{children}</div>
      {signed && (
        <div className="mt-1.5 text-note text-muted">{readState(value, states)}</div>
      )}
    </div>
  );
}
