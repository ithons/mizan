/** @type {import('tailwindcss').Config} */
const defaultTheme = require('tailwindcss/defaultTheme');

export default {
  darkMode: 'class',
  content: ['./client/index.html', './client/src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        background: 'var(--color-bg)',
        surface: 'var(--color-surface)',
        border: 'var(--color-border)',
        text: 'var(--color-text)',
        muted: 'var(--color-muted)',
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
        sans: ['Switzer', ...defaultTheme.fontFamily.sans],
        mono: ['JetBrains Mono', ...defaultTheme.fontFamily.mono],
      },
      borderRadius: {
        DEFAULT: '8px',
        md: '8px',
        lg: '12px',
        xl: '16px',
      },
      boxShadow: {
        sm: '0 1px 2px 0 rgba(0, 0, 0, 0.05)',
        DEFAULT: '0 1px 3px 0 rgba(0, 0, 0, 0.1), 0 1px 2px -1px rgba(0, 0, 0, 0.1)',
        md: '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -2px rgba(0, 0, 0, 0.1)',
        lg: '0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -4px rgba(0, 0, 0, 0.1)',
      },
    },
  },
  plugins: [
    require('@tailwindcss/forms'),
    require('@tailwindcss/typography'),
  ],
};
