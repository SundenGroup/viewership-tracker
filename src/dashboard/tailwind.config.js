/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // ── Clutch Brand Palette (Dark Variant) ──────────────────────
        // Neutral dark backgrounds — no blue tint, pure charcoal/black
        navy: {
          50: '#E8EAED',
          100: '#C8CCD2',
          200: '#A0A5AE',
          300: '#787F8A',
          400: '#565D68',
          500: '#3A4149',
          600: '#2A2F36',
          700: '#2A2F36',     // Clutch Grey (lighter) — borders, dividers
          800: '#1F2328',     // Clutch Grey — surface elements, inputs
          850: '#141820',     // Card backgrounds
          900: '#0A0F16',     // Header, sticky elements
          950: '#05090E',     // Clutch Black — page background
        },
        accent: {
          cyan: '#FF154D',    // Clutch Accent Red — primary accent (replaces old cyan)
          blue: '#3b82f6',    // Keep functional blue for info/focus states
          purple: '#a78bfa',
          green: '#34d399',
          orange: '#fb923c',
          red: '#f87171',     // Error/danger (kept distinct from brand red)
          pink: '#f472b6',
        },
        // Brand-specific tokens for direct reference
        clutch: {
          red: '#FF154D',
          blue: '#121B6C',
          black: '#05090E',
          grey: '#1F2328',
          white: '#EBEFF4',
        },
      },
      fontFamily: {
        sans: ['DM Sans', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      keyframes: {
        'slide-in-left': {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(0)' },
        },
      },
      animation: {
        'slide-in-left': 'slide-in-left 0.2s ease-out',
      },
    },
  },
  plugins: [],
};
