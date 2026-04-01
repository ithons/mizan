/** @type {import('tailwindcss').Config} */
export default {
  content: ['./client/index.html', './client/src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        background: '#0f0f11',
        surface: '#17171a',
        border: '#2a2a2f',
        text: '#e8e8ec',
        muted: '#6b6b7a',
        green: {
          DEFAULT: '#4ecba3',
          50: 'rgba(78,203,163,0.05)',
          10: 'rgba(78,203,163,0.1)',
        },
        rose: {
          DEFAULT: '#e07070',
          50: 'rgba(224,112,112,0.05)',
          10: 'rgba(224,112,112,0.1)',
        },
        amber: {
          DEFAULT: '#d4a44c',
        },
        blue: {
          DEFAULT: '#5b8dee',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      borderRadius: {
        DEFAULT: '8px',
      },
    },
  },
  plugins: [],
};
