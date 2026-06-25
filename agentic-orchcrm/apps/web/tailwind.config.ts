import type { Config } from 'tailwindcss';

export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Dark "command center" palette.
        ink: '#070b14',
        panel: '#0e1422',
        panel2: '#131b2c',
        edge: '#1f2a40',
        accent: '#6d8bff',
        accent2: '#b07bff',
        good: '#3ad29f',
        warn: '#f6c453',
        bad: '#ff6b6b',
        muted: '#7d89a6',
      },
      boxShadow: {
        card: '0 1px 0 0 rgba(255,255,255,0.03) inset, 0 8px 24px -12px rgba(0,0,0,0.6)',
        glow: '0 0 0 1px rgba(109,139,255,0.25), 0 8px 30px -10px rgba(109,139,255,0.25)',
      },
      fontFamily: {
        sans: ['var(--font-inter)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        display: ['var(--font-sora)', 'var(--font-inter)', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      keyframes: {
        fadeUp: {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        drift: {
          '0%,100%': { transform: 'translate3d(0,0,0)' },
          '50%': { transform: 'translate3d(0,-12px,0)' },
        },
      },
      animation: {
        'fade-up': 'fadeUp 0.22s ease-out both',
      },
    },
  },
  plugins: [],
} satisfies Config;
