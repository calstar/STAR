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
        // Sensor system color scheme
        gn2: '#27AE60',
        fuel: '#3498DB',
        lox: '#E74C3C',
        'gse-low': '#F39C12',
        'gse-mid': '#9B59B6',
        background: '#1A1A1A',
        card: '#2D2D2D',
        text: '#E0E0E0',
        'text-muted': '#A0A0A0',
      },
    },
  },
  plugins: [],
  darkMode: 'class',
}
export default config
