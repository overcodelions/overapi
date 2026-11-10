/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/renderer/**/*.{html,ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      // Channels in CSS variables (styles.css) so opacity modifiers like
      // bg-accent/15 compile. The palette is overcli's, so the family reads
      // as one — accent included: overcli's indigo.
      colors: {
        accent: {
          DEFAULT: 'rgb(var(--c-accent) / <alpha-value>)',
          strong: 'rgb(var(--c-accent-strong) / <alpha-value>)',
        },
        canvas: 'rgb(var(--c-canvas) / <alpha-value>)',
        surface: {
          DEFAULT: 'rgb(var(--c-surface) / <alpha-value>)',
          muted: 'rgb(var(--c-surface-muted) / <alpha-value>)',
          elevated: 'rgb(var(--c-surface-elevated) / <alpha-value>)',
        },
        ink: {
          DEFAULT: 'rgb(var(--c-ink) / <alpha-value>)',
          muted: 'rgb(var(--c-ink-muted) / <alpha-value>)',
          faint: 'rgb(var(--c-ink-faint) / <alpha-value>)',
        },
        rule: {
          DEFAULT: 'rgb(var(--c-rule) / <alpha-value>)',
          strong: 'rgb(var(--c-rule-strong) / <alpha-value>)',
        },
        wash: { DEFAULT: 'var(--c-wash)', strong: 'var(--c-wash-strong)' },
        good: 'rgb(var(--c-good) / <alpha-value>)',
        warn: 'rgb(var(--c-warn) / <alpha-value>)',
        bad: 'rgb(var(--c-bad) / <alpha-value>)',
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'SF Pro Text', 'system-ui', 'sans-serif'],
        mono: ['SF Mono', 'Menlo', 'Consolas', 'monospace'],
        // overcli's display face, for titles and the brand.
        display: ["'Bricolage Grotesque'", '-apple-system', 'BlinkMacSystemFont', 'system-ui', 'sans-serif'],
      },
    },
  },
};
