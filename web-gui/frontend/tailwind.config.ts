import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        // Sensor system palette
        gn2: '#27AE60',
        fuel: '#3498DB',
        lox: '#E74C3C',
        'gse-low': '#F39C12',
        'gse-mid': '#9B59B6',
        background: '#141414',
        card: '#1e1e1e',
        text: '#e2e2e2',
        'text-muted': '#888888',
      },
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
        mono: ['Menlo', 'Consolas', 'Monaco', 'monospace'],
      },
    },
  },
  plugins: [],
  darkMode: 'class',
}
export default config
