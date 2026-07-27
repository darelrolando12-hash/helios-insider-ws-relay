/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      animation: {
        'ping-slow':       'ping 2s cubic-bezier(0, 0, 0.2, 1) infinite',
        'pulse-border':    'pulse-border 1.8s ease-in-out infinite',
      },
      keyframes: {
        'pulse-border': {
          '0%, 100%': { borderColor: 'rgba(251,191,36,0.4)', boxShadow: '0 0 0 0 rgba(251,191,36,0)' },
          '50%':       { borderColor: 'rgba(251,191,36,0.8)', boxShadow: '0 0 12px 2px rgba(251,191,36,0.15)' },
        },
      },
    },
  },
  plugins: [],
};
