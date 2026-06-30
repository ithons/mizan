/** @type {import('tailwindcss').Config} */
export default {
  content: ['./client/index.html', './client/src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        background: '#f6fafc',
        surface: '#ffffff',
        border: '#dbe7e2',
        text: '#273238',
        muted: '#718087',
        green: {
          DEFAULT: '#32bfa3',
          50: 'rgba(50,191,163,0.05)',
          10: 'rgba(50,191,163,0.1)',
        },
        rose: {
          DEFAULT: '#ef6f8a',
          50: 'rgba(239,111,138,0.05)',
          10: 'rgba(239,111,138,0.1)',
        },
        amber: {
          DEFAULT: '#e2a53f',
        },
        blue: {
          DEFAULT: '#6487f0',
        },
      },
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'monospace'],
      },
      borderRadius: {
        DEFAULT: '8px',
      },
    },
  },
  plugins: [],
};
