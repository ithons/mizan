import type { ReactNode } from 'react';

const paddings = {
  none: '',
  sm: 'p-3.5',
  md: 'p-[18px]',
  lg: 'p-5',
} as const;

/**
 * Elevation is carried by the BORDER. On this palette the surface cannot carry it.
 *
 * Light `paper` and `card` are the same triplet, pure white, so a raised surface has nowhere to
 * rise to: `card` on `paper` measures 1.05:1. `card-alt` sits BELOW `card`, so the one surface
 * step in the ladder is nominal and on light it points the wrong way.
 *
 * The `shadow-e*` is not the boundary either, but it is not uniform across the rungs and stating
 * one figure for all three was wrong. Composited over the page, densest single term then
 * both terms where they overlap:
 *
 *   e1  a 0.07                 rgb(235 237 236)  1.12:1   1.12:1
 *   e2  a 0.12 over a 0.07     rgb(226 228 226)  1.22:1   1.36:1
 *   e3  a 0.20 over a 0.11     rgb(212 213 210)  1.41:1   1.66:1
 *
 * So e2 and e3 do put something on the page, and e3's 1.67:1 is past the 1.15:1 floor `--mz-edge`
 * is held to. What none of them reach is the 3:1 a non-text boundary needs, and a blurred gradient
 * is not an edge at any ratio. On dark every rung composites black over a soft near-black page and
 * measures around 1.08:1, so there the shadow is a weak cue rather than a boundary. It used to be
 * exactly nothing, because dark `paper` was pure black.
 * `tests/cardElevation.test.ts` re-derives all eight figures from the `--mz-e*` declarations.
 * What separates a card from the page, and each rung from the one under it, is the line around it.
 *
 * The ladder as it ships. CIE L* and WCAG 2.1 contrast, re-derived from the triplets in
 * `client/src/index.css` by `tests/cardElevation.test.ts`, which also reads the token names out of
 * `elevations` below so the table cannot drift from the classes. One class per step, so a step
 * names ONE token and both themes get whatever that token is declared as; the theme swap happens
 * inside the token, not here:
 *
 *            light (paper L* 98.1)                     dark (paper L* 8.0)
 *   e1       card 100.0 · line-2 59.4   3.23:1         card 12.4 · line-2 47.6   3.32:1
 *   e2       card-alt 99.1 · line-2 59.4   3.16:1      card-alt 15.7 · line-2 47.6   3.05:1
 *   e3       card-alt 99.1 · line-3 48.0   4.71:1      card-alt 15.7 · line-3 56.9   4.25:1
 *
 * The ratio on each row is that row's border against that row's own surface, which is the pairing
 * the component actually renders. All six clear 3:1, the non-text floor, in both themes, and that
 * is the whole of what makes a rung visible.
 *
 * The two halves therefore no longer alternate as equals. e1 to e2 steps the surface (-0.9 L*
 * light, +3.3 L* dark) on a held border, and that step is not what makes e2 read as higher: at
 * 1.02:1 light and 1.09:1 dark it is under the ratio at which a value difference reads as an edge
 * at all. e2 to e3 steps the border (-11.4 L* light, +9.3 L* dark) on a held surface, and against
 * that same `card-alt` fill it takes the edge from 3.02:1 to 4.74:1 on light and 3.19:1 to 4.88:1
 * on dark. Read a rung by its line; to separate a rung further, step the line.
 *
 * This docstring used to describe a different ladder: e1 on `line` and e2 on `line-3` in one theme
 * against `line-2` in the other. `className` is one string for both themes, so no arrangement of
 * these three classes could have produced it, and nothing in the built CSS ever did.
 *
 * e3 still stops at `card-alt` rather than raising onto `card-white`, but the reason recorded here
 * is gone rather than restated. That reason was that `card-white` sat at L* 31.3 on dark, where
 * [historical] `clay` measured 3.41:1 and [historical] `muted-2` 3.30:1, both below AA, the three
 * re-derived from `git show 9e1c99b:client/src/index.css`. `card-white` is L* 19.5 on dark now
 * and those two measure 6.17:1 and 5.27:1 on it, both clear, so nothing would break. What holds
 * instead is that `card-white` is not a rung: on light it is the same pure white as `paper` and
 * `card` (L* 100.0, 1.00:1 against it and 1.05:1 against `paper`), so raising e3's surface onto it moves nothing in
 * the theme with the least room, and on dark it would buy 1.12:1. e3 separates with `line-3`,
 * worth 4.74:1 light and 4.88:1 dark against its own surface, and with the scrim beneath it.
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
