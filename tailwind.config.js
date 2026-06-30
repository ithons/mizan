/** @type {import('tailwindcss').Config} */
const defaultTheme = require('tailwindcss/defaultTheme');

export default {
  content: ['./client/index.html', './client/src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        background: '#f7f9fa',
        surface: '#ffffff',
        border: '#e8ecef',
        text: '#11181c',
        muted: '#687076',
        green: {
          DEFAULT: '#12a594',
          50: 'rgba(18, 165, 148, 0.05)',
          10: 'rgba(18, 165, 148, 0.1)',
        },
        rose: {
          DEFAULT: '#e5484d',
          50: 'rgba(229, 72, 77, 0.05)',
          10: 'rgba(229, 72, 77, 0.1)',
        },
        amber: {
          DEFAULT: '#f7ce00',
        },
        blue: {
          DEFAULT: '#0090ff',
        },
      },
      fontFamily: {
        sans: ['Inter', ...defaultTheme.fontFamily.sans],
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
