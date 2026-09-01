/**
 * The categorical series ramp: eight identities, in a fixed order, as theme tokens.
 *
 * These are `var(--mz-series-N)` references, not hexes, because a chart legend that ignores the
 * theme toggle is a chart legend that goes illegible on one of the two grounds this app ships.
 * The ten literal hexes that used to live here were picked for warm paper and stayed on the dark
 * theme unchanged.
 *
 * A `var()` string is only valid where the browser resolves custom properties: a `style` prop, or
 * an SVG `fill`/`stroke`. It is NOT a colour value, so it must never be persisted (`categories.color`
 * stores a real hex, and `CategoriesSection` keeps its own literal ramp for exactly that reason)
 * and must never be handed to Tailwind's config, where `parseColor()` returns null on a bare var()
 * and silently deletes the utility.
 *
 * Order is the colour-vision-deficiency mechanism, not decoration: the slots were searched under the
 * dataviz six checks against both grounds, and re-ordering them invalidates that. The grounds are
 * not named here on purpose. This sentence used to give them as "paper #e5dbca light, #262119
 * dark", which were the PREVIOUS palette's; the light ground is now white and the dark ground is
 * black. The identical sentence in `index.css` was corrected when the palette landed and this copy
 * was not, which is the whole argument for not writing the values down twice.
 * `tests/seriesPalette.test.ts` derives both grounds live from the tokens, which is why it kept
 * passing while this comment rotted. Assign in sequence and never cycle -- past eight groups, fold the tail into a
 * single "Other" slice rather than reusing a colour. `tests/seriesPalette.test.ts` re-runs the
 * measurements against the tokens as declared in index.css.
 */
export const CHART_COLORS = [
  'var(--mz-series-1)',
  'var(--mz-series-2)',
  'var(--mz-series-3)',
  'var(--mz-series-4)',
  'var(--mz-series-5)',
  'var(--mz-series-6)',
  'var(--mz-series-7)',
  'var(--mz-series-8)',
];

/**
 * What a slot past the eighth gets.
 *
 * Not a ninth identity: a neutral, so an unfolded consumer renders something visibly outside the
 * ramp instead of a second slice wearing slot 1's colour. Everything that reaches a screen folds
 * to eight first, so this should not appear.
 */
export const SERIES_OVERFLOW_COLOR = 'var(--mz-faint)';

export function seriesColor(index: number): string {
  return CHART_COLORS[index] ?? SERIES_OVERFLOW_COLOR;
}
