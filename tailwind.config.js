/** @type {import('tailwindcss').Config} */
const defaultTheme = require('tailwindcss/defaultTheme');

export default {
  content: ['./client/index.html', './client/src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // Balance palette (see client/src/index.css for hex values)
        paper: 'var(--mz-paper)',
        rail: 'var(--mz-rail)',
        card: {
          DEFAULT: 'var(--mz-card)',
          alt: 'var(--mz-card-alt)',
          white: 'var(--mz-card-white)',
        },
        ink: {
          DEFAULT: 'var(--mz-ink)',
          soft: 'var(--mz-ink-soft)',
        },
        muted: {
          DEFAULT: 'var(--mz-muted)',
          2: 'var(--mz-muted-2)',
        },
        faint: 'var(--mz-faint)',
        line: {
          DEFAULT: 'var(--mz-line)',
          2: 'var(--mz-line-2)',
          3: 'var(--mz-line-3)',
        },
        dot: 'var(--mz-dot)',
        sage: {
          DEFAULT: 'var(--mz-sage)',
          deep: 'var(--mz-sage-deep)',
          soft: 'var(--mz-sage-soft)',
          tint: 'var(--mz-sage-tint)',
          'tint-border': 'var(--mz-sage-tint-border)',
          panel: 'var(--mz-sage-panel)',
          'panel-border': 'var(--mz-sage-panel-border)',
          text: 'var(--mz-pill-text)',
        },
        clay: {
          DEFAULT: 'var(--mz-clay)',
          scale: 'var(--mz-clay-scale)',
        },
        gold: 'var(--mz-gold)',
        tan: 'var(--mz-tan)',
        beam: 'var(--mz-beam)',
        pill: {
          bg: 'var(--mz-pill-muted-bg)',
          border: 'var(--mz-pill-muted-border)',
        },
        review: {
          bg: 'var(--mz-review-bg)',
          border: 'var(--mz-review-border)',
          text: 'var(--mz-review-text)',
          active: 'var(--mz-review-active)',
        },

        // Legacy aliases for not-yet-converted components
        background: 'var(--color-bg)',
        surface: 'var(--color-surface)',
        border: 'var(--color-border)',
        text: 'var(--color-text)',
        positive: {
          DEFAULT: 'var(--color-positive)',
          5: 'var(--color-positive-5)',
          10: 'var(--color-positive-10)',
        },
        negative: {
          DEFAULT: 'var(--color-negative)',
          5: 'var(--color-negative-5)',
          10: 'var(--color-negative-10)',
        },
        warning: {
          DEFAULT: 'var(--color-warning)',
          5: 'var(--color-warning-5)',
          10: 'var(--color-warning-10)',
        },
        info: {
          DEFAULT: 'var(--color-info)',
          5: 'var(--color-info-5)',
          10: 'var(--color-info-10)',
        },
      },
      fontFamily: {
        sans: ['Instrument Sans', ...defaultTheme.fontFamily.sans],
        serif: ['Newsreader', ...defaultTheme.fontFamily.serif],
        mono: ['JetBrains Mono', ...defaultTheme.fontFamily.mono],
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
