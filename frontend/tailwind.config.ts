import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#0f172a',
        panel: '#111827',
        grid: '#243040',
        amberline: '#f59e0b'
      },
      fontFamily: {
        display: ['Space Grotesk', 'ui-sans-serif', 'system-ui'],
        body: ['Manrope', 'ui-sans-serif', 'system-ui']
      },
      boxShadow: {
        glow: '0 0 30px rgba(245, 158, 11, 0.12)'
      }
    }
  },
  plugins: []
} satisfies Config;
