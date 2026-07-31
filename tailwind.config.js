/** @type {import('tailwindcss').Config} */
const defaultTheme = require('tailwindcss/defaultTheme');

/** Bind a Balance token to its RGB channels so opacity modifiers compile. */
const mz = (name) => `rgb(var(--mz-${name}-c) / <alpha-value>)`;
const legacy = (name) => `rgb(var(--color-${name}-c) / <alpha-value>)`;

export default {
  content: ['./client/index.html', './client/src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // Balance palette. Values MUST stay in `rgb(var(--mz-*-c) / <alpha-value>)` form. A bare
        // `var(--mz-*)` string makes Tailwind's parseColor() return null and silently drop every
        // `/alpha` utility built on that color. See the header comment in client/src/index.css.
        paper: mz('paper'),
        rail: mz('rail'),
        card: {
          DEFAULT: mz('card'),
          alt: mz('card-alt'),
          white: mz('card-white'),
        },
        ink: {
          DEFAULT: mz('ink'),
          soft: mz('ink-soft'),
        },
        muted: {
          DEFAULT: mz('muted'),
          2: mz('muted-2'),
        },
        faint: mz('faint'),
        // A reverse-replayed balance is not a measured one. That distinction used to survive only
        // as a dashed stroke inside TrendChart; it is a color now so an estimate can look like an
        // estimate anywhere a number is rendered.
        estimate: mz('estimate'),
        line: {
          DEFAULT: mz('line'),
          2: mz('line-2'),
          3: mz('line-3'),
        },
        track: mz('track'),
        well: mz('well'),
        dot: mz('dot'),
        sage: {
          DEFAULT: mz('sage'),
          deep: mz('sage-deep'),
          soft: mz('sage-soft'),
          tint: mz('sage-tint'),
          'tint-border': mz('sage-tint-border'),
          panel: mz('sage-panel'),
          'panel-border': mz('sage-panel-border'),
          text: mz('pill-text'),
        },
        clay: {
          DEFAULT: mz('clay'),
          scale: mz('clay-scale'),
        },
        gold: mz('gold'),
        tan: mz('tan'),
        beam: mz('beam'),
        pill: {
          bg: mz('pill-muted-bg'),
          border: mz('pill-muted-border'),
        },
        review: {
          bg: mz('review-bg'),
          border: mz('review-border'),
          text: mz('review-text'),
          active: mz('review-active'),
        },
        // There is deliberately no `cat-1..8` here. A category's colour is persisted user data, so
        // what renders is the stored hex read off the row, never a utility class; the eight-entry
        // ramp these mirrored emitted zero utilities in the built CSS while duplicating a list
        // that nothing kept in sync. It lives once, in CATEGORY_PRESET_COLORS in
        // client/src/views/settings/CategoriesSection.tsx. tests/categoryRamp.test.ts guards that.

        // Legacy aliases for not-yet-converted components. Same channel rule applies: these are
        // what `bg-negative/10` and `border-negative/30` in ConfirmRemoveModal resolve against.
        background: legacy('bg'),
        surface: legacy('surface'),
        border: legacy('border'),
        text: legacy('text'),
        positive: {
          DEFAULT: legacy('positive'),
          5: 'var(--color-positive-5)',
          10: 'var(--color-positive-10)',
        },
        negative: {
          DEFAULT: legacy('negative'),
          5: 'var(--color-negative-5)',
          10: 'var(--color-negative-10)',
        },
        warning: {
          DEFAULT: legacy('warning'),
          5: 'var(--color-warning-5)',
          10: 'var(--color-warning-10)',
        },
        info: {
          DEFAULT: legacy('info'),
          5: 'var(--color-info-5)',
          10: 'var(--color-info-10)',
        },
      },
      fontFamily: {
        sans: ['Instrument Sans', ...defaultTheme.fontFamily.sans],
        serif: ['Newsreader', ...defaultTheme.fontFamily.serif],
        mono: ['JetBrains Mono', ...defaultTheme.fontFamily.mono],
      },
      // Named steps with explicit leading. The app previously rendered 28 distinct sizes, 25 of
      // them arbitrary px literals (75x text-[13px], 52x text-[13.5px]) and four with two
      // spellings that disagreed on line-height: text-sm is 14/20 while text-[14px] inherits
      // preflight's 1.5, so the same size drifted 1px depending on how it was written.
      // Tracking is deliberately NOT baked in: several call sites already set their own
      // `tracking-[…]`, and a letter-spacing inside the step would collide with it unpredictably.
      fontSize: {
        rule: ['10.5px', { lineHeight: '14px' }],
        micro: ['11.5px', { lineHeight: '16px' }],
        note: ['12.5px', { lineHeight: '18px' }],
        body: ['13.5px', { lineHeight: '20px' }],
        'body-lg': ['15px', { lineHeight: '22px' }],
        sub: ['17px', { lineHeight: '24px' }],
        title: ['19px', { lineHeight: '26px' }],
        figure: ['22px', { lineHeight: '28px' }],
        display: ['28px', { lineHeight: '1.15' }],
        'display-lg': ['34px', { lineHeight: '1.1' }],
        hero: ['38px', { lineHeight: '1' }],
        'hero-lg': ['44px', { lineHeight: '1' }],
      },
      // Elevation is a var per theme, not a literal. The warm ink-soft shadow that reads as shade
      // over light paper is LIGHTER than the dark ground, so hardcoding it made every dialog and
      // card glow instead of lift once the dark theme existed. Values live in index.css.
      //
      // Each step is edge-then-shadow. A dark shadow on a dark ground is very close to invisible,
      // so on THAT theme the drop shadow alone cannot express a ladder at all and the lit top edge
      // is what a raised object gets that a flat one does not. On light the edge is a no-op by
      // construction (see `--mz-edge` in index.css) and the drop shadow is the whole mechanism.
      // Composed here rather than at the call sites so every `shadow-e*` usage inherits it
      // unchanged. The count of those call sites is deliberately not written down: it is a moving
      // number that no test reads, so a figure here could only ever go stale silently. What is
      // fixed is the shape, and tests/edgeToken.test.ts checks that instead.
      // `Card` supplies the other two thirds of the mechanism (surface value and border value),
      // which is what actually does the separating on the dark ground.
      //
      // There is deliberately no `e1-alt`. Five call sites used `shadow-e1-alt`, which was never
      // defined and emitted no CSS at all; they now say `shadow-e1`, which is what they looked
      // like they were asking for.
      boxShadow: {
        e1: 'var(--mz-edge), var(--mz-e1)',
        e2: 'var(--mz-edge), var(--mz-e2)',
        e3: 'var(--mz-edge), var(--mz-e3)',
      },
      borderRadius: {
        DEFAULT: '8px',
        md: '8px',
        lg: '12px',
        xl: '14px',
      },
    },
  },
  plugins: [
    require('@tailwindcss/forms'),
    require('@tailwindcss/typography'),
  ],
};
