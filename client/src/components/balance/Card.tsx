import type { ReactNode } from 'react';

const paddings = {
  none: '',
  sm: 'p-3.5',
  md: 'p-[18px]',
  lg: 'p-5',
} as const;

/**
 * Elevation is three things at once, and on the dark ground only two of them work.
 *
 * `e1`/`e2`/`e3` are keyed to ink-soft so a shadow over warm paper reads as shade rather than
 * smudge. That mechanism inverts on a ground of L* 13.0: a dark shadow on a dark surface is
 * invisible, and a ladder built on it collapses into one rung. Value separation takes over.
 *
 * Each step therefore raises the surface and the border together, and both ladders run AWAY from
 * their own ground, so the same word means the same thing in both themes:
 *
 *            light (paper L* 87.8)            dark (paper L* 13.0)
 *   e1       card 96.0    · line-2 76.8       card 19.3     · line 27.9
 *   e2       card-alt 98.6 · line-3 72.8      card-alt 21.9 · line-2 33.9
 *   e3       card-alt 98.6 · line-3 72.8      card-alt 21.9 · line-3 40.2
 *
 * e3 stops raising the surface on purpose. `card-white` is the next rung and on the dark theme it
 * sits at L* 31.3, where `clay` measures 3.41:1 and `muted-2` 3.30:1 -- both below AA. A dialog
 * carries money and secondary text, so the rung that would have raised it is the rung that would
 * have broken it. e3 separates with the border and with the scrim beneath it instead.
 */
const elevations = {
  1: 'bg-card border-line-2 shadow-e1',
  2: 'bg-card-alt border-line-2 shadow-e2',
  3: 'bg-card-alt border-line-3 shadow-e3',
} as const;

export type Elevation = keyof typeof elevations;

interface CardProps {
  children: ReactNode;
  padding?: keyof typeof paddings;
  elevation?: Elevation;
  className?: string;
  onClick?: () => void;
}

export function Card({ children, padding = 'md', elevation = 1, className = '', onClick }: CardProps) {
  return (
    <div
      onClick={onClick}
      className={`rounded-xl border ${elevations[elevation]} ${paddings[padding]} ${
        onClick
          ? 'cursor-pointer transition-all duration-150 hover:border-line-3 hover:shadow-e2 active:translate-y-px active:shadow-e1'
          : ''
      } ${className}`}
    >
      {children}
    </div>
  );
}
